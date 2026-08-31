import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import timer from '@deepseek-ai/cordis-plugin-timer'
import type { Message } from '../src/core/types.ts'
import * as hooksPlugin from '../src/plugins/hooks.ts'
import * as outboxPlugin from '../src/plugins/outbox.ts'
import * as storePlugin from '../src/plugins/store-sqlite.ts'
import { event } from './helpers.ts'

/**
 * Store plus outbox on an in-memory database. Disposal is registered with the
 * test runner, because a failing assert would otherwise leave the outbox
 * interval running and the process would never exit.
 */
async function durable(t: TestContext) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(timer)
  await ctx.plugin(hooksPlugin)
  await ctx.plugin(storePlugin, { path: ':memory:', retentionDays: 0 })
  return ctx
}

/** The outbox sweeps on its own; wait for the row to settle instead of sleeping blind. */
async function settled(ctx: Context, id: string, want: 'pending' | 'done', tries = 60) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const row = await ctx.store.get(id)
    if (row && row.state === want && row.deliveries.length > 0) return row
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`event ${id} never reached ${want}`)
}

test('submit levert meteen een id op en de outbox bezorgt daarna', async (t) => {
  const ctx = await durable(t)
  const seen: Message[] = []
  await ctx.inject(['notify'], (child) => {
    child.notify.register({
      name: 'stub',
      async send(message) {
        seen.push(message)
      },
    })
  })
  await ctx.plugin(outboxPlugin, { pollMs: 60_000 })

  const submitted = await ctx.hooks.submit(event({ title: 'komt goed' }))
  assert.equal(submitted.queued, true)

  const row = await settled(ctx, submitted.id, 'done')
  assert.equal(row.outcome, 'delivered')
  assert.equal(row.attempts, 1)
  assert.deepEqual(
    row.deliveries.map((delivery) => [delivery.channel, delivery.status]),
    [['stub', 'sent']],
  )
  assert.equal(seen.length, 1)
})

test('een falend kanaal houdt het event pending met een volgende poging', async (t) => {
  const ctx = await durable(t)
  await ctx.inject(['notify'], (child) => {
    child.notify.register({
      name: 'stuk',
      async send() {
        throw new Error('kanaal ligt plat')
      },
    })
  })
  await ctx.plugin(outboxPlugin, { pollMs: 60_000, attempts: 3, baseDelayMs: 30_000 })

  const submitted = await ctx.hooks.submit(event())
  const row = await settled(ctx, submitted.id, 'pending')

  assert.equal(row.outcome, null)
  assert.equal(row.attempts, 1)
  assert.ok(row.nextAttemptAt! > Date.now(), 'volgende poging moet in de toekomst staan')
  assert.equal(row.deliveries[0]!.status, 'failed')

  // Not due yet, so a sweep leaves it alone.
  assert.deepEqual(await ctx.store.due(Date.now(), 10), [])
  assert.equal((await ctx.store.due(row.nextAttemptAt!, 10)).length, 1)
})

test('een volgende poging slaat de kanalen over die al geleverd hebben', async (t) => {
  const ctx = await durable(t)
  let goodCalls = 0
  let badCalls = 0
  await ctx.inject(['notify'], (child) => {
    child.notify.register({
      name: 'goed',
      async send() {
        goodCalls++
      },
    })
    child.notify.register({
      name: 'stuk',
      async send() {
        badCalls++
        throw new Error('nog niet')
      },
    })
  })
  // Zero backoff, so all five passes run inside one sweep and the event settles.
  await ctx.plugin(outboxPlugin, { pollMs: 60_000, attempts: 5, baseDelayMs: 0, maxDelayMs: 0 })

  const submitted = await ctx.hooks.submit(event())
  const row = await settled(ctx, submitted.id, 'done')

  assert.equal(row.attempts, 5)
  assert.equal(row.outcome, 'partial', 'een kanaal nam het aan, het andere nooit')
  assert.equal(goodCalls, 1, 'het gelukte kanaal krijgt het maar een keer')
  assert.equal(badCalls, 5, 'het falende kanaal krijgt elke poging opnieuw')
  assert.deepEqual(await ctx.store.sentChannels(submitted.id), ['goed'])
  assert.deepEqual(
    row.deliveries.map((delivery) => [delivery.channel, delivery.status]),
    [
      ['goed', 'sent'],
      ['stuk', 'failed'],
    ],
  )
})

test('zonder outbox levert de kern binnen het request af', async (t) => {
  const ctx = await durable(t)
  await ctx.inject(['notify'], (child) => {
    child.notify.register({ name: 'stub', async send() {} })
  })

  const submitted = await ctx.hooks.submit(event())
  assert.equal(submitted.queued, false)
  assert.equal(submitted.queued === false && submitted.results[0]!.status, 'sent')
  // Nothing was stored, because recording is the outbox's job.
  assert.equal(await ctx.store.get(submitted.id), undefined)
})

test('de store filtert op hook, level en kanaal', async (t) => {
  const ctx = await durable(t)
  await ctx.store.append(event({ hook: 'deploy', level: 'info', title: 'een' }))
  const warned = event({ hook: 'alert', level: 'warning', title: 'twee' })
  await ctx.store.append(warned)
  await ctx.store.recordAttempt(warned.id, [{ channel: 'ntfy', status: 'sent', attempts: 1 }], {
    state: 'done',
    outcome: 'delivered',
    attempts: 1,
    nextAttemptAt: null,
  })

  assert.equal((await ctx.store.list({ limit: 10, offset: 0 })).total, 2)
  assert.equal((await ctx.store.list({ limit: 10, offset: 0, hook: 'deploy' })).total, 1)
  assert.equal((await ctx.store.list({ limit: 10, offset: 0, level: 'warning' })).total, 1)
  assert.equal((await ctx.store.list({ limit: 10, offset: 0, channel: 'ntfy' })).total, 1)
  assert.equal((await ctx.store.list({ limit: 10, offset: 0, search: 'twee' })).total, 1)
  assert.equal((await ctx.store.list({ limit: 10, offset: 0, state: 'pending' })).total, 1)

  const stats = await ctx.store.stats()
  assert.equal(stats.events, 2)
  assert.equal(stats.pending, 1)
  assert.deepEqual(stats.channels, { ntfy: { sent: 1 } })
})
