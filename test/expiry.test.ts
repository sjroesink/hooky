import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import timer from '@deepseek-ai/cordis-plugin-timer'
import { hasExpired, parseExpiry } from '../src/core/routes.ts'
import type { Message } from '../src/core/types.ts'
import * as apiPlugin from '../src/plugins/api.ts'
import * as hooksPlugin from '../src/plugins/hooks.ts'
import * as routesPlugin from '../src/plugins/hook-routes.ts'
import * as ingestPlugin from '../src/plugins/ingest-http.ts'
import * as serverPlugin from '../src/plugins/server-node.ts'
import * as storePlugin from '../src/plugins/store-sqlite.ts'

const TOKEN = 'api-token'
const HOUR = 3_600_000

/** The hooks layer with the API on top, the same stack as `hooks-api.test.ts`. */
async function stack(t: TestContext) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(timer)
  await ctx.plugin(serverPlugin, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(hooksPlugin)
  await ctx.plugin(ingestPlugin)
  await ctx.plugin(storePlugin, { path: ':memory:', retentionDays: 0 })

  const seen: Message[] = []
  await ctx.inject(['notify'], (child) => {
    child.notify.register({
      name: 'telegram',
      async send(message) {
        seen.push(message)
      },
    })
  })

  await ctx.plugin(routesPlugin, {})
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
  const post = async (hook: string, secret: string, payload: unknown) => {
    const response = await fetch(`${base}/hooks/${hook}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hooky-secret': secret },
      body: JSON.stringify(payload),
    })
    return { status: response.status, body: (await response.json()) as Record<string, unknown> }
  }
  /** A hook with a secret, and the secret, in one line. */
  const define = async (name: string, body: Record<string, unknown> = {}) => {
    const created = await api('POST', '/hooks', { name, targets: [{ channel: 'telegram' }], ...body })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    return created.body['secret'] as unknown as string
  }

  return { ctx, api, post, define, seen }
}

test('a duration, an epoch and a date all become a moment', () => {
  const now = 1_800_000_000_000
  assert.equal(parseExpiry('2h', now), now + 2 * HOUR)
  assert.equal(parseExpiry('30m', now), now + 1_800_000)
  assert.equal(parseExpiry('7d', now), now + 7 * 86_400_000)
  assert.equal(parseExpiry('1w', now), now + 604_800_000)
  assert.equal(parseExpiry('90s', now), now + 90_000)
  assert.equal(parseExpiry(' 2H ', now), now + 2 * HOUR, 'trimmed and case insensitive')
  assert.equal(parseExpiry(String(now), now), now, 'an epoch as a string is that epoch')
  assert.equal(parseExpiry(now + 5, now), now + 5)
  assert.equal(parseExpiry('2026-09-03T10:00:00Z', now), Date.parse('2026-09-03T10:00:00Z'))

  // Every form of "no expiry", so taking one off is not a special case.
  for (const nothing of [undefined, null, false, '']) assert.equal(parseExpiry(nothing, now), undefined)

  for (const bad of ['soon', '2 fortnights', '-1h', 0, -5, Number.NaN, {}]) {
    assert.throws(() => parseExpiry(bad, now), /not a moment|not a duration|an expiry is/)
  }
})

test('hasExpired is about the moment, not about the hook being switched off', () => {
  const hook = { name: 'x', disabled: false, secretHash: null, targets: [], createdAt: 0, updatedAt: 0 }
  assert.equal(hasExpired(hook), false, 'no expiry, never expired')
  assert.equal(hasExpired({ ...hook, expiresAt: 2000 }, 1000), false)
  assert.equal(hasExpired({ ...hook, expiresAt: 1000 }, 1000), true, 'the moment itself is over')
  assert.equal(hasExpired({ ...hook, expiresAt: 1000 }, 2000), true)
})

test('a temporary hook accepts calls until its moment, then answers 410', async (t) => {
  const { api, post, seen, define } = await stack(t)
  const secret = await define('asktest', { expiresIn: '2h' })

  const before = await post('asktest', secret, { title: 'still in time' })
  assert.equal(before.status, 200)
  assert.equal(seen.length, 1)

  // Moved into the past rather than waited out: the check is a comparison, so
  // there is nothing a sleep would prove that this does not.
  await api('PATCH', '/hooks/asktest', { expiresAt: Date.now() - 1000 })

  const after = await post('asktest', secret, { title: 'too late' })
  assert.equal(after.status, 410)
  assert.match(after.body['error'] as string, /hook 'asktest' expired on/)
  assert.equal(seen.length, 1, 'nothing was delivered after the moment')
})

test('a call to an expired hook is kept, so you can see who is still knocking', async (t) => {
  const { api, post, define } = await stack(t)
  const secret = await define('asktest', { expiresAt: Date.now() - 1000 })

  await post('asktest', secret, { title: 'anybody home', buildId: 4471 })

  const listed = await api('GET', '/events?state=rejected')
  const rows = listed.body['events'] as unknown as Record<string, never>[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!['hook'], 'asktest')
  const rejection = rows[0]!['rejection'] as unknown as { status: number; reason: string }
  assert.equal(rejection.status, 410)
  assert.match(rejection.reason, /expired on/)
})

test('a wrong secret on an expired hook is still an expired hook', async (t) => {
  const { post, define } = await stack(t)
  await define('asktest', { expiresAt: Date.now() - 1000 })

  // Not a 401: once the moment has passed, what the caller sent stops mattering.
  const refused = await post('asktest', 'not-the-secret', { title: 'nope' })
  assert.equal(refused.status, 410)
})

test('an expiry can be moved, and taken off again', async (t) => {
  const { api, post, define } = await stack(t)
  const secret = await define('asktest', { expiresAt: Date.now() - 1000 })
  assert.equal((await post('asktest', secret, { title: 'gone' })).status, 410)

  const extended = await api('PATCH', '/hooks/asktest', { expiresIn: '2h' })
  assert.equal(extended.status, 200)
  assert.equal(typeof extended.body['expiresAt'], 'number')
  assert.equal((await post('asktest', secret, { title: 'back' })).status, 200)

  const forever = await api('PATCH', '/hooks/asktest', { expiresIn: null })
  assert.equal(forever.body['expiresAt'], null, 'null takes the expiry off')
  assert.equal((await post('asktest', secret, { title: 'and stays' })).status, 200)

  // A patch that says nothing about the expiry leaves it where it is.
  await api('PATCH', '/hooks/asktest', { expiresIn: '2h' })
  const touched = await api('PATCH', '/hooks/asktest', { description: 'unrelated' })
  assert.equal(typeof touched.body['expiresAt'], 'number')
})

test('a duration nobody can read is a 400, not a hook that dies in 1970', async (t) => {
  const { api } = await stack(t)
  const bad = await api('POST', '/hooks', { name: 'asktest', expiresIn: 'whenever' })
  assert.equal(bad.status, 400)
  assert.match(bad.body['error'] as unknown as string, /not a duration/)

  await api('POST', '/hooks', { name: 'asktest' })
  const worse = await api('PATCH', '/hooks/asktest', { expiresIn: '2 fortnights' })
  assert.equal(worse.status, 400)
  const listed = await api('GET', '/hooks/asktest')
  assert.equal(listed.body['expiresAt'], null, 'and nothing was written')
})

test('an event that skips the ingest is not delivered either', async (t) => {
  const { api, seen, define } = await stack(t)
  await define('asktest', { expiresAt: Date.now() - 1000 })

  // /api/send does not pass hook/receive, so this is the routing side of the
  // same rule: an expired hook has no targets.
  const sent = await api('POST', '/send', { hook: 'asktest', title: 'through the back door' })
  assert.equal(sent.status, 202)
  assert.equal(seen.length, 0)
})

test('a replay into an expired hook is refused instead of queued', async (t) => {
  const { api, post, define } = await stack(t)
  const secret = await define('asktest', { expiresAt: Date.now() - 1000 })
  await post('asktest', secret, { title: 'rejected once' })

  const listed = await api('GET', '/events?state=rejected')
  const id = (listed.body['events'] as unknown as Record<string, never>[])[0]!['id'] as unknown as string

  const replay = await api('POST', `/events/${id}/replay`)
  assert.equal(replay.status, 409)
  assert.match(replay.body['error'] as unknown as string, /expired, so this call would be rejected again/)
})

test('prune removes what expired and leaves the rest alone', async (t) => {
  const { api, define } = await stack(t)
  await define('dead-1', { expiresAt: Date.now() - 1000 })
  await define('dead-2', { expiresAt: Date.now() - 5 * HOUR })
  await define('alive', { expiresIn: '2h' })
  await define('forever')

  const careless = await api('DELETE', '/hooks')
  assert.equal(careless.status, 400, 'no flag, no deleting')

  const pruned = await api('DELETE', '/hooks?expired=1')
  assert.equal(pruned.status, 200)
  assert.deepEqual(pruned.body['removed'], ['dead-1', 'dead-2'])

  const listed = await api('GET', '/hooks')
  const names = (listed.body['hooks'] as unknown as { name: string }[]).map((hook) => hook.name)
  assert.deepEqual(names, ['alive', 'forever'])
})

test('the expiry survives an export and an import', async (t) => {
  const { api, define } = await stack(t)
  const at = Date.now() + 2 * HOUR
  await define('asktest', { expiresAt: at })

  const exported = await api('GET', '/hooks?include=hash')
  const hooks = exported.body['hooks'] as unknown as Record<string, unknown>[]
  assert.equal(hooks[0]!['expiresAt'], at)

  await api('PUT', '/hooks', { hooks })
  const back = await api('GET', '/hooks/asktest')
  assert.equal(back.body['expiresAt'], at)
})

test('a database that saw an older hooks table is brought up to date', async (t) => {
  // A live instance that ran before the column existed: `CREATE TABLE IF NOT
  // EXISTS` leaves its table alone, so the column has to be added by hand.
  const dir = mkdtempSync(join(tmpdir(), 'hooky-hooks-'))
  const file = join(dir, 'old.db')

  const seed = new DatabaseSync(file)
  seed.exec(
    `CREATE TABLE hooks (
       name TEXT PRIMARY KEY, description TEXT, disabled INTEGER NOT NULL DEFAULT 0,
       secret_hash TEXT, targets TEXT NOT NULL,
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  )
  seed
    .prepare('INSERT INTO hooks (name, description, disabled, secret_hash, targets, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?)')
    .run('notice', 'from before the column', 'a-hash', '[{"channel":"telegram"}]', 1, 2)
  seed.close()

  const ctx = new Context()
  // Dispose first, remove second: on Windows the file cannot go while the
  // database handle is still open.
  t.after(() => ctx.fiber.dispose())
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await ctx.plugin(storePlugin, { path: file, retentionDays: 0 })

  const [existing] = await ctx.store.listHooks()
  assert.equal(existing?.name, 'notice')
  assert.equal(existing?.description, 'from before the column')
  assert.deepEqual(existing?.targets, [{ channel: 'telegram' }])
  assert.equal(existing?.expiresAt, undefined, 'a hook from before the column has no expiry')

  const at = Date.now() + HOUR
  await ctx.store.saveHook({ ...existing!, expiresAt: at })
  const [updated] = await ctx.store.listHooks()
  assert.equal(updated?.expiresAt, at)
})
