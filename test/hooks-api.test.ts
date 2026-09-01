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

const TOKEN = 'api-token'

/**
 * The stack with the hooks layer instead of the global auth plugin, so the
 * secrets in play are the ones the hooks own.
 */
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
    for (const name of ['telegram', 'ntfy']) {
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
  const post = (hook: string, secret: string, payload: unknown) =>
    fetch(`${base}/hooks/${hook}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hooky-secret': secret },
      body: JSON.stringify(payload),
    })

  return { ctx, base, seen, api, post }
}

test('a hook is created over the API, and its secret is the one the ingest wants', async (t) => {
  const { api, post, seen } = await stack(t)

  const created = await api('POST', '/hooks', { name: 'urgent', targets: [{ channel: 'telegram' }] })
  assert.equal(created.status, 201)
  const secret = created.body['secret'] as unknown as string
  assert.ok(secret, 'the secret comes back once')
  assert.match(secret, /^hk_/)

  const accepted = await post('urgent', secret, { title: 'api is down', level: 'critical' })
  assert.equal(accepted.status, 200)

  const refused = await post('urgent', 'not-the-secret', { title: 'should not arrive' })
  assert.equal(refused.status, 401)

  const unknown = await post('nope', secret, { title: 'no such hook' })
  assert.equal(unknown.status, 404)

  assert.deepEqual(
    seen.get('telegram')!.map((message) => message.title),
    ['api is down'],
  )
})

test('the API never hands the secret back, only whether there is one', async (t) => {
  const { api } = await stack(t)
  await api('POST', '/hooks', { name: 'urgent' })

  const listed = await api('GET', '/hooks')
  const hook = (listed.body['hooks'] as unknown as Record<string, unknown>[])[0]!
  assert.equal(hook['hasSecret'], true)
  assert.equal(hook['secretHash'], undefined, 'not even the hash unless it is asked for')
  assert.equal(JSON.stringify(listed.body).includes('hk_'), false)

  const exported = await api('GET', '/hooks?include=hash')
  const backup = (exported.body['hooks'] as unknown as Record<string, unknown>[])[0]!
  assert.equal(typeof backup['secretHash'], 'string', 'a backup does carry the hash')
})

test('rotating invalidates the old secret over HTTP', async (t) => {
  const { api, post } = await stack(t)
  const created = await api('POST', '/hooks', { name: 'urgent' })
  const first = created.body['secret'] as unknown as string

  const rotated = await api('POST', '/hooks/urgent/rotate')
  const second = rotated.body['secret'] as unknown as string
  assert.notEqual(first, second)

  assert.equal((await post('urgent', first, { title: 'old' })).status, 401)
  assert.equal((await post('urgent', second, { title: 'new' })).status, 200)
})

test('a target is added and removed per channel', async (t) => {
  const { api, post, seen } = await stack(t)
  const created = await api('POST', '/hooks', { name: 'urgent' })
  const secret = created.body['secret'] as unknown as string

  await api('PUT', '/hooks/urgent/targets/telegram', {
    map: { title: 'fire: {{title}}', body: 'build {{payload.buildId}}' },
  })
  await api('PUT', '/hooks/urgent/targets/ntfy', { match: { minLevel: 'critical' } })

  await post('urgent', secret, { title: 'api is down', level: 'error', buildId: 991 })
  assert.deepEqual(
    seen.get('telegram')!.map((message) => [message.title, message.body]),
    [['fire: api is down', 'build 991']],
  )
  assert.deepEqual(seen.get('ntfy')!.map((message) => message.title), [], 'error is below critical')

  const dropped = await api('DELETE', '/hooks/urgent/targets/telegram')
  assert.equal(dropped.status, 200)
  await post('urgent', secret, { title: 'second', level: 'critical' })
  assert.equal(seen.get('telegram')!.length, 1, 'nothing new after the target is removed')
  assert.equal(seen.get('ntfy')!.length, 1, 'critical does reach ntfy')
})

test('preview answers per channel and sends nothing', async (t) => {
  const { api, seen } = await stack(t)
  await api('POST', '/hooks', {
    name: 'urgent',
    targets: [{ channel: 'telegram', map: { title: 'fire: {{title}}' } }, { channel: 'ntfy' }],
  })

  const preview = await api('POST', '/hooks/urgent/preview', { title: 'api is down', message: 'body text' })
  assert.equal(preview.status, 200)
  const targets = preview.body['targets'] as unknown as { channel: string; message?: { title: string } }[]
  assert.deepEqual(
    targets.map((target) => [target.channel, target.message?.title]),
    [
      ['telegram', 'fire: api is down'],
      ['ntfy', 'api is down'],
    ],
  )
  assert.equal(seen.get('telegram')!.length, 0)
})

test('a disabled hook answers 410, and enabling it takes effect at once', async (t) => {
  const { api, post } = await stack(t)
  const created = await api('POST', '/hooks', { name: 'urgent' })
  const secret = created.body['secret'] as unknown as string

  await api('PATCH', '/hooks/urgent', { disabled: true })
  assert.equal((await post('urgent', secret, { title: 'off' })).status, 410)

  await api('PATCH', '/hooks/urgent', { disabled: false })
  assert.equal((await post('urgent', secret, { title: 'on' })).status, 200)
})

test('removing a hook closes the endpoint', async (t) => {
  const { api, post } = await stack(t)
  const created = await api('POST', '/hooks', { name: 'urgent' })
  const secret = created.body['secret'] as unknown as string

  assert.equal((await api('DELETE', '/hooks/urgent')).status, 200)
  assert.equal((await post('urgent', secret, { title: 'gone' })).status, 404)
  assert.equal((await api('GET', '/hooks/urgent')).status, 404)
})

test('the API refuses a second hook with the same name and a broken target', async (t) => {
  const { api } = await stack(t)
  await api('POST', '/hooks', { name: 'urgent' })

  assert.equal((await api('POST', '/hooks', { name: 'urgent' })).status, 409)
  assert.equal((await api('PUT', '/hooks/nope/targets/telegram', {})).status, 404)

  const bad = await api('PATCH', '/hooks/urgent', { targets: [{ nochannel: true }] })
  assert.equal(bad.status, 400)
})

test('an export round-trips through import', async (t) => {
  const { api, post } = await stack(t)
  const created = await api('POST', '/hooks', {
    name: 'urgent',
    description: 'wakes me up',
    targets: [{ channel: 'telegram', map: { title: 'fire: {{title}}' } }],
  })
  const secret = created.body['secret'] as unknown as string
  const exported = await api('GET', '/hooks?include=hash')

  await api('PUT', '/hooks', { hooks: [] })
  assert.equal((await post('urgent', secret, { title: 'gone' })).status, 404)

  const restored = await api('PUT', '/hooks', { hooks: exported.body['hooks'] })
  assert.equal(restored.status, 200)
  assert.equal((await post('urgent', secret, { title: 'back' })).status, 200, 'the old secret still works')

  const back = await api('GET', '/hooks/urgent')
  assert.equal(back.body['description'], 'wakes me up')
})

test('a target naming a channel that is not registered is flagged', async (t) => {
  const { api } = await stack(t)
  await api('POST', '/hooks', { name: 'urgent', targets: [{ channel: 'telegram' }, { channel: 'signal' }] })

  const hook = await api('GET', '/hooks/urgent')
  const targets = hook.body['targets'] as unknown as { channel: string; missing: boolean }[]
  assert.deepEqual(
    targets.map((target) => [target.channel, target.missing]),
    [
      ['telegram', false],
      ['signal', true],
    ],
  )
})

test('the ingest refuses everything when nothing vouches for a request', async (t) => {
  // No routes plugin and no auth plugin: requireAuth has to close the door.
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(serverPlugin, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(hooksPlugin)
  await ctx.plugin(ingestPlugin)

  const response = await fetch(`http://127.0.0.1:${ctx.server.address.port}/hooks/anything`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'should not get in' }),
  })
  assert.equal(response.status, 401)
})

test('the hook endpoints answer 503 without the routes plugin', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(serverPlugin, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(hooksPlugin)
  await ctx.plugin(storePlugin, { path: ':memory:', retentionDays: 0 })
  await ctx.plugin(apiPlugin, { secret: TOKEN })

  const response = await fetch(`http://127.0.0.1:${ctx.server.address.port}/api/hooks`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(response.status, 503)
})

test('a target carries channel settings, and the delivery gets them', async (t) => {
  const { ctx, api, post } = await stack(t)
  const got: (Record<string, string> | undefined)[] = []
  await ctx.inject(['notify'], (child) => {
    child.notify.register({
      name: 'flow',
      settings: [{ key: 'url', label: 'webhook url', secret: true }],
      async send(_message, _signal, settings) {
        got.push(settings)
      },
    })
  })

  // The form the UI renders is built from this.
  const channels = await api('GET', '/channels')
  assert.deepEqual(channels.body['settings']!['flow'], [
    { key: 'url', label: 'webhook url', secret: true },
  ])

  const created = await api('POST', '/hooks', {
    name: 'to-flow',
    targets: [{ channel: 'flow', settings: { url: 'https://one.test/invoke?sig=a' } }],
  })
  assert.equal(created.status, 201)
  const secret = created.body['secret'] as unknown as string

  assert.equal((await post('to-flow', secret, { title: 'hello' })).status, 200)
  assert.deepEqual(got, [{ url: 'https://one.test/invoke?sig=a' }])

  // A second hook, the same channel, another destination. That is the point.
  const second = await api('POST', '/hooks', {
    name: 'to-other-flow',
    targets: [{ channel: 'flow', settings: { url: 'https://two.test/invoke?sig=b' } }],
  })
  await post('to-other-flow', second.body['secret'] as unknown as string, { title: 'hello' })
  assert.deepEqual(got[1], { url: 'https://two.test/invoke?sig=b' })

  // Reading it back, and clearing it again.
  const listed = await api('GET', '/hooks')
  const hook = (listed.body['hooks'] as unknown as { name: string; targets: unknown[] }[]).find(
    (row) => row.name === 'to-flow',
  )
  assert.deepEqual(hook!.targets, [
    { channel: 'flow', settings: { url: 'https://one.test/invoke?sig=a' }, missing: false },
  ])

  const cleared = await api('PUT', '/hooks/to-flow/targets/flow', { settings: { url: '  ' } })
  assert.deepEqual((cleared.body['targets'] as unknown as unknown[])[0], { channel: 'flow' })
})

test('a run tries a setting without storing it', async (t) => {
  const { ctx, api } = await stack(t)
  const got: (Record<string, string> | undefined)[] = []
  await ctx.inject(['notify'], (child) => {
    child.notify.register({
      name: 'flow',
      settings: [{ key: 'url', secret: true }],
      async send(_message, _signal, settings) {
        got.push(settings)
      },
    })
  })
  await api('POST', '/hooks', {
    name: 'to-flow',
    targets: [{ channel: 'flow', settings: { url: 'https://stored.test' } }],
  })

  const run = await api('POST', '/hooks/to-flow/targets/flow/run', {
    payload: { title: 'trying a url' },
    settings: { url: 'https://trying.test' },
  })
  assert.equal(run.status, 200)
  assert.deepEqual(got, [{ url: 'https://trying.test' }])

  // Nothing was stored, so the next real call goes where it always went.
  const listed = await api('GET', '/hooks/to-flow')
  assert.deepEqual((listed.body['targets'] as unknown as { settings: unknown }[])[0]!.settings, {
    url: 'https://stored.test',
  })
})
