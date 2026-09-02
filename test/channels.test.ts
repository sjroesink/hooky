import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as ntfyChannel from '../src/plugins/channel-ntfy.ts'
import * as teamsChannel from '../src/plugins/channel-teams.ts'
import { envelope } from '../src/plugins/channel-teams.ts'
import * as telegramChannel from '../src/plugins/channel-telegram.ts'
import { buttonable, format } from '../src/plugins/channel-telegram.ts'
import * as hooksPlugin from '../src/plugins/hooks.ts'
import type { MessageAction } from '../src/core/types.ts'
import { captureFetch, event } from './helpers.ts'

test('telegram sends HTML with chat_id and escapes the text', async () => {
  const { calls, restore } = captureFetch()
  try {
    const ctx = new Context()
    await ctx.plugin(hooksPlugin)
    await ctx.plugin(telegramChannel, { token: 'SECRET', chatId: '-100123' })

    const results = await ctx.hooks.dispatch(
      event({ title: 'a < b & c', body: '<script>', level: 'error', url: 'https://x.test/a b' }),
    )
    assert.equal(results[0]!.status, 'sent')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url, 'https://api.telegram.org/botSECRET/sendMessage')

    const body = JSON.parse(String(calls[0]!.init.body))
    assert.equal(body.chat_id, '-100123')
    assert.equal(body.parse_mode, 'HTML')
    assert.equal(body.disable_notification, false)
    assert.match(body.text, /<b>a &lt; b &amp; c<\/b>/)
    assert.match(body.text, /&lt;script&gt;/)
    assert.ok(!('message_thread_id' in body))
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('telegram sets disable_notification below silentBelow', async () => {
  const { calls, restore } = captureFetch()
  try {
    const ctx = new Context()
    await ctx.plugin(hooksPlugin)
    await ctx.plugin(telegramChannel, {
      token: 't',
      chatId: '1',
      silentBelow: 'error',
      threadId: 42,
    })
    await ctx.hooks.dispatch(event({ level: 'info' }))
    const body = JSON.parse(String(calls[0]!.init.body))
    assert.equal(body.disable_notification, true)
    assert.equal(body.message_thread_id, 42)
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('ntfy publishes as JSON with the right priority', async () => {
  const { calls, restore } = captureFetch()
  try {
    const ctx = new Context()
    await ctx.plugin(hooksPlugin)
    await ctx.plugin(ntfyChannel, {
      topic: 'my-topic',
      token: 'tk_1',
      tags: ['hooky'],
      server: 'https://ntfy.example/',
    })

    await ctx.hooks.dispatch(event({ level: 'critical', title: 'down', tags: ['prod'], url: 'https://x.test' }))
    assert.equal(calls[0]!.url, 'https://ntfy.example/')

    const headers = calls[0]!.init.headers as Record<string, string>
    assert.equal(headers['content-type'], 'application/json')
    assert.equal(headers['authorization'], 'Bearer tk_1')

    const body = JSON.parse(String(calls[0]!.init.body))
    assert.deepEqual(body, {
      topic: 'my-topic',
      title: 'down',
      message: 'down',
      priority: 5,
      tags: ['hooky', 'prod'],
      markdown: true,
      click: 'https://x.test',
    })
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('a non-2xx becomes a failed result carrying the status code', async () => {
  const { restore } = captureFetch(() => new Response('chat not found', { status: 400 }))
  try {
    const ctx = new Context()
    await ctx.plugin(hooksPlugin)
    await ctx.plugin(telegramChannel, { token: 't', chatId: 'fout' })
    const results = await ctx.hooks.dispatch(event())
    assert.equal(results[0]!.status, 'failed')
    assert.match(
      results[0]!.status === 'failed' ? results[0]!.error : '',
      /telegram responded 400: chat not found/,
    )
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('format stacks title, body, tags and link', () => {
  const text = format({
    title: 'heading',
    body: 'line',
    level: 'info',
    tags: ['a', 'b'],
    url: 'https://x.test/pad',
    event: event(),
  })
  assert.equal(text, '<b>heading</b>\nline\n<i>a, b</i>\n<a href="https://x.test/pad">https://x.test/pad</a>')
})

const WEBHOOK = 'https://example.test/powerautomate/automations/direct/workflows/x/triggers/manual/paths/invoke?sig=s'

test('teams posts the message envelope with an adaptive card in it', async () => {
  const { calls, restore } = captureFetch()
  try {
    const ctx = new Context()
    await ctx.plugin(hooksPlugin)
    await ctx.plugin(teamsChannel, { webhook: WEBHOOK })

    const results = await ctx.hooks.dispatch(
      event({ hook: 'urgent', title: 'disk full', body: 'on db-01', level: 'error', tags: ['ops'] }),
    )
    assert.equal(results[0]!.status, 'sent')
    assert.equal(calls[0]!.url, WEBHOOK)

    const body = JSON.parse(String(calls[0]!.init.body))
    assert.equal(body.type, 'message')
    assert.equal(body.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive')
    assert.equal(body.attachments[0].contentUrl, null)

    const card = body.attachments[0].content
    assert.equal(card.type, 'AdaptiveCard')
    assert.equal(card.version, '1.4')
    assert.equal(card.$schema, 'http://adaptivecards.io/schemas/adaptive-card.json')
    assert.deepEqual(card.body[0], {
      type: 'TextBlock',
      text: 'disk full',
      weight: 'Bolder',
      size: 'Medium',
      wrap: true,
      color: 'attention',
    })
    assert.deepEqual(card.body[1], { type: 'TextBlock', text: 'on db-01', wrap: true })
    assert.deepEqual(card.body[2].facts, [
      { title: 'Hook', value: 'urgent' },
      { title: 'Level', value: 'error' },
      { title: 'Tags', value: 'ops' },
    ])
    // Nothing to click, so neither the link line nor the action is there.
    assert.equal(card.body.length, 3)
    assert.ok(!('actions' in card))
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('teams turns a url into a link and a button, and the level into a colour', async () => {
  const { calls, restore } = captureFetch()
  try {
    const ctx = new Context()
    await ctx.plugin(hooksPlugin)
    await ctx.plugin(teamsChannel, { webhook: WEBHOOK, facts: false, version: '1.5' })

    await ctx.hooks.dispatch(event({ level: 'warning', body: '', url: 'https://x.test/run/9' }))
    const card = JSON.parse(String(calls[0]!.init.body)).attachments[0].content
    assert.equal(card.version, '1.5')
    assert.equal(card.body[0].color, 'warning')
    // No body text and no facts, so the title and the link are all that is left.
    assert.equal(card.body.length, 2)
    assert.deepEqual(card.body[1], {
      type: 'TextBlock',
      text: '[https://x.test/run/9](https://x.test/run/9)',
      wrap: true,
    })
    assert.deepEqual(card.actions, [{ type: 'Action.OpenUrl', title: 'Open', url: 'https://x.test/run/9' }])
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('teams in text format posts a plain string for a flow that wants one', async () => {
  const { calls, restore } = captureFetch()
  try {
    const ctx = new Context()
    await ctx.plugin(hooksPlugin)
    await ctx.plugin(teamsChannel, { webhook: WEBHOOK, format: 'text' })

    await ctx.hooks.dispatch(event({ title: 'build failed', body: 'step 3', tags: ['ci'], url: 'https://x.test' }))
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
      text: '**build failed**\n\nstep 3\n\nci\n\nhttps://x.test',
    })
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('a flow that refuses the shape fails under its own channel name', async () => {
  const { restore } = captureFetch(() => new Response('Invalid Request', { status: 400 }))
  try {
    const ctx = new Context()
    await ctx.plugin(hooksPlugin)
    await ctx.plugin(teamsChannel, { webhook: WEBHOOK, channel: 'teams-ops' })

    const results = await ctx.hooks.dispatch(event())
    assert.equal(results[0]!.channel, 'teams-ops')
    assert.match(
      results[0]!.status === 'failed' ? results[0]!.error : '',
      /teams-ops responded 400: Invalid Request/,
    )
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('the envelope is a pure function, so a flow can be checked against it', () => {
  const built = envelope(
    { title: 't', body: '', level: 'critical', tags: [], event: event({ hook: 'wake-me' }) },
    { version: '1.4', facts: true },
  )
  const card = (built['attachments'] as Record<string, any>[])[0]!['content']
  assert.equal(card.body[0].color, 'attention')
  assert.deepEqual(card.body[1].facts, [
    { title: 'Hook', value: 'wake-me' },
    { title: 'Level', value: 'critical' },
  ])
})

test('a target carries its own webhook, and that one wins', async () => {
  const { calls, restore } = captureFetch()
  try {
    const ctx = new Context()
    await ctx.plugin(hooksPlugin)
    await ctx.plugin(teamsChannel, { webhook: 'https://default.test/invoke?sig=row' })

    // deliverTo is the path a hook target takes, settings and all.
    await ctx.notify.deliverTo(
      { title: 'from a hook', body: '', level: 'info', tags: [], event: event() },
      { channel: 'teams', settings: { webhook: 'https://ops.test/invoke?sig=target' } },
    )
    assert.equal(calls[0]!.url, 'https://ops.test/invoke?sig=target')

    // No setting on the target, so the row's default is where it goes.
    await ctx.notify.deliverTo(
      { title: 'from another hook', body: '', level: 'info', tags: [], event: event() },
      { channel: 'teams' },
    )
    assert.equal(calls[1]!.url, 'https://default.test/invoke?sig=row')
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('a target can pick the format too, without a second teams row', async () => {
  const { calls, restore } = captureFetch()
  try {
    const ctx = new Context()
    await ctx.plugin(hooksPlugin)
    await ctx.plugin(teamsChannel, { webhook: WEBHOOK })

    const message = { title: 'plain', body: '', level: 'info' as const, tags: [], event: event() }
    await ctx.notify.deliverTo(message, { channel: 'teams', settings: { format: 'text' } })
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { text: '**plain**' })

    // Anything that is not a format this channel knows leaves the row's choice alone.
    await ctx.notify.deliverTo(message, { channel: 'teams', settings: { format: 'nonsense' } })
    assert.equal(JSON.parse(String(calls[1]!.init.body)).type, 'message')
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('no destination anywhere is skipped, not failed, and not retried', async () => {
  const { calls, restore } = captureFetch()
  try {
    const ctx = new Context()
    await ctx.plugin(hooksPlugin)
    await ctx.plugin(teamsChannel, {})
    await ctx.plugin(ntfyChannel, {})
    let asked = 0
    ctx.on('notify/retry', async () => void asked++)

    const message = { title: 't', body: '', level: 'info' as const, tags: [], event: event() }
    const teams = await ctx.notify.deliverTo(message, { channel: 'teams' })
    assert.equal(teams.status, 'skipped')
    assert.equal(
      teams.status === 'skipped' ? teams.reason : '',
      'no webhook url: set one on this target, or a default on the teams row',
    )

    const ntfy = await ctx.notify.deliverTo(message, { channel: 'ntfy' })
    assert.equal(ntfy.status, 'skipped')
    assert.equal(
      ntfy.status === 'skipped' ? ntfy.reason : '',
      'no topic: set one on this target, or a default on the ntfy row',
    )

    assert.equal(calls.length, 0, 'nothing was posted anywhere')
    // A skip is not a failure, so the policy is never asked and the outbox
    // schedules no pass to try the same nothing again.
    assert.equal(asked, 0)
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('a channel says which settings it takes, so a form can ask for them', async () => {
  const ctx = new Context()
  await ctx.plugin(hooksPlugin)
  await ctx.plugin(teamsChannel, { webhook: WEBHOOK })
  await ctx.plugin(ntfyChannel, { topic: 'quiet' })
  await ctx.plugin(telegramChannel, { token: 't', chatId: '1' })

  const declared = ctx.notify.settings
  assert.deepEqual(Object.keys(declared), ['teams', 'ntfy'], 'telegram takes nothing per target')
  assert.deepEqual(
    declared['teams']!.map((one) => one.key),
    ['webhook', 'format'],
  )
  assert.deepEqual(
    declared['ntfy']!.map((one) => one.key),
    ['topic', 'server', 'token'],
  )
  assert.equal(declared['teams']![0]!.secret, true, 'the url is a credential')
  assert.equal(declared['ntfy']![0]!.secret, undefined, 'a topic is not one')
  await ctx.fiber.dispose()
})

test('a target publishes to its own ntfy topic, on its own server', async () => {
  const { calls, restore } = captureFetch()
  try {
    const ctx = new Context()
    await ctx.plugin(hooksPlugin)
    await ctx.plugin(ntfyChannel, { topic: 'row-topic', token: 'row-token' })

    const message = { title: 'hello', body: '', level: 'info' as const, tags: [], event: event() }
    await ctx.notify.deliverTo(message, { channel: 'ntfy', settings: { topic: 'deploys' } })
    assert.equal(calls[0]!.url, 'https://ntfy.sh/')
    assert.equal(JSON.parse(String(calls[0]!.init.body)).topic, 'deploys')
    assert.equal(
      (calls[0]!.init.headers as Record<string, string>)['authorization'],
      'Bearer row-token',
      'the row token still covers it',
    )

    await ctx.notify.deliverTo(message, {
      channel: 'ntfy',
      settings: { topic: 'private', server: 'https://ntfy.example.test/', token: 'target-token' },
    })
    assert.equal(calls[1]!.url, 'https://ntfy.example.test/')
    assert.equal(JSON.parse(String(calls[1]!.init.body)).topic, 'private')
    assert.equal(
      (calls[1]!.init.headers as Record<string, string>)['authorization'],
      'Bearer target-token',
    )

    // Nothing on the target, so the row decides, as it always did.
    await ctx.notify.deliverTo(message, { channel: 'ntfy' })
    assert.equal(JSON.parse(String(calls[2]!.init.body)).topic, 'row-topic')
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

/** Two answers and a link the caller supplied, the way a question arrives. */
const ANSWERS: MessageAction[] = [
  { value: 'yes', title: 'yes', url: 'https://h.test/ask/reply/abc/yes', reply: true },
  { value: 'no', title: 'no', url: 'https://h.test/ask/reply/abc/no', reply: true },
  { value: 'the-diff', title: 'the diff', url: 'https://ci.test/diff/1', reply: false },
]

test('telegram puts the answers in buttons and leaves the text alone', async () => {
  const { calls, restore } = captureFetch()
  try {
    const ctx = new Context()
    await ctx.plugin(hooksPlugin)
    await ctx.plugin(telegramChannel, { token: 't', chatId: '1' })

    await ctx.inject(['notify'], async (child) => {
      await child.notify.deliverTo(
        { title: 'Deploy?', body: 'to prod', level: 'warning', tags: [], actions: ANSWERS, event: event() },
        { channel: 'telegram' },
      )
    })

    const body = JSON.parse(String(calls[0]!.init.body))
    assert.equal(body.text, '<b>Deploy?</b>\nto prod', 'no urls glued under the text')
    assert.deepEqual(body.reply_markup.inline_keyboard, [
      [{ text: 'yes', url: 'https://h.test/ask/reply/abc/yes' }],
      [{ text: 'no', url: 'https://h.test/ask/reply/abc/no' }],
      [{ text: 'the diff', url: 'https://ci.test/diff/1' }],
    ])
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('telegram puts the answers in the text when a button url will not fly', async () => {
  const { calls, restore } = captureFetch()
  try {
    const ctx = new Context()
    await ctx.plugin(hooksPlugin)
    await ctx.plugin(telegramChannel, { token: 't', chatId: '1' })

    // What an instance without a public url produces. Telegram answers 400 for
    // the whole message on a button url like this, so it must not send one.
    const local = [
      { value: 'yes', title: 'yes', url: 'http://localhost:3112/ask/reply/abc/yes', reply: true },
    ]
    await ctx.inject(['notify'], async (child) => {
      await child.notify.deliverTo(
        { title: 'Deploy?', body: 'to prod', level: 'warning', tags: [], actions: local, event: event() },
        { channel: 'telegram' },
      )
    })

    const body = JSON.parse(String(calls[0]!.init.body))
    assert.equal('reply_markup' in body, false)
    assert.match(body.text, /yes: http:..localhost:3112.ask.reply.abc.yes/)
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('what telegram will and will not put in a button', () => {
  assert.equal(buttonable([{ value: 'a', title: 'a', url: 'https://hooky.example.com/x', reply: true }]), true)
  assert.equal(buttonable([{ value: 'a', title: 'a', url: 'http://localhost:3112/x', reply: true }]), false)
  assert.equal(buttonable([{ value: 'a', title: 'a', url: 'http://127.0.0.1:3112/x', reply: true }]), false)
  assert.equal(buttonable([{ value: 'a', title: 'a', url: 'http://hooky.local/x', reply: true }]), false)
  assert.equal(buttonable([{ value: 'a', title: 'a', url: 'http://intranet/x', reply: true }]), false)
  assert.equal(buttonable([{ value: 'a', title: 'a', url: 'not a url', reply: true }]), false)
  assert.equal(buttonable([]), false)
  assert.equal(buttonable(undefined), false)
})

test('ntfy takes three answers as buttons and puts the rest back in the text', async () => {
  const { calls, restore } = captureFetch()
  try {
    const ctx = new Context()
    await ctx.plugin(hooksPlugin)
    await ctx.plugin(ntfyChannel, { topic: 'alerts' })

    const four = [...ANSWERS, { value: 'later', title: 'later', url: 'https://h.test/ask/reply/abc/later', reply: true }]
    await ctx.inject(['notify'], async (child) => {
      await child.notify.deliverTo(
        { title: 'Deploy?', body: 'to prod', level: 'warning', tags: [], actions: four, event: event() },
        { channel: 'ntfy' },
      )
    })

    const body = JSON.parse(String(calls[0]!.init.body))
    assert.deepEqual(
      body.actions.map((one: { action: string; label: string; url: string; clear: boolean }) => one),
      [
        { action: 'view', label: 'yes', url: 'https://h.test/ask/reply/abc/yes', clear: false },
        { action: 'view', label: 'no', url: 'https://h.test/ask/reply/abc/no', clear: false },
        { action: 'view', label: 'the diff', url: 'https://ci.test/diff/1', clear: false },
      ],
      'ntfy shows three',
    )
    assert.equal(body.message, 'to prod\n\nlater: https://h.test/ask/reply/abc/later', 'the fourth is not lost')
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('a channel without buttons gets the answers under the body', async () => {
  const ctx = new Context()
  await ctx.plugin(hooksPlugin)
  const seen: { body: string }[] = []
  await ctx.inject(['notify'], async (child) => {
    child.notify.register({
      name: 'plain',
      async send(message) {
        seen.push({ body: message.body })
      },
    })
    await child.notify.deliverTo(
      { title: 'Deploy?', body: 'to prod', level: 'info', tags: [], actions: ANSWERS, event: event() },
      { channel: 'plain' },
    )
  })
  assert.equal(
    seen[0]!.body,
    'to prod\n\nyes: https://h.test/ask/reply/abc/yes\nno: https://h.test/ask/reply/abc/no\nthe diff: https://ci.test/diff/1',
  )
  await ctx.fiber.dispose()
})
