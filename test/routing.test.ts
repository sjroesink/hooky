import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as ntfyChannel from '../src/plugins/channel-ntfy.ts'
import * as telegramChannel from '../src/plugins/channel-telegram.ts'
import * as hooksPlugin from '../src/plugins/hooks.ts'
import { captureFetch, event } from './helpers.ts'

/**
 * The composition in cordis.yml: `urgent` goes to Telegram and ntfy, `notice`
 * only to Telegram. Both channels filter on the hook name, so adding a third
 * hook means editing one matcher and nothing else.
 */
async function twoChannels(ctx: Context): Promise<void> {
  await ctx.plugin(hooksPlugin)
  await ctx.plugin(telegramChannel, {
    token: 'tg',
    chatId: '-100123',
    match: { hooks: ['urgent', 'notice'] },
  })
  await ctx.plugin(ntfyChannel, {
    topic: 'hooky',
    server: 'https://ntfy.example/',
    match: { hooks: ['urgent'] },
  })
}

function hosts(calls: { url: string }[]): string[] {
  return calls.map((call) => new URL(call.url).host).sort()
}

test('an urgent call reaches Telegram and ntfy', async (t) => {
  const { calls, restore } = captureFetch()
  t.after(restore)
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await twoChannels(ctx)

  const results = await ctx.hooks.dispatch(event({ hook: 'urgent', title: 'api is down', level: 'critical' }))

  assert.deepEqual(hosts(calls), ['api.telegram.org', 'ntfy.example'])
  assert.deepEqual(
    results.map((result) => [result.channel, result.status]).sort(),
    [['ntfy', 'sent'], ['telegram', 'sent']],
  )
})

test('a notice call reaches Telegram only', async (t) => {
  const { calls, restore } = captureFetch()
  t.after(restore)
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await twoChannels(ctx)

  const results = await ctx.hooks.dispatch(event({ hook: 'notice', title: 'nightly backup done' }))

  assert.deepEqual(hosts(calls), ['api.telegram.org'])
  assert.deepEqual(results.map((result) => result.channel), ['telegram'])
})

test('a hook nobody matches on delivers nowhere', async (t) => {
  const { calls, restore } = captureFetch()
  t.after(restore)
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await twoChannels(ctx)

  const results = await ctx.hooks.dispatch(event({ hook: 'noise', level: 'critical' }))

  assert.deepEqual(calls, [], 'a matcher on hook names is a whitelist, not a hint')
  assert.deepEqual(results, [])
})

test('the level does not route, the hook name does', async (t) => {
  const { calls, restore } = captureFetch()
  t.after(restore)
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await twoChannels(ctx)

  // A debug on `urgent` still goes to both, and ntfy maps it to priority 1.
  await ctx.hooks.dispatch(event({ hook: 'urgent', level: 'debug', title: 'quiet but urgent' }))

  assert.deepEqual(hosts(calls), ['api.telegram.org', 'ntfy.example'])
  const ntfyCall = calls.find((call) => call.url.includes('ntfy.example'))!
  assert.equal(JSON.parse(String(ntfyCall.init.body)).priority, 1)
})
