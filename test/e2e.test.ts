import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import timer from '@deepseek-ai/cordis-plugin-timer'
import type { Message } from '../src/core/types.ts'
import * as apiPlugin from '../src/plugins/api.ts'
import * as authPlugin from '../src/plugins/auth-secret.ts'
import * as healthzPlugin from '../src/plugins/healthz.ts'
import * as hooksPlugin from '../src/plugins/hooks.ts'
import * as ingestPlugin from '../src/plugins/ingest-http.ts'
import * as outboxPlugin from '../src/plugins/outbox.ts'
import * as serverPlugin from '../src/plugins/server-node.ts'
import * as storePlugin from '../src/plugins/store-sqlite.ts'

const SECRET = 'test-geheim'

/** The whole stack on a free port, minus the loader and the real channels. */
async function stack(t: TestContext, options: { api?: boolean } = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(timer)
  await ctx.plugin(serverPlugin, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(hooksPlugin)
  await ctx.plugin(healthzPlugin)
  await ctx.plugin(ingestPlugin)
  await ctx.plugin(authPlugin, { secret: SECRET })
  await ctx.plugin(storePlugin, { path: ':memory:', retentionDays: 0 })
  await ctx.plugin(outboxPlugin, { pollMs: 60_000 })
  if (options.api) await ctx.plugin(apiPlugin, { secret: SECRET })

  const seen: Message[] = []
  await ctx.inject(['notify'], (child) => {
    child.notify.register({
      name: 'stub',
      async send(message) {
        seen.push(message)
      },
    })
  })

  const base = `http://127.0.0.1:${ctx.server.address.port}`
  return { ctx, base, seen }
}

async function waitFor<T>(probe: () => Promise<T | undefined>, tries = 60): Promise<T> {
  for (let attempt = 0; attempt < tries; attempt++) {
    const value = await probe()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('condition never held')
}

test('een geldige webhook levert 202 en komt bij het kanaal aan', async (t) => {
  const { base, seen } = await stack(t)
  const response = await fetch(`${base}/hooks/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-notifier-secret': SECRET },
    body: JSON.stringify({ title: 'klaar', message: 'build 7', level: 'warning', tags: ['ota'] }),
  })
  assert.equal(response.status, 202)
  const body = (await response.json()) as { id: string; queued: boolean }
  assert.equal(body.queued, true)

  const message = await waitFor(async () => seen[0])
  assert.equal(message.title, 'klaar')
  assert.equal(message.body, 'build 7')
  assert.equal(message.level, 'warning')
  assert.deepEqual(message.tags, ['ota'])
  assert.equal(message.event.hook, 'deploy')
})

test('een fout of ontbrekend secret geeft 401 en levert niets af', async (t) => {
  const { base, seen } = await stack(t)
  const attempts: Record<string, string>[] = [{ 'x-notifier-secret': 'mis' }, {}]
  for (const headers of attempts) {
    const response = await fetch(`${base}/hooks/deploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ title: 'nope' }),
    })
    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'rejected' })
  }
  assert.equal(seen.length, 0)
})

test('stukke JSON geeft 400, een onbekende route 404', async (t) => {
  const { base } = await stack(t)
  const broken = await fetch(`${base}/hooks/deploy`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-notifier-secret': SECRET },
    body: '{oeps',
  })
  assert.equal(broken.status, 400)
  assert.match(((await broken.json()) as { error: string }).error, /invalid JSON/)

  assert.equal((await fetch(`${base}/bestaat-niet`)).status, 404)
  assert.equal((await fetch(`${base}/healthz`)).status, 200)
})

test('een te grote body geeft 413', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(serverPlugin, { host: '127.0.0.1', port: 0, maxBodyBytes: 16 })
  ctx.server.route('POST', '/echo', (request) => ({ status: 200, body: request.body }))
  const response = await fetch(`http://127.0.0.1:${ctx.server.address.port}/echo`, {
    method: 'POST',
    body: 'x'.repeat(64),
  })
  assert.equal(response.status, 413)
})

test('de api leest de historie terug en replayt een call', async (t) => {
  const { base, seen } = await stack(t, { api: true })
  const auth = { authorization: `Bearer ${SECRET}` }

  await fetch(`${base}/hooks/alert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-notifier-secret': SECRET },
    body: JSON.stringify({ title: 'origineel', level: 'error' }),
  })

  const listed = await waitFor(async () => {
    const data = (await (await fetch(`${base}/api/events`, { headers: auth })).json()) as {
      total: number
      events: { id: string; outcome: string | null; title: string }[]
    }
    return data.events[0]?.outcome === 'delivered' ? data : undefined
  })
  assert.equal(listed.total, 1)
  assert.equal(listed.events[0]!.title, 'origineel')

  const original = listed.events[0]!.id
  const replay = await fetch(`${base}/api/events/${original}/replay`, { method: 'POST', headers: auth })
  assert.equal(replay.status, 202)

  await waitFor(async () => (seen.length === 2 ? true : undefined))
  const after = (await (await fetch(`${base}/api/events?limit=5`, { headers: auth })).json()) as {
    total: number
    events: { replayOf: string | null }[]
  }
  assert.equal(after.total, 2)
  assert.equal(after.events[0]!.replayOf, original)

  // Filters and the catalog are part of the contract the CLI leans on.
  const filtered = (await (
    await fetch(`${base}/api/events?level=error&hook=alert&limit=1`, { headers: auth })
  ).json()) as { total: number }
  assert.equal(filtered.total, 2)

  const described = (await (await fetch(`${base}/api/describe`, { headers: auth })).json()) as {
    endpoints: unknown[]
  }
  assert.ok(described.endpoints.length > 5)
})

test('de api weigert zonder token', async (t) => {
  const { base } = await stack(t, { api: true })
  assert.equal((await fetch(`${base}/api/events`)).status, 401)
  assert.equal((await fetch(`${base}/api/stats`, { headers: { authorization: 'Bearer fout' } })).status, 401)
})
