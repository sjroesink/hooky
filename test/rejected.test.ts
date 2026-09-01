import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import timer from '@deepseek-ai/cordis-plugin-timer'
import type { Message } from '../src/core/types.ts'
import * as apiPlugin from '../src/plugins/api.ts'
import * as hooksPlugin from '../src/plugins/hooks.ts'
import * as routesPlugin from '../src/plugins/hook-routes.ts'
import * as ingestPlugin from '../src/plugins/ingest-http.ts'
import * as serverPlugin from '../src/plugins/server-node.ts'
import * as storePlugin from '../src/plugins/store-sqlite.ts'
import { event } from './helpers.ts'

const TOKEN = 'api-token'

/** The full stack, so a rejection travels the same road a real call does. */
async function stack(t: TestContext, config: Partial<routesPlugin.Config> = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(timer)
  await ctx.plugin(serverPlugin, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(hooksPlugin)
  await ctx.plugin(ingestPlugin)
  await ctx.plugin(storePlugin, { path: ':memory:', retentionDays: 0 })

  const seen = new Map<string, Message[]>()
  await ctx.inject(['notify'], (child) => {
    for (const name of ['telegram']) {
      seen.set(name, [])
      child.notify.register({
        name,
        async send(message) {
          seen.get(name)!.push(message)
        },
      })
    }
  })

  await ctx.plugin(routesPlugin, config)
  await ctx.plugin(apiPlugin, { secret: TOKEN })

  const base = `http://127.0.0.1:${ctx.server.address.port}`
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: (await response.json()) as Record<string, never> }
  }
  const post = (hook: string, payload: unknown, secret = '') =>
    fetch(`${base}/hooks/${hook}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hooky-secret': secret },
      body: JSON.stringify(payload),
    })

  return { ctx, base, seen, api, post }
}

test('a call for a hook nobody defined is kept, payload included', async (t) => {
  const { api, post } = await stack(t)

  const answer = await post('deploy', { title: 'deployed 4471', level: 'warning', buildId: 4471 })
  assert.equal(answer.status, 404, 'the caller still hears 404')

  const listed = await api('GET', '/events?state=rejected')
  assert.equal(listed.body['total'], 1)
  const row = (listed.body['events'] as unknown as Record<string, never>[])[0]!
  assert.equal(row['hook'], 'deploy')
  assert.equal(row['state'], 'rejected')
  assert.equal(row['title'], 'deployed 4471')
  assert.equal(row['level'], 'warning')
  assert.deepEqual(row['deliveries'], [])
  assert.equal((row['rejection'] as unknown as { status: number }).status, 404)

  // The payload is the point: it is what a definition gets built from.
  const one = await api('GET', `/events/${row['id']}`)
  assert.deepEqual(one.body['payload'], { title: 'deployed 4471', level: 'warning', buildId: 4471 })

  const stats = await api('GET', '/stats')
  assert.equal(stats.body['rejected'], 1)
})

test('a call for a hook that is switched off is kept as 410', async (t) => {
  const { api, post } = await stack(t)
  const created = await api('POST', '/hooks', { name: 'notice', disabled: true })
  const secret = created.body['secret'] as unknown as string

  const answer = await post('notice', { title: 'while it was off' }, secret)
  assert.equal(answer.status, 410)

  const listed = await api('GET', '/events?state=rejected')
  const row = (listed.body['events'] as unknown as Record<string, never>[])[0]!
  assert.equal((row['rejection'] as unknown as { status: number }).status, 410)
  assert.match((row['rejection'] as unknown as { reason: string }).reason, /disabled/)
})

test('a wrong secret is refused without keeping the body', async (t) => {
  const { api, post } = await stack(t)
  await api('POST', '/hooks', { name: 'urgent' })

  const answer = await post('urgent', { title: 'not mine' }, 'hk_wrong')
  assert.equal(answer.status, 401)

  const listed = await api('GET', '/events?state=rejected')
  assert.equal(listed.body['total'], 0, 'the one body an attacker controls for free is not stored')
})

test('remember: false answers the same and stores nothing', async (t) => {
  const { api, post } = await stack(t, { remember: false })

  assert.equal((await post('deploy', { title: 'gone' })).status, 404)
  assert.equal((await api('GET', '/events?state=rejected')).body['total'], 0)
})

test('a rejected call replays once the hook exists, and not before', async (t) => {
  const { api, post, seen } = await stack(t)

  await post('deploy', { title: 'deployed 4471', buildId: 4471 })
  const listed = await api('GET', '/events?state=rejected')
  const id = (listed.body['events'] as unknown as Record<string, never>[])[0]!['id']

  const early = await api('POST', `/events/${id}/replay`)
  assert.equal(early.status, 409, 'nowhere to go yet')
  assert.match(early.body['error'] as unknown as string, /no hook named 'deploy'/)

  await api('POST', '/hooks', { name: 'deploy', targets: [{ channel: 'telegram' }] })
  const replayed = await api('POST', `/events/${id}/replay`)
  assert.equal(replayed.status, 202)
  assert.equal(seen.get('telegram')!.length, 1)
  assert.equal(seen.get('telegram')![0]!.title, 'deployed 4471')
  assert.equal(seen.get('telegram')![0]!.event.replayOf, id)
})

test('a rejected call is never queued for delivery', async (t) => {
  const { ctx, api, post } = await stack(t)
  await post('deploy', { title: 'nowhere' })

  const stats = await api('GET', '/stats')
  assert.equal(stats.body['pending'], 0, 'the outbox owes nothing for it')
  assert.deepEqual(await ctx.store.due(Date.now(), 10), [], 'and a due sweep never sees it')
})

test('the kept calls are capped, newest first', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(storePlugin, { path: ':memory:', retentionDays: 0, keepRejected: 2 })

  for (const [index, title] of ['first', 'second', 'third'].entries()) {
    await ctx.store.reject(event({ hook: 'deploy', title, receivedAt: 1000 + index }), {
      status: 404,
      reason: 'no hook named',
    })
  }

  const kept = await ctx.store.list({ state: 'rejected', limit: 10, offset: 0 })
  assert.equal(kept.total, 2)
  assert.deepEqual(
    kept.rows.map((row) => row.event.title),
    ['third', 'second'],
  )
})

test('keepRejected 0 turns the whole thing off', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(storePlugin, { path: ':memory:', retentionDays: 0, keepRejected: 0 })

  await ctx.store.reject(event({ hook: 'deploy' }), { status: 404, reason: 'no hook named' })
  assert.equal((await ctx.store.list({ limit: 10, offset: 0 })).total, 0)
})
