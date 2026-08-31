import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as ntfyChannel from '../src/plugins/channel-ntfy.ts'
import * as telegramChannel from '../src/plugins/channel-telegram.ts'
import { format } from '../src/plugins/channel-telegram.ts'
import * as hooksPlugin from '../src/plugins/hooks.ts'
import { captureFetch, event } from './helpers.ts'

test('telegram stuurt HTML met chat_id en escapet de tekst', async () => {
  const { calls, restore } = captureFetch()
  try {
    const ctx = new Context()
    await ctx.plugin(hooksPlugin)
    await ctx.plugin(telegramChannel, { token: 'GEHEIM', chatId: '-100123' })

    const results = await ctx.hooks.dispatch(
      event({ title: 'a < b & c', body: '<script>', level: 'error', url: 'https://x.test/a b' }),
    )
    assert.equal(results[0]!.status, 'sent')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url, 'https://api.telegram.org/botGEHEIM/sendMessage')

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

test('telegram zet disable_notification onder silentBelow', async () => {
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

test('ntfy publiceert als JSON met de juiste priority', async () => {
  const { calls, restore } = captureFetch()
  try {
    const ctx = new Context()
    await ctx.plugin(hooksPlugin)
    await ctx.plugin(ntfyChannel, {
      topic: 'mijn-topic',
      token: 'tk_1',
      tags: ['notifier'],
      server: 'https://ntfy.example/',
    })

    await ctx.hooks.dispatch(event({ level: 'critical', title: 'plat', tags: ['prod'], url: 'https://x.test' }))
    assert.equal(calls[0]!.url, 'https://ntfy.example/')

    const headers = calls[0]!.init.headers as Record<string, string>
    assert.equal(headers['content-type'], 'application/json')
    assert.equal(headers['authorization'], 'Bearer tk_1')

    const body = JSON.parse(String(calls[0]!.init.body))
    assert.deepEqual(body, {
      topic: 'mijn-topic',
      title: 'plat',
      message: 'plat',
      priority: 5,
      tags: ['notifier', 'prod'],
      markdown: true,
      click: 'https://x.test',
    })
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('een non-2xx wordt een failed result met de statuscode erin', async () => {
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

test('format zet titel, body, tags en link onder elkaar', () => {
  const text = format({
    title: 'kop',
    body: 'regel',
    level: 'info',
    tags: ['a', 'b'],
    url: 'https://x.test/pad',
    event: event(),
  })
  assert.equal(text, '<b>kop</b>\nregel\n<i>a, b</i>\n<a href="https://x.test/pad">https://x.test/pad</a>')
})
