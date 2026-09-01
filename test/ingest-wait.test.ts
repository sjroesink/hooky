import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import timer from '@deepseek-ai/cordis-plugin-timer'
import type { DeliveryResult, Message } from '../src/core/types.ts'
import * as hooksPlugin from '../src/plugins/hooks.ts'
import * as routesPlugin from '../src/plugins/hook-routes.ts'
import * as ingestPlugin from '../src/plugins/ingest-http.ts'
import * as outboxPlugin from '../src/plugins/outbox.ts'
import * as serverPlugin from '../src/plugins/server-node.ts'
import * as storePlugin from '../src/plugins/store-sqlite.ts'
import { event } from './helpers.ts'

/** What the ingest answers, as a caller reads it. */
interface Answer {
  id: string
  hook: string
  queued: boolean
  state: string
  outcome: string | null
  attempts: number
  nextAttemptAt: number | null
  results: DeliveryResult[]
  [extra: string]: unknown
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One hook, one channel that can be told to be slow or to fail, and the outbox
 * unless a test wants the pipeline without it.
 */
async function stack(t: TestContext, options: { waitMs?: number; outbox?: boolean } = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(timer)
  await ctx.plugin(serverPlugin, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(hooksPlugin)
  await ctx.plugin(ingestPlugin, options.waitMs === undefined ? {} : { waitMs: options.waitMs })
  await ctx.plugin(storePlugin, { path: ':memory:', retentionDays: 0 })
  // A poll that never comes round in a test: every pass here is the kickoff.
  if (options.outbox !== false) await ctx.plugin(outboxPlugin, { pollMs: 60_000 })

  const channel = { delayMs: 0, fail: false }
  const seen: Message[] = []
  await ctx.inject(['notify'], (child) => {
    child.notify.register({
      name: 'stub',
      async send(message) {
        if (channel.delayMs > 0) await sleep(channel.delayMs)
        if (channel.fail) throw new Error('the channel said 503')
        seen.push(message)
      },
    })
  })

  await ctx.plugin(routesPlugin, { always: [] })
  const created = await ctx.routes.create({ name: 'deploy', targets: [{ channel: 'stub' }] })
  const secret = created.secret!

  const base = `http://127.0.0.1:${ctx.server.address.port}`
  const post = async (payload: unknown, path = '', hook = 'deploy') => {
    const response = await fetch(`${base}/hooks/${hook}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hooky-secret': secret },
      body: JSON.stringify(payload),
    })
    return { status: response.status, body: (await response.json()) as Answer }
  }

  return { ctx, channel, seen, post }
}

/** Poll the store until the event settled, the way the outbox leaves it. */
async function settled(ctx: Context, id: string, tries = 80) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const row = await ctx.store.get(id)
    if (row && row.state !== 'pending') return row
    await sleep(25)
  }
  throw new Error('the event never settled')
}

test('a call waits for the queue and answers with the delivery', async (t) => {
  const { post, seen } = await stack(t)

  const answer = await post({ title: 'deployed 4471', level: 'warning' })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.queued, false, 'nothing is owed any more')
  assert.equal(answer.body.state, 'done')
  assert.equal(answer.body.outcome, 'delivered')
  assert.equal(answer.body.attempts, 1)
  assert.equal(answer.body.nextAttemptAt, null)
  assert.equal(answer.body.hook, 'deploy')
  assert.deepEqual(answer.body.results, [{ channel: 'stub', status: 'sent', attempts: 1 }])

  // The channel really had it before the caller heard about it.
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.event.id, answer.body.id)
})

test('a channel slower than the wait answers 202, and the event still lands', async (t) => {
  const { ctx, post, channel, seen } = await stack(t, { waitMs: 120 })
  channel.delayMs = 500

  const answer = await post({ title: 'slow one' })
  assert.equal(answer.status, 202)
  assert.equal(answer.body.queued, true)
  assert.equal(answer.body.state, 'pending')
  assert.equal(answer.body.outcome, null)
  assert.equal(answer.body.attempts, 0, 'the queue had not finished a pass yet')
  assert.deepEqual(answer.body.results, [])

  // Nothing was lost by not waiting for it: the outbox owns the event.
  const row = await settled(ctx, answer.body.id)
  assert.equal(row.outcome, 'delivered')
  assert.equal(seen.length, 1)
})

test('the async route does not wait at all', async (t) => {
  const { ctx, post, channel, seen } = await stack(t, { waitMs: 10_000 })
  channel.delayMs = 400

  const started = Date.now()
  const answer = await post({ title: 'fire and forget' }, '/async')
  const elapsed = Date.now() - started

  assert.equal(answer.status, 202)
  assert.equal(answer.body.queued, true)
  assert.deepEqual(answer.body.results, [])
  assert.equal(seen.length, 0, 'the channel has not even been called yet')
  assert.ok(elapsed < 300, `answered in ${elapsed}ms, without waiting for the channel`)

  const row = await settled(ctx, answer.body.id)
  assert.equal(row.outcome, 'delivered')
})

test('a failing channel answers 202 with the next attempt in it', async (t) => {
  const { post, channel } = await stack(t)
  channel.fail = true

  const answer = await post({ title: 'nobody takes this' })
  assert.equal(answer.status, 202, 'a retry is still to come, so this is not settled')
  assert.equal(answer.body.queued, true)
  assert.equal(answer.body.state, 'pending')
  assert.equal(answer.body.outcome, null, 'not settled, so no outcome yet')
  assert.equal(answer.body.attempts, 1)
  assert.ok(answer.body.nextAttemptAt! > Date.now(), 'and it says when it will try again')
  assert.equal(answer.body.results[0]?.status, 'failed')
  assert.equal(
    answer.body.results[0]?.status === 'failed' && answer.body.results[0].error,
    'the channel said 503',
  )
})

test('without the outbox the answer is the delivery itself', async (t) => {
  const { post, seen } = await stack(t, { outbox: false })

  const answer = await post({ title: 'straight through' })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.queued, false)
  assert.equal(answer.body.state, 'done')
  assert.equal(answer.body.outcome, 'delivered')
  assert.equal(answer.body.attempts, 1)
  assert.equal(answer.body.results[0]?.status, 'sent')
  assert.equal(seen.length, 1)
})

test('waitMs 0 answers the moment the event is stored', async (t) => {
  const { ctx, post } = await stack(t, { waitMs: 0 })

  const answer = await post({ title: 'no waiting here' })
  assert.equal(answer.status, 202)
  assert.equal(answer.body.queued, true)
  assert.equal(answer.body.state, 'pending')
  assert.deepEqual(answer.body.results, [])

  await settled(ctx, answer.body.id)
})

test('a hook/answer listener has the last word', async (t) => {
  const { ctx, post } = await stack(t)
  ctx.on('hook/answer', async (answer, event, next) => {
    const base = await next()
    return { status: 201, body: { ...base.body, ticket: `T-${event.hook}` } }
  })

  const answer = await post({ title: 'with a ticket' })
  assert.equal(answer.status, 201, 'the listener picked the status')
  assert.equal(answer.body['ticket'], 'T-deploy')
  assert.equal(answer.body.outcome, 'delivered', 'and what the ingest wrote is still there')
})

test('a refused call never reaches hook/answer', async (t) => {
  const { ctx, post } = await stack(t)
  let asked = 0
  ctx.on('hook/answer', async (answer, event, next) => {
    asked += 1
    return next()
  })

  const answer = await post({ title: 'nobody defined this' }, '', 'ghost')
  assert.equal(answer.status, 404)
  assert.equal(asked, 0, 'the answer seam is for accepted calls')

  // And the call is still kept, so a hook can be defined from it.
  const kept = await ctx.store.list({ state: 'rejected', limit: 10, offset: 0 })
  assert.equal(kept.total, 1)
})

test('unloading while a caller waits answers instead of hanging', async () => {
  const ctx = new Context()
  const fiber = await ctx.plugin(hooksPlugin)
  // A queue that takes the event and never comes back with a pass.
  ctx.on('hook/submit', async (taken) => ({ id: taken.id, queued: true }))

  const started = Date.now()
  const pending = ctx.hooks.submit(event(), { waitMs: 5_000 })
  await fiber.dispose()

  const answer = await pending
  assert.equal(answer.queued, true)
  assert.ok(Date.now() - started < 1_000, 'it did not sit out the whole wait')
  await ctx.fiber.dispose()
})
