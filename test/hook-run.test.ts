import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import timer from '@deepseek-ai/cordis-plugin-timer'
import type { Message } from '../src/core/types.ts'
import * as apiPlugin from '../src/plugins/api.ts'
import * as hooksPlugin from '../src/plugins/hooks.ts'
import * as routesPlugin from '../src/plugins/hook-routes.ts'
import * as ingestPlugin from '../src/plugins/ingest-http.ts'
import * as outboxPlugin from '../src/plugins/outbox.ts'
import * as serverPlugin from '../src/plugins/server-node.ts'
import * as storePlugin from '../src/plugins/store-sqlite.ts'

const TOKEN = 'api-token'

/**
 * The stack with the outbox in it, so "a run stores nothing" is a claim about a
 * composition where a real call would have stored something.
 */
async function stack(t: TestContext) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(timer)
  await ctx.plugin(serverPlugin, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(hooksPlugin)
  await ctx.plugin(ingestPlugin)
  await ctx.plugin(storePlugin, { path: ':memory:', retentionDays: 0 })
  await ctx.plugin(outboxPlugin, { pollMs: 60_000 })

  const seen = new Map<string, Message[]>()
  await ctx.inject(['notify'], (child) => {
    for (const name of ['telegram', 'ntfy', 'console']) {
      seen.set(name, [])
      child.notify.register({
        name,
        async send(message) {
          seen.get(name)!.push(message)
        },
      })
    }
    child.notify.register({
      name: 'broken',
      async send() {
        throw new Error('telegram said 429')
      },
    })
  })

  await ctx.plugin(routesPlugin, { always: ['console'] })
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
  const run = (hook: string, channel: string, body: unknown) =>
    api('POST', `/hooks/${hook}/targets/${channel}/run`, body)

  return { ctx, seen, api, run }
}

/** The stack plus one hook: two mapped channels, so a run can be wrong. */
async function ready(t: TestContext) {
  const stacked = await stack(t)
  await stacked.api('POST', '/hooks', {
    name: 'deploy',
    targets: [
      { channel: 'telegram', map: { title: '{{title}} on {{hook}}', body: 'build {{payload.buildId}}' } },
      { channel: 'ntfy' },
    ],
  })
  return stacked
}

test('a run reaches one channel, with the mapping of that target', async (t) => {
  const { run, seen } = await ready(t)

  const answer = await run('deploy', 'telegram', {
    payload: { title: 'api is down', buildId: 991 },
  })
  assert.equal(answer.status, 200)
  assert.equal((answer.body['result'] as unknown as { status: string }).status, 'sent')
  assert.equal((answer.body['message'] as unknown as { title: string }).title, 'api is down on deploy')

  assert.equal(seen.get('telegram')!.length, 1)
  assert.equal(seen.get('telegram')![0]!.title, 'api is down on deploy')
  assert.equal(seen.get('telegram')![0]!.body, 'build 991')
  assert.equal(seen.get('ntfy')!.length, 0, 'the other target of the same hook stays quiet')
  assert.equal(seen.get('console')!.length, 0, 'and so does the always channel')
})

test('a run uses the mapping in the body and never writes it', async (t) => {
  const { api, run, seen } = await ready(t)

  const answer = await run('deploy', 'telegram', {
    payload: { title: 'api is down', buildId: 991 },
    map: { title: 'trying this out', level: 'critical' },
    match: {},
  })
  assert.equal((answer.body['message'] as unknown as { title: string }).title, 'trying this out')
  assert.equal(seen.get('telegram')![0]!.title, 'trying this out')
  assert.equal(seen.get('telegram')![0]!.level, 'critical')

  const stored = await api('GET', '/hooks/deploy')
  const targets = stored.body['targets'] as unknown as { channel: string; map: { title: string } }[]
  assert.equal(targets[0]!.map.title, '{{title}} on {{hook}}', 'the saved mapping is untouched')
})

test('a run is not an event: nothing is stored and nothing is queued', async (t) => {
  const { ctx, api, run } = await ready(t)

  await run('deploy', 'telegram', { payload: { title: 'api is down' } })

  const listed = await api('GET', '/events')
  assert.equal(listed.body['total'], 0, 'the Calls list never sees a run')
  assert.deepEqual(await ctx.store.due(Date.now(), 10), [], 'and the outbox owes nothing for it')
})

test('the target matcher still decides, so a run says why it stayed put', async (t) => {
  const { api, run, seen } = await ready(t)
  await api('PUT', '/hooks/deploy/targets/telegram', { match: { minLevel: 'error' } })

  const answer = await run('deploy', 'telegram', { payload: { title: 'a note', level: 'info' } })
  assert.equal(answer.status, 200)
  assert.match(answer.body['skipped'] as unknown as string, /matcher does not accept/)
  assert.equal(answer.body['result'], undefined, 'nothing was attempted')
  assert.equal(seen.get('telegram')!.length, 0)

  // The same run with the filter cleared in the body goes out after all.
  const again = await run('deploy', 'telegram', {
    payload: { title: 'a note', level: 'info' },
    match: {},
  })
  assert.equal((again.body['result'] as unknown as { status: string }).status, 'sent')
})

test('a failing channel comes back as failed, with what it said', async (t) => {
  const { api, run } = await stack(t)
  await api('POST', '/hooks', { name: 'deploy', targets: [{ channel: 'broken' }] })

  const answer = await run('deploy', 'broken', { payload: { title: 'api is down' } })
  assert.equal(answer.status, 200)
  const result = answer.body['result'] as unknown as { status: string; error: string; attempts: number }
  assert.equal(result.status, 'failed')
  assert.equal(result.error, 'telegram said 429')
  assert.equal(result.attempts, 1, 'no retry plugin in this stack')
})

test('a target whose channel is gone is a skipped result, not an error', async (t) => {
  const { api, run } = await stack(t)
  await api('POST', '/hooks', { name: 'deploy', targets: [{ channel: 'nowhere' }] })

  const answer = await run('deploy', 'nowhere', { payload: { title: 'api is down' } })
  assert.equal(answer.status, 200)
  const result = answer.body['result'] as unknown as { status: string; reason: string }
  assert.equal(result.status, 'skipped')
  assert.match(result.reason, /no channel named 'nowhere' is registered/)
})

test('the always channel is runnable, anything else is a 404', async (t) => {
  const { run, seen } = await ready(t)

  const always = await run('deploy', 'console', { payload: { title: 'api is down' } })
  assert.equal(always.status, 200)
  assert.equal(seen.get('console')!.length, 1)

  const nope = await run('deploy', 'nothing-like-it', { payload: { title: 'api is down' } })
  assert.equal(nope.status, 404)
  assert.match(nope.body['error'] as unknown as string, /no target for channel 'nothing-like-it'/)

  const noHook = await run('other', 'telegram', { payload: {} })
  assert.equal(noHook.status, 404)
})

test('a run without a payload still goes out, on the hook name alone', async (t) => {
  const { api, run, seen } = await stack(t)
  await api('POST', '/hooks', { name: 'deploy', targets: [{ channel: 'telegram' }] })

  const answer = await run('deploy', 'telegram', {})
  assert.equal((answer.body['result'] as unknown as { status: string }).status, 'sent')
  assert.equal(seen.get('telegram')!.length, 1)
  assert.equal(seen.get('telegram')![0]!.title, 'deploy')
})
