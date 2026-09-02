import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import timer from '@deepseek-ai/cordis-plugin-timer'
import { appendActions, parseAsk, slugFor } from '../src/core/ask.ts'
import type { Message, MessageAction } from '../src/core/types.ts'
import * as askPlugin from '../src/plugins/ask.ts'
import * as hooksPlugin from '../src/plugins/hooks.ts'
import * as routesPlugin from '../src/plugins/hook-routes.ts'
import * as ingestPlugin from '../src/plugins/ingest-http.ts'
import * as outboxPlugin from '../src/plugins/outbox.ts'
import * as serverPlugin from '../src/plugins/server-node.ts'
import * as storePlugin from '../src/plugins/store-sqlite.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface AskView {
  id: string
  hook: string
  question: string
  statusUrl: string
  replyUrl: string
  expiresAt: number
  actions: MessageAction[]
  answered: { action: string | null; at: number; data?: unknown } | null
}

interface Answer {
  id: string
  queued: boolean
  state: string
  results: { channel: string; status: string }[]
  ask?: AskView
  [extra: string]: unknown
}

const YES_NO = { actions: [{ title: 'yes' }, { title: 'no' }] }

/** One hook, one stub channel, the outbox, and the ask plugin over all of it. */
async function stack(
  t: TestContext,
  options: Partial<askPlugin.Config> & { native?: boolean; attempts?: number } = {},
) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(timer)
  await ctx.plugin(serverPlugin, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(hooksPlugin)
  await ctx.plugin(ingestPlugin, {})
  await ctx.plugin(storePlugin, { path: ':memory:', retentionDays: 0 })
  await ctx.plugin(outboxPlugin, { pollMs: 60_000, attempts: options.attempts ?? 8 })

  const channel = { fail: false }
  const seen: Message[] = []
  await ctx.inject(['notify'], (child) => {
    child.notify.register({
      name: 'stub',
      ...(options.native ? { actions: true } : {}),
      async send(message) {
        if (channel.fail) throw new Error('the channel said 503')
        seen.push(message)
      },
    })
  })

  const { native: _native, attempts: _attempts, ...askConfig } = options
  const askFiber = await ctx.plugin(askPlugin, askConfig)
  await ctx.plugin(routesPlugin, { always: [] })
  const created = await ctx.routes.create({ name: 'deploy', targets: [{ channel: 'stub' }] })
  const secret = created.secret!

  const base = `http://127.0.0.1:${ctx.server.address.port}`
  const post = async (payload: unknown, path = '') => {
    const response = await fetch(`${base}/hooks/deploy${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hooky-secret': secret },
      body: JSON.stringify(payload),
    })
    return { status: response.status, body: (await response.json()) as Answer }
  }

  /**
   * The message as it arrived at the channel. That is where a person reads a
   * question, and while the call is still waiting it is the only place it is.
   */
  const delivered = async (tries = 100): Promise<Message> => {
    for (let attempt = 0; attempt < tries; attempt++) {
      const last = seen.at(-1)
      if (last) return last
      await sleep(25)
    }
    throw new Error('no message arrived')
  }

  const reply = (url: string, init: RequestInit = {}) =>
    fetch(url, { method: 'POST', headers: { accept: 'application/json' }, ...init })

  const statusOf = async (ask: AskView) => (await (await fetch(ask.statusUrl)).json()) as AskView

  return { ctx, askFiber, base, channel, seen, post, delivered, reply, statusOf }
}

test('parseAsk reads one namespace, and nothing else is a question', () => {
  assert.equal(parseAsk({ title: 'x' }, 5), undefined)
  assert.equal(parseAsk({ actions: [{ title: 'yes' }] }, 5), undefined, 'a foreign payload is not an ask')
  assert.equal(parseAsk({ ask: 'yes' }, 5), undefined)
  assert.equal(parseAsk('a string payload', 5), undefined)
  assert.deepEqual(parseAsk({ ask: true }, 5), { actions: [] })
  assert.deepEqual(parseAsk({ ask: {} }, 5), { actions: [] })
  assert.deepEqual(parseAsk({ ask: { wait: 30, id: 'abc' } }, 5), { wait: 30, id: 'abc', actions: [] })
})

test('an answer has to be an object with a title', () => {
  const actions = (raw: unknown) => parseAsk({ ask: { actions: raw } }, 5)!.actions
  assert.deepEqual(actions(['build', 'test']), [])
  assert.deepEqual(actions([{ label: 'x' }]), [])
  assert.deepEqual(actions('yes'), [])
  assert.deepEqual(actions([{ title: 'Ship it' }]), [{ value: 'ship-it', title: 'Ship it' }])
  // The cap is a cap, and a repeated value is made unique.
  assert.equal(actions(Array(9).fill({ title: 'a' })).length, 5)
  assert.deepEqual(
    actions([{ title: 'yes' }, { title: 'yes' }]).map((one) => one.value),
    ['yes', 'yes-1'],
  )
})

test('a slug survives being a path segment', () => {
  assert.equal(slugFor('Ja, doe maar', 0), 'ja-doe-maar')
  assert.equal(slugFor('***', 1), 'a2')
  assert.equal(slugFor('a'.repeat(50), 0).length, 32)
})

test('appendActions puts one answer on one line', () => {
  const actions: MessageAction[] = [
    { value: 'yes', title: 'yes', url: 'https://h.test/ask/reply/abc/yes', reply: true },
  ]
  assert.equal(appendActions('body', actions), 'body\n\nyes: https://h.test/ask/reply/abc/yes')
  assert.equal(appendActions('', actions), 'yes: https://h.test/ask/reply/abc/yes')
})

test('a question gets one reply url, and one per answer it offers', async (t) => {
  const { post, seen } = await stack(t, { waitMs: 0 })

  const answer = await post({ title: 'Deploy 4471?', message: 'to prod', ask: YES_NO })
  assert.equal(answer.status, 200)
  const ask = answer.body.ask!
  assert.match(ask.replyUrl, /\/ask\/reply\/[\w.-]{16,}$/)
  assert.match(ask.statusUrl, /\/ask\/[\w.-]{16,}$/)
  assert.equal(ask.actions.length, 2)
  assert.ok(ask.actions.every((one) => one.reply))
  assert.equal(ask.actions[0]!.url, `${ask.replyUrl}/yes`)
  assert.equal(ask.actions[1]!.url, `${ask.replyUrl}/no`)
  assert.equal(ask.answered, null)
  assert.equal(ask.question, 'Deploy 4471?')

  // Every channel that knows nothing about a question gets the answers as lines.
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.body, `to prod\n\nyes: ${ask.replyUrl}/yes\nno: ${ask.replyUrl}/no`)
  assert.deepEqual(seen[0]!.actions, ask.actions)
})

test('a channel that renders answers itself keeps the body it was given', async (t) => {
  const { post, seen } = await stack(t, { waitMs: 0, native: true })

  const answer = await post({ title: 'Deploy?', message: 'to prod', ask: YES_NO })
  assert.equal(seen[0]!.body, 'to prod')
  assert.equal(seen[0]!.actions?.length, 2)
  assert.equal(answer.body.ask!.actions.length, 2)
})

test('a target with its own body template still carries the answers', async (t) => {
  const { ctx, post, seen } = await stack(t, { waitMs: 0 })
  await ctx.routes.setTarget('deploy', { channel: 'stub', map: { body: 'only {{title}}' } })

  const answer = await post({ title: 'Deploy?', ask: YES_NO })
  assert.ok(seen[0]!.body.startsWith('only Deploy?'), seen[0]!.body)
  assert.ok(
    seen[0]!.body.includes(answer.body.ask!.actions[0]!.url),
    'the mapping cannot drop the only way to answer',
  )
})

test('replying settles the waiting call with that answer', async (t) => {
  const { post, delivered, reply } = await stack(t, { waitMs: 8_000, confirm: false })

  const call = post({ title: 'Deploy?', ask: YES_NO })
  const message = await delivered()

  const clicked = await reply(message.actions![0]!.url)
  assert.equal(clicked.status, 200)

  const answer = await call
  assert.equal(answer.status, 200)
  assert.equal(answer.body.ask!.answered?.action, 'yes')
  assert.equal(typeof answer.body.ask!.answered?.at, 'number')
})

test('a question with no answers renders nothing and takes a posted body', async (t) => {
  // The form shape. The reader opens the page in `url`, that page posts the
  // fields to the one reply url, and the caller knew that url before it asked
  // because it brought the id along.
  const { base, post, delivered, reply } = await stack(t, { waitMs: 8_000 })
  const id = 'b7f2c1de-4a33-4c07-9f11-2b8e5d6a1c90'

  const call = post({
    title: 'Five questions about the sprint',
    message: 'Takes two minutes.',
    url: 'https://example.test/the-form',
    ask: { id, wait: 8 },
  })
  const message = await delivered()
  assert.equal(message.body, 'Takes two minutes.', 'no lines under the body')
  assert.equal(message.actions, undefined, 'and nothing for a channel to render')
  assert.equal(message.url, 'https://example.test/the-form')

  const filled = { pace: 4, blockers: ['review latency'], note: 'fine' }
  const posted = await reply(`${base}/ask/reply/${id}`, {
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(filled),
  })
  assert.equal(posted.status, 200)

  const answer = await call
  assert.equal(answer.body.ask!.id, id)
  assert.equal(answer.body.ask!.answered?.action, null, 'no answer was named')
  assert.deepEqual(answer.body.ask!.answered?.data, filled)
})

test('a named answer may carry a body too', async (t) => {
  const { post, reply, statusOf } = await stack(t, { waitMs: 0, confirm: false })
  const answer = await post({ title: 'Deploy?', ask: { actions: [{ title: 'yes, but' }] } })
  const ask = answer.body.ask!

  await reply(ask.actions[0]!.url, {
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ note: 'after the demo' }),
  })
  const status = await statusOf(ask)
  assert.equal(status.answered?.action, 'yes-but')
  assert.deepEqual(status.answered?.data, { note: 'after the demo' })
})

test('a form post becomes one key per field, and repeats become a list', async (t) => {
  const { post, reply, statusOf } = await stack(t, { waitMs: 0 })
  const answer = await post({ title: 'Pick your teams', ask: true })

  await reply(answer.body.ask!.replyUrl, {
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: 'note=all+good&team=one&team=two',
  })
  const status = await statusOf(answer.body.ask!)
  assert.deepEqual(status.answered?.data, { note: 'all good', team: ['one', 'two'] })
})

test('an answer bigger than the cap is refused and the question stays open', async (t) => {
  const { post, reply } = await stack(t, { waitMs: 0, maxAnswerBytes: 64 })
  const answer = await post({ title: 'Deploy?', ask: true })
  const url = answer.body.ask!.replyUrl

  const refused = await reply(url, {
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ note: 'x'.repeat(200) }),
  })
  assert.equal(refused.status, 413)

  const broken = await reply(url, {
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: '{not json',
  })
  assert.equal(broken.status, 400)

  assert.equal((await reply(url)).status, 200, 'neither attempt closed the question')
})

test('a second reply says what the first one answered', async (t) => {
  const { post, reply } = await stack(t, { waitMs: 0, confirm: false })
  const answer = await post({ title: 'Deploy?', ask: YES_NO })
  const [yes, no] = answer.body.ask!.actions

  assert.equal((await reply(yes!.url)).status, 200)

  const second = await reply(no!.url)
  assert.equal(second.status, 409)
  const body = (await second.json()) as { ok: boolean; reason: string; ask: AskView }
  assert.equal(body.ok, false)
  assert.match(body.reason, /already answered yes/)
  assert.equal(body.ask.answered?.action, 'yes', 'the first answer stands')
})

test('two replies at the same time produce one answer', async (t) => {
  const { post, reply } = await stack(t, { waitMs: 0, confirm: false })
  const answer = await post({ title: 'Deploy?', ask: YES_NO })
  const [yes, no] = answer.body.ask!.actions

  const [left, right] = await Promise.all([reply(yes!.url), reply(no!.url)])
  assert.deepEqual([left.status, right.status].sort(), [200, 409])
})

test('an answer the question never offered is not an answer', async (t) => {
  const { base, post, reply } = await stack(t, { waitMs: 0, confirm: false })
  const answer = await post({ title: 'Deploy?', ask: YES_NO })

  assert.equal((await reply(`${base}/ask/reply/nosuchasknosuchask/yes`)).status, 410)
  assert.equal((await reply(`${answer.body.ask!.replyUrl}/maybe`)).status, 410)

  // A question that offered none leaves that vocabulary to the caller.
  const open = await post({ title: 'Rate it', ask: { actions: [] } })
  assert.equal((await reply(`${open.body.ask!.replyUrl}/4`)).status, 200)
})

test('the bare reply url does not answer a GET', async (t) => {
  const { post } = await stack(t, { waitMs: 0 })
  const answer = await post({ title: 'Deploy?', ask: true })
  const opened = await fetch(answer.body.ask!.replyUrl, { headers: { accept: 'application/json' } })
  assert.equal(opened.status, 405)
  assert.equal(opened.headers.get('allow'), 'POST')
})

test('an expired link answers nothing', async (t) => {
  const { post, reply } = await stack(t, { waitMs: 0, keepMs: 1, confirm: false })
  const answer = await post({ title: 'Deploy?', ask: YES_NO })
  await sleep(20)

  const clicked = await reply(answer.body.ask!.actions[0]!.url)
  assert.equal(clicked.status, 410)
  assert.match(((await clicked.json()) as { reason: string }).reason, /expired/)
})

test('an answer with its own url is a link and not an answer', async (t) => {
  const { post, seen, reply } = await stack(t, { waitMs: 0 })
  const answer = await post({
    title: 'Fill in the form',
    ask: { actions: [{ title: 'open it', url: 'https://example.test/form' }, { title: 'skip' }] },
  })
  const ask = answer.body.ask!
  assert.deepEqual(
    ask.actions.map((one) => [one.value, one.reply]),
    [
      ['open-it', false],
      ['skip', true],
    ],
  )
  assert.equal(ask.actions[0]!.url, 'https://example.test/form')
  assert.ok(seen[0]!.body.includes('open it: https://example.test/form'))

  // Editing a link into an answer does not work: the ask never offered it.
  assert.equal((await reply(`${ask.replyUrl}/open-it`)).status, 410)
})

test('the wait runs out, and the answer arrives on the status url', async (t) => {
  const { post, reply } = await stack(t, { waitMs: 120, confirm: false })

  const started = Date.now()
  const answer = await post({ title: 'Deploy?', ask: YES_NO })
  assert.ok(Date.now() - started >= 100, 'it really waited')
  assert.equal(answer.body.ask!.answered, null)

  // Still open, so a later click is not lost.
  const ask = answer.body.ask!
  const polling = fetch(`${ask.statusUrl}?wait=8`).then((r) => r.json() as Promise<AskView>)
  await sleep(60)
  await reply(ask.actions[1]!.url)

  assert.equal((await polling).answered?.action, 'no')
  assert.equal(((await (await fetch(ask.statusUrl)).json()) as AskView).answered?.action, 'no')
})

test('wait in the payload is capped by the config', async (t) => {
  const { post } = await stack(t, { waitMs: 10_000, maxWaitMs: 150, confirm: false })
  const started = Date.now()
  const answer = await post({ title: 'Deploy?', ask: { ...YES_NO, wait: 600 } })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 3_000, `capped at maxWaitMs, took ${elapsed}ms`)
  assert.equal(answer.body.ask!.answered, null)
})

test('a question nobody received is not waited for', async (t) => {
  // One pass and no retry, so the queue owes nothing once the channel refused.
  const { post, channel } = await stack(t, { waitMs: 10_000, confirm: false, attempts: 1 })
  channel.fail = true

  const started = Date.now()
  const answer = await post({ title: 'Deploy?', ask: YES_NO })
  const elapsed = Date.now() - started

  assert.equal(
    answer.body.results.some((one) => one.status === 'sent'),
    false,
  )
  assert.equal(answer.body.queued, false, 'and the queue owes nothing either')
  assert.ok(elapsed < 3_000, `answered without waiting, took ${elapsed}ms`)
  assert.equal(answer.body.ask!.answered, null)
})

test('a question the queue may still deliver is waited for', async (t) => {
  const { post, channel } = await stack(t, { waitMs: 250, confirm: false })
  channel.fail = true

  const started = Date.now()
  const answer = await post({ title: 'Deploy?', ask: YES_NO })
  assert.equal(answer.body.queued, true, 'the outbox comes back for this one')
  assert.ok(Date.now() - started >= 200, 'so the question is still worth waiting for')
  assert.equal(answer.body.ask!.answered, null)
})

test('a fiber that unloads while a call waits still answers it', async (t) => {
  const { askFiber, post, delivered } = await stack(t, { waitMs: 10_000, confirm: false })
  const call = post({ title: 'Deploy?', ask: YES_NO })
  await delivered()
  // The plugin goes, the server stays: a request must not hang on a promise
  // nobody is left to settle.
  await askFiber.dispose()

  const answer = await call
  assert.equal(answer.body.ask!.answered, null, 'no answer, but no hanging request either')
})

test('the caller may bring its own ask id, once', async (t) => {
  const { post, reply } = await stack(t, { waitMs: 0, confirm: false })
  const id = 'b7f2c1de-4a33-4c07-9f11-2b8e5d6a1c90'

  const answer = await post({ title: 'Five questions', ask: { id, actions: [{ title: 'submit' }] } })
  assert.equal(answer.body.ask!.id, id)
  assert.ok(answer.body.ask!.actions[0]!.url.endsWith(`/ask/reply/${id}/submit`))

  const again = await post({ title: 'again', ask: { id } })
  assert.equal(again.status, 400)
  assert.match(String(again.body['error']), /already in use/)

  const short = await post({ title: 'short', ask: { id: 'tooshort' } })
  assert.equal(short.status, 400)
  assert.match(String(short.body['error']), /16 to 64 characters/)

  // The first one still works, so a refused duplicate changed nothing.
  assert.equal((await reply(answer.body.ask!.actions[0]!.url)).status, 200)
})

test('the confirm page asks before it answers', async (t) => {
  const { post, statusOf } = await stack(t, { waitMs: 0 })
  const answer = await post({ title: 'Deploy 4471?', ask: YES_NO })
  const url = answer.body.ask!.actions[0]!.url

  // What a link preview crawler does. It must not answer the question.
  const page = await fetch(url)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type') ?? '', /text\/html/)
  const html = await page.text()
  assert.match(html, /Deploy 4471\?/)
  assert.ok(html.includes(`<form method="post" action="${url}"`), html.slice(0, 400))
  assert.equal((await statusOf(answer.body.ask!)).answered, null)

  // The button posts, and that is the answer.
  const posted = await fetch(url, { method: 'POST' })
  assert.equal(posted.status, 200)
  assert.match(await posted.text(), /Passed on/)

  const opened = await fetch(url)
  assert.equal(opened.status, 409)
  assert.match(await opened.text(), /Already answered/)
})

test('the ask routes are open cross-origin', async (t) => {
  const { post } = await stack(t, { waitMs: 0 })
  const answer = await post({ title: 'Deploy?', ask: true })
  const ask = answer.body.ask!

  for (const url of [ask.replyUrl, `${ask.replyUrl}/yes`]) {
    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: { origin: 'https://example.test', 'access-control-request-method': 'POST' },
    })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
    assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /content-type/)
  }

  const posted = await fetch(ask.replyUrl, { method: 'POST', headers: { accept: 'application/json' } })
  assert.equal(posted.headers.get('access-control-allow-origin'), '*')
  assert.equal((await fetch(ask.statusUrl)).headers.get('access-control-allow-origin'), '*')
})

test('a replay sends the same question again', async (t) => {
  // Telegram was down, the question never arrived, so it goes out once more.
  // Same links, because the question is the original one and still open.
  const { ctx, post, seen, reply, statusOf } = await stack(t, { waitMs: 0 })
  const answer = await post({ title: 'Deploy?', ask: YES_NO })
  const ask = answer.body.ask!

  const first = await ctx.store.get(answer.body.id)
  assert.ok(first)
  await ctx.hooks.submit({ ...first.event, id: 'replayed-1', receivedAt: Date.now(), replayOf: first.event.id })
  await sleep(400)

  const again = seen.at(-1)!
  assert.equal(again.event.replayOf, first.event.id)
  assert.deepEqual(again.actions, ask.actions, 'the same urls, not a second question')
  assert.equal((await reply(ask.actions[0]!.url)).status, 200)
  assert.equal((await statusOf(ask)).answered?.action, 'yes')
})

test('a call without an ask is untouched', async (t) => {
  const { post, seen } = await stack(t, { waitMs: 0 })
  const answer = await post({ title: 'just a notification', message: 'nothing to answer' })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.ask, undefined)
  assert.equal(seen[0]!.body, 'nothing to answer')
  assert.equal(seen[0]!.actions, undefined)
})

test('a database that saw an older asks table is brought up to date', async (t) => {
  // What a live instance ends up with when the table was created by an earlier
  // shape of this schema: `CREATE TABLE IF NOT EXISTS` leaves it alone, so the
  // column that came later has to be added by hand.
  const dir = mkdtempSync(join(tmpdir(), 'hooky-asks-'))
  const file = join(dir, 'old.db')

  const seed = new DatabaseSync(file)
  seed.exec(
    `CREATE TABLE asks (
       id TEXT PRIMARY KEY, event_id TEXT NOT NULL, hook TEXT NOT NULL, question TEXT NOT NULL,
       actions TEXT NOT NULL, answer TEXT, answer_title TEXT, answer_data TEXT,
       answered_at INTEGER, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  )
  seed.close()

  const ctx = new Context()
  // Dispose first, remove second: on Windows the file cannot go while the
  // database handle is still open.
  t.after(() => ctx.fiber.dispose())
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  await ctx.plugin(storePlugin, { path: file, retentionDays: 0 })

  const now = Date.now()
  await ctx.store.saveAsk({
    id: 'kept-across-the-migration',
    eventId: 'event-1',
    hook: 'deploy',
    question: 'Deploy?',
    baseUrl: 'https://h.test',
    actions: [{ value: 'yes', title: 'yes', url: 'https://h.test/ask/reply/x/yes', reply: true }],
    answered: null,
    createdAt: now,
    expiresAt: now + 60_000,
  })

  const back = await ctx.store.getAsk('kept-across-the-migration')
  assert.equal(back?.baseUrl, 'https://h.test')
  const answered = await ctx.store.answerAsk('kept-across-the-migration', { action: 'yes', at: now })
  assert.equal(answered.verdict, 'answered')
})
