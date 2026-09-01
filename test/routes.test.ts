import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import timer from '@deepseek-ai/cordis-plugin-timer'
import { hashSecret } from '../src/core/routes.ts'
import type { Message } from '../src/core/types.ts'
import * as hooksPlugin from '../src/plugins/hooks.ts'
import * as routesPlugin from '../src/plugins/hook-routes.ts'
import * as outboxPlugin from '../src/plugins/outbox.ts'
import * as storePlugin from '../src/plugins/store-sqlite.ts'
import { event } from './helpers.ts'

/**
 * Store plus routes on an in-memory database, with three recording channels so a
 * test can see which target delivered and what it received.
 */
async function routed(t: TestContext, config: Partial<routesPlugin.Config> = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(hooksPlugin)
  await ctx.plugin(storePlugin, { path: ':memory:', retentionDays: 0 })

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
  })

  await ctx.plugin(routesPlugin, config)
  return { ctx, seen }
}

/** The outbox sweeps on its own; wait for the row instead of sleeping blind. */
async function settled(ctx: Context, id: string, want: 'pending' | 'done', tries = 80) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const row = await ctx.store.get(id)
    if (row && row.state === want && row.deliveries.length > 0) return row
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`event ${id} never reached ${want}`)
}

/** What each channel received, as `channel: title` pairs, sorted. */
function delivered(seen: Map<string, Message[]>): string[] {
  return [...seen.entries()]
    .flatMap(([channel, messages]) => messages.map((message) => `${channel}: ${message.title}`))
    .sort()
}

test('a hook delivers to the channels it names and to nothing else', async (t) => {
  const { ctx, seen } = await routed(t)
  await ctx.routes.create({ name: 'urgent', targets: [{ channel: 'telegram' }, { channel: 'ntfy' }] })
  await ctx.routes.create({ name: 'notice', targets: [{ channel: 'telegram' }] })

  await ctx.hooks.dispatch(event({ hook: 'urgent', title: 'api is down' }))
  await ctx.hooks.dispatch(event({ hook: 'notice', title: 'backup done' }))

  assert.deepEqual(delivered(seen), [
    'ntfy: api is down',
    'telegram: api is down',
    'telegram: backup done',
  ])
})

test('the always channels come on top of the targets, without duplicating', async (t) => {
  const { ctx, seen } = await routed(t, { always: ['console'] })
  await ctx.routes.create({ name: 'urgent', targets: [{ channel: 'telegram' }, { channel: 'console' }] })
  await ctx.routes.create({ name: 'notice', targets: [{ channel: 'telegram' }] })

  await ctx.hooks.dispatch(event({ hook: 'urgent', title: 'one' }))
  await ctx.hooks.dispatch(event({ hook: 'notice', title: 'two' }))

  assert.deepEqual(delivered(seen), ['console: one', 'console: two', 'telegram: one', 'telegram: two'])
  assert.equal(seen.get('console')!.length, 2, 'console is listed twice for urgent but delivers once')
})

test('the mapping makes the same event read differently per channel', async (t) => {
  const { ctx, seen } = await routed(t)
  await ctx.routes.create({
    name: 'urgent',
    targets: [
      {
        channel: 'telegram',
        map: {
          title: 'fire: {{title}}',
          body: '{{message}}\n\nbuild {{payload.buildId}}',
          level: 'critical',
          tags: ['prod', '{{hook}}'],
        },
      },
      { channel: 'ntfy' },
    ],
  })

  await ctx.hooks.dispatch(
    event({
      hook: 'urgent',
      title: 'api is down',
      body: '3 checks failed',
      level: 'warning',
      tags: ['uptime'],
      payload: { buildId: 88213 },
    }),
  )

  const telegram = seen.get('telegram')![0]!
  assert.equal(telegram.title, 'fire: api is down')
  assert.equal(telegram.body, '3 checks failed\n\nbuild 88213')
  assert.equal(telegram.level, 'critical')
  assert.deepEqual(telegram.tags, ['prod', 'urgent'])

  const ntfy = seen.get('ntfy')![0]!
  assert.equal(ntfy.title, 'api is down', 'the unmapped target keeps the original')
  assert.equal(ntfy.level, 'warning')
  assert.deepEqual(ntfy.tags, ['uptime'])
})

test('a target can filter inside the hook', async (t) => {
  const { ctx, seen } = await routed(t)
  await ctx.routes.create({
    name: 'ci',
    targets: [{ channel: 'telegram' }, { channel: 'ntfy', match: { minLevel: 'error' } }],
  })

  await ctx.hooks.dispatch(event({ hook: 'ci', title: 'flaky test', level: 'info' }))
  await ctx.hooks.dispatch(event({ hook: 'ci', title: 'build broken', level: 'error' }))

  assert.deepEqual(delivered(seen), ['ntfy: build broken', 'telegram: build broken', 'telegram: flaky test'])
})

test('a disabled hook delivers nowhere, an unknown hook falls back to the matchers', async (t) => {
  const { ctx, seen } = await routed(t)
  await ctx.routes.create({ name: 'off', disabled: true, targets: [{ channel: 'telegram' }] })

  await ctx.hooks.dispatch(event({ hook: 'off', title: 'nobody hears this' }))
  assert.deepEqual(delivered(seen), [])

  // No definition, so the channels decide, and none of the three has a matcher.
  await ctx.hooks.dispatch(event({ hook: 'manual', title: 'sent by hand' }))
  assert.deepEqual(delivered(seen), [
    'console: sent by hand',
    'ntfy: sent by hand',
    'telegram: sent by hand',
  ])
})

test('fallback none drops an event whose hook is not defined', async (t) => {
  const { ctx, seen } = await routed(t, { fallback: 'none' })
  await ctx.hooks.dispatch(event({ hook: 'manual', title: 'sent by hand' }))
  assert.deepEqual(delivered(seen), [])
})

test('a target pointing at a channel that is gone is a visible skip', async (t) => {
  const { ctx } = await routed(t)
  await ctx.routes.create({ name: 'urgent', targets: [{ channel: 'typo-graph' }] })

  const results = await ctx.hooks.dispatch(event({ hook: 'urgent' }))

  assert.equal(results.length, 1)
  assert.equal(results[0]!.status, 'skipped')
  assert.match(results[0]!.status === 'skipped' ? results[0]!.reason : '', /no channel named/)
})

test('the secret is generated once, stored as a hash and checked per hook', async (t) => {
  const { ctx } = await routed(t)
  const created = await ctx.routes.create({ name: 'urgent', targets: [] })
  const other = await ctx.routes.create({ name: 'notice', targets: [] })

  assert.ok(created.secret, 'a create hands back a secret')
  assert.equal(created.hook.secretHash, hashSecret(created.secret!))
  assert.notEqual(created.hook.secretHash, created.secret, 'the value itself is not stored')

  assert.equal(ctx.routes.authorize('urgent', created.secret!), 'ok')
  assert.equal(ctx.routes.authorize('urgent', other.secret!), 'refused', 'the other hook has its own')
  assert.equal(ctx.routes.authorize('urgent', ''), 'refused')
  assert.equal(ctx.routes.authorize('nope', created.secret!), 'unknown')

  const rotated = await ctx.routes.rotate('urgent')
  assert.notEqual(rotated.secret, created.secret)
  assert.equal(ctx.routes.authorize('urgent', created.secret!), 'refused', 'the old secret is dead')
  assert.equal(ctx.routes.authorize('urgent', rotated.secret), 'ok')
})

test('an open hook accepts anything, a disabled hook accepts nothing', async (t) => {
  const { ctx } = await routed(t)
  await ctx.routes.create({ name: 'open', secret: false, targets: [] })
  await ctx.routes.create({ name: 'off', disabled: true, targets: [] })

  assert.equal(ctx.routes.get('open')!.secretHash, null)
  assert.equal(ctx.routes.authorize('open', ''), 'ok')
  assert.equal(ctx.routes.authorize('off', ''), 'disabled')
})

test('preview resolves the message per channel without sending', async (t) => {
  const { ctx, seen } = await routed(t, { always: ['console'] })
  await ctx.routes.create({
    name: 'urgent',
    targets: [
      { channel: 'telegram', map: { title: 'fire: {{title}}', body: 'build {{payload.buildId}}' } },
      { channel: 'ntfy', match: { minLevel: 'critical' } },
    ],
  })

  const preview = await ctx.routes.preview('urgent', {
    title: 'api is down',
    message: 'three checks failed',
    level: 'error',
    buildId: 4321,
  })

  assert.deepEqual(
    preview.map((row) => row.channel),
    ['telegram', 'ntfy', 'console'],
  )
  assert.equal(preview[0]!.message?.title, 'fire: api is down')
  assert.equal(preview[0]!.message?.body, 'build 4321')
  assert.match(preview[1]!.skipped ?? '', /matcher/, 'error is below critical, so ntfy is skipped')
  assert.equal(preview[2]!.message?.title, 'api is down', 'the always channel is previewed too')
  assert.deepEqual(delivered(seen), [], 'a preview sends nothing')
})

test('a target set twice replaces the earlier one instead of adding a second', async (t) => {
  const { ctx } = await routed(t)
  await ctx.routes.create({ name: 'urgent', targets: [{ channel: 'telegram', map: { title: 'first' } }] })
  const updated = await ctx.routes.setTarget('urgent', { channel: 'telegram', map: { title: 'second' } })

  assert.equal(updated.targets.length, 1)
  assert.equal(updated.targets[0]!.map?.title, 'second')

  const without = await ctx.routes.removeTarget('urgent', 'telegram')
  assert.deepEqual(without.targets, [])
})

test('definitions survive a remount, and export round-trips', async (t) => {
  const { ctx } = await routed(t)
  const created = await ctx.routes.create({
    name: 'urgent',
    description: 'wakes me up',
    targets: [{ channel: 'telegram', map: { title: 'fire: {{title}}' } }],
  })
  const exported = ctx.routes.list()

  await ctx.routes.replaceAll([])
  assert.deepEqual(ctx.routes.list(), [], 'the table is empty after a replace with nothing')

  await ctx.routes.replaceAll(exported)
  const back = ctx.routes.get('urgent')!
  assert.equal(back.description, 'wakes me up')
  assert.equal(back.targets[0]!.map?.title, 'fire: {{title}}')
  assert.equal(back.secretHash, created.hook.secretHash, 'the hash comes back, so the secret still works')
  assert.equal(ctx.routes.authorize('urgent', created.secret!), 'ok')
})

test('a hook name has to be usable as a path segment', async (t) => {
  const { ctx } = await routed(t)
  await assert.rejects(() => ctx.routes.create({ name: 'not a name', targets: [] }), /not a usable hook name/)
  await assert.rejects(() => ctx.routes.create({ name: 'a/b', targets: [] }), /not a usable hook name/)
  await ctx.routes.create({ name: 'deploy.prod-2', targets: [] })
  assert.ok(ctx.routes.get('deploy.prod-2'))
})

test('creating the same hook twice is refused', async (t) => {
  const { ctx } = await routed(t)
  await ctx.routes.create({ name: 'urgent', targets: [] })
  await assert.rejects(() => ctx.routes.create({ name: 'urgent', targets: [] }), /already exists/)
})

test('seeding runs once, and only with a secret to seed', async (t) => {
  const seed = [{ name: 'urgent', targets: [{ channel: 'telegram' }] }]

  const bare = await routed(t, { seed })
  assert.deepEqual(bare.ctx.routes.list(), [], 'no seedSecret means no seeded hooks')

  const seeded = await routed(t, { seed, seedSecret: 'from-the-env' })
  const hook = seeded.ctx.routes.get('urgent')
  assert.ok(hook)
  assert.equal(seeded.ctx.routes.authorize('urgent', 'from-the-env'), 'ok')
  assert.deepEqual(hook.targets, [{ channel: 'telegram' }])
})

test('the outbox routes again on every pass, so a target change lands mid-flight', async (t) => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(timer)
  await ctx.plugin(hooksPlugin)
  await ctx.plugin(storePlugin, { path: ':memory:', retentionDays: 0 })

  let attempts = 0
  await ctx.inject(['notify'], (child) => {
    child.notify.register({ name: 'good', async send() {} })
    child.notify.register({
      name: 'broken',
      async send() {
        attempts += 1
        throw new Error('down')
      },
    })
  })

  await ctx.plugin(routesPlugin, {})
  await ctx.routes.create({ name: 'urgent', targets: [{ channel: 'good' }, { channel: 'broken' }] })
  // Fast enough to see two passes, slow enough that the first one settles first.
  await ctx.plugin(outboxPlugin, { baseDelayMs: 20, maxDelayMs: 20, pollMs: 30, attempts: 20 })

  const submitted = await ctx.hooks.submit(event({ hook: 'urgent', title: 'api is down' }))
  await settled(ctx, submitted.id, 'pending')
  assert.ok(attempts >= 1, 'the broken channel was tried')

  // Take the broken channel out of the hook while the event is still owed.
  await ctx.routes.removeTarget('urgent', 'broken')
  const done = await settled(ctx, submitted.id, 'done')

  assert.equal(done.outcome, 'delivered', 'nothing is owed any more, so the event settles')
  assert.deepEqual(
    done.deliveries.map((delivery) => [delivery.channel, delivery.status]).sort(),
    [['broken', 'failed'], ['good', 'sent']],
    'the earlier failure stays in the history, it just is not retried any more',
  )
  const goodOnly = attempts
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(attempts, goodOnly, 'the removed target is not tried again')
})
