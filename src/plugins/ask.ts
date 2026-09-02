import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  ANSWER,
  ASK_ID,
  actionsFor,
  newAskId,
  parseAsk,
  replyUrl,
  type AnswerVerdict,
  type AskAnswer,
  type StoredAsk,
} from '../core/ask.ts'
import { HookRejected } from '../core/normalize.ts'
import { originOf, type RouteRequest, type RouteResponse } from '../core/server.ts'
import type { DeliveryResult, HookEvent, MessageAction } from '../core/types.ts'
import type {} from '../core/events.ts'

export const name = 'ask'
export const inject = ['server', 'store']

export interface Config {
  prefix: string
  waitMs: number
  maxWaitMs: number
  keepMs: number
  maxActions: number
  maxAnswerBytes: number
  confirm: boolean
  allowOrigin: string
  publicUrl: string
}

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  prefix: Schema.string().default('/ask').description('Path prefix for the reply and status routes.'),
  waitMs: Schema.natural()
    .default(60_000)
    .description('How long to hold the answer to the call when the payload does not say.'),
  maxWaitMs: Schema.natural()
    .default(300_000)
    .description('Ceiling for `wait` in the payload. A proxy in front of this usually has one too.'),
  keepMs: Schema.natural()
    .default(3_600_000)
    .description('How long a reply link stays usable. Past it the link says the question expired.'),
  maxActions: Schema.natural()
    .default(5)
    .description('Answers to render at most. An ask may have none: then the reply url is the whole contract.'),
  maxAnswerBytes: Schema.natural()
    .default(16_384)
    .description('Cap on the body of a reply; it lands in the database and in the answer to a waiting call.'),
  confirm: Schema.boolean()
    .default(true)
    .description(
      'Opening a reply link shows a page with one button that posts. Keep this on: a messenger that fetches urls to build a link preview would otherwise answer the question for you.',
    ),
  allowOrigin: Schema.string()
    .default('*')
    .description(
      'Value of access-control-allow-origin on the ask routes, so a page somewhere else can post the answer. Closing it protects nothing: the reply url is the capability, and a plain form post never asked CORS for permission.',
    ),
  publicUrl: Schema.string()
    .default('')
    .description(
      'Base of a reply link, for when the asking caller reaches this instance on an address a human cannot. Empty derives it from the request.',
    ),
})

/**
 * A hook call with an `ask` in it is a question. This plugin gives it one reply
 * url, keeps the question in the store, and holds the answer to the call until
 * somebody replies.
 *
 * The caller decides what an answer looks like. `ask.actions` are answers to
 * render, and each gets that reply url with its own name on the end, which is
 * what a person taps. Declare none and the reply url is the whole contract:
 * post anything to it and that body is the answer. So a form the caller hosts
 * itself needs nothing from this plugin but the url.
 *
 * It adds no event of its own. `hook/receive` mints the urls, `notify/render`
 * puts them on the message, and `hook/answer` is the seam that was always meant
 * for this: the last word on what the caller gets back.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('ask')
  const prefix = config.prefix.replace(/\/+$/, '')
  const publicUrl = config.publicUrl.replace(/\/+$/, '')
  const cors: Record<string, string> = {
    'access-control-allow-origin': config.allowOrigin,
    'access-control-allow-headers': 'content-type, accept',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  }

  /** Callers waiting for an answer, by ask id. One reply settles all of them. */
  const waiting = new Map<string, Set<(answer: AskAnswer | undefined) => void>>()

  // A fiber that goes away must not leave a request hanging on a promise.
  ctx.effect(() => () => {
    for (const settlers of [...waiting.values()]) {
      for (const settle of [...settlers]) settle(undefined)
    }
    waiting.clear()
  })

  /**
   * Mint the question. This runs after `next()`, so auth and every normalizer
   * had their say first. A listener that vetoes after this one leaves a row for
   * a question nobody was sent, which expires like any other.
   */
  ctx.on('hook/receive', async (raw, next) => {
    const event = await next()
    if (!event) return event
    const request = parseAsk(event.payload, config.maxActions)
    if (!request) return event

    const id = givenId(request.id) ?? newAskId()
    if (await ctx.store.getAsk(id)) {
      throw new HookRejected(400, `askId '${id}' is already in use`)
    }
    const now = Date.now()
    const baseUrl = publicUrl || originOf(raw, ctx.server.address)
    await ctx.store.saveAsk({
      id,
      eventId: event.id,
      hook: event.hook,
      question: event.title,
      baseUrl,
      actions: actionsFor(request.actions, { base: baseUrl, prefix, ask: id }),
      answered: null,
      createdAt: now,
      expiresAt: now + config.keepMs,
    })
    const named = request.actions.map((one) => one.value).join(', ')
    logger.info(`ask ${id} on hook ${event.hook}: ${named || 'anything posted to its reply url'}`)
    return event
  })

  /** The answers on the message, so a channel can render them. */
  ctx.on('notify/render', async (event, next) => {
    const message = await next()
    const ask = await askFor(event)
    if (!ask?.actions.length) return message
    return { ...message, actions: ask.actions }
  })

  /** The block in the answer, and the waiting. */
  ctx.on('hook/answer', async (answer, event, next) => {
    const base = await next()
    const ask = await askFor(event)
    if (!ask) return base

    const answered =
      ask.answered ?? (worthWaiting(base.body) ? await expect(ask.id, waitMsOf(event)) : undefined)
    return { ...base, body: { ...base.body, ask: viewOf(ask, answered) } }
  })

  // One url answers a question. An answer on the end of it is what a person
  // taps, and a body posted to the bare url is what a page of your own sends.
  const REPLY = `${prefix}/reply/:ask`
  const preflight = () => ({ status: 204, headers: { ...cors, 'access-control-max-age': '600' } })

  ctx.server.route('OPTIONS', REPLY, preflight)
  ctx.server.route('OPTIONS', `${REPLY}/:action`, preflight)
  ctx.server.route('POST', REPLY, (request) => reply(request))
  ctx.server.route('POST', `${REPLY}/:action`, (request) => reply(request))

  // Nothing to read on the bare url: an answer is a POST, and a GET here is
  // usually somebody pasting the url into a browser.
  ctx.server.route('GET', REPLY, () => ({
    status: 405,
    headers: { ...cors, allow: 'POST' },
    body: { error: 'post an answer to this url, or open one of the answer urls' },
  }))

  ctx.server.route('GET', `${REPLY}/:action`, async (request) => {
    if (!config.confirm) return reply(request)
    const ask = await ctx.store.getAsk(request.params['ask'] ?? '')
    if (!ask) return closed(request, 'unknown')
    const action = answerOf(ask, request.params['action'])
    if (action === undefined) return closed(request, 'unknown', ask)
    if (ask.answered) return closed(request, 'already', ask)
    if (ask.expiresAt <= Date.now()) return closed(request, 'expired', ask)
    return confirm(ask, action)
  })

  ctx.server.route('GET', `${prefix}/:ask`, async (request) => {
    const ask = await ctx.store.getAsk(request.params['ask'] ?? '')
    if (!ask) return { status: 404, body: { error: 'no such ask' }, headers: cors }
    if (ask.answered) return { status: 200, body: viewOf(ask), headers: cors }
    const answered = await expect(ask.id, clamp(seconds(request.query.get('wait'))))
    return { status: 200, body: viewOf(ask, answered), headers: cors }
  })

  /** Answer the question, if it is still open and this url may answer it. */
  async function reply(request: RouteRequest): Promise<RouteResponse> {
    let data: unknown
    try {
      data = readBody(request, config.maxAnswerBytes)
    } catch (error) {
      const tooLarge = error instanceof TooLarge
      return {
        status: tooLarge ? 413 : 400,
        body: { error: tooLarge ? 'that answer is too large' : 'that body is not JSON' },
        headers: cors,
      }
    }

    const ask = await ctx.store.getAsk(request.params['ask'] ?? '')
    if (!ask) return closed(request, 'unknown')
    const action = answerOf(ask, request.params['action'])
    if (action === undefined) return closed(request, 'unknown', ask)

    const answer: AskAnswer = { action, at: Date.now(), ...(data === undefined ? {} : { data }) }
    const result = await ctx.store.answerAsk(ask.id, answer)
    if (result.verdict !== 'answered') return closed(request, result.verdict, result.ask ?? ask)
    settle(ask.id, answer)
    logger.info(`ask ${ask.id} on hook ${ask.hook} answered ${action ?? 'with a body'}`)

    if (wantsJson(request)) {
      return { status: 200, body: { ok: true, ask: viewOf(ask, answer) }, headers: cors }
    }
    return page(200, `${titleFor(ask, action)}, passed on`, [
      `<h1>${esc(titleFor(ask, action))}</h1>`,
      '<p>Passed on to whoever asked. You can close this page.</p>',
      `<p class="q">${esc(ask.question)}</p>`,
    ])
  }

  /**
   * Which answer this url names. Null is the bare reply url, where the body is
   * the whole answer. Undefined means this url answers nothing: an answer the
   * ask never offered, so a link nobody minted cannot be turned into one by
   * editing it. An ask that offers no answers at all leaves that vocabulary to
   * the caller, so there any slug counts.
   */
  function answerOf(ask: StoredAsk, wanted: string | undefined): string | null | undefined {
    if (wanted === undefined) return null
    const offered = ask.actions.find((one) => one.reply && one.value === wanted)
    if (offered) return offered.value
    const declared = ask.actions.some((one) => one.reply)
    return !declared && ANSWER.test(wanted) ? wanted : undefined
  }

  /** What to call an answer on a page. The caller named it, or it names itself. */
  function titleFor(ask: StoredAsk, action: string | null): string {
    if (action === null) return 'Answered'
    return ask.actions.find((one) => one.value === action)?.title ?? action
  }

  function confirm(ask: StoredAsk, action: string | null): RouteResponse {
    const title = titleFor(ask, action)
    return page(200, ask.question, [
      `<h1>${esc(ask.question)}</h1>`,
      `<p>Answering with <span class="mono">${esc(title)}</span>.</p>`,
      `<form method="post" action="${esc(replyUrl({ base: ask.baseUrl, prefix, ask: ask.id }, action ?? undefined))}">`,
      `<button type="submit">${esc(title)}</button>`,
      '</form>',
    ])
  }

  /** Nothing to answer any more: unknown, already answered, or expired. */
  function closed(request: RouteRequest, verdict: AnswerVerdict, ask?: StoredAsk): RouteResponse {
    const answered = verdict === 'already' ? ask?.answered : undefined
    const status = verdict === 'already' ? 409 : 410
    const reason = answered
      ? `already answered ${answered.action ?? 'with a body'}`
      : verdict === 'expired'
        ? 'this question expired'
        : 'no such question'
    if (wantsJson(request)) {
      return { status, body: { ok: false, reason, ...(ask ? { ask: viewOf(ask) } : {}) }, headers: cors }
    }
    const card = answered
      ? [
          '<h1>Already answered</h1>',
          `<p>With <span class="mono">${esc(titleFor(ask!, answered.action))}</span>, ${when(answered.at)}.</p>`,
          `<p class="q">${esc(ask!.question)}</p>`,
        ]
      : verdict === 'expired'
        ? ['<h1>Expired</h1>', '<p>This question is no longer open, so nothing was sent.</p>']
        : [
            '<h1>Not found</h1>',
            '<p>This link does not point at a question. It may have been cleaned up.</p>',
          ]
    return page(status, reason, card)
  }

  /** What the JSON says about an ask, in the call answer and on the status route. */
  function viewOf(ask: StoredAsk, answered?: AskAnswer): Record<string, unknown> {
    const where = { base: ask.baseUrl, prefix, ask: ask.id }
    return {
      id: ask.id,
      hook: ask.hook,
      question: ask.question,
      statusUrl: `${ask.baseUrl}${prefix}/${ask.id}`,
      replyUrl: replyUrl(where),
      expiresAt: ask.expiresAt,
      actions: ask.actions,
      answered: answered ?? ask.answered ?? null,
    }
  }

  /** Wait for an answer. Undefined when it did not come in time, or on unload. */
  function expect(id: string, waitMs: number): Promise<AskAnswer | undefined> {
    if (waitMs <= 0) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      const settlers = waiting.get(id) ?? new Set<(answer: AskAnswer | undefined) => void>()
      waiting.set(id, settlers)
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (answer: AskAnswer | undefined) => {
        clearTimeout(timer)
        settlers.delete(finish)
        if (settlers.size === 0) waiting.delete(id)
        resolve(answer)
      }
      settlers.add(finish)
      timer = setTimeout(() => finish(undefined), waitMs)
    })
  }

  function settle(id: string, answer: AskAnswer): void {
    for (const finish of [...(waiting.get(id) ?? [])]) finish(answer)
  }

  /**
   * The question this event carries. The cheap check comes first, so only an
   * event that looks like one costs a query.
   *
   * A replay is a new event with the same payload, and its question is still the
   * original one: the same links go out again, which is the whole point of
   * replaying a question nobody could answer because the channel was down.
   */
  async function askFor(event: HookEvent): Promise<StoredAsk | undefined> {
    if (parseAsk(event.payload, config.maxActions) === undefined) return undefined
    const own = await ctx.store.askForEvent(event.id)
    if (own || event.replayOf === undefined) return own
    return ctx.store.askForEvent(event.replayOf)
  }

  /** A caller may bring its own id, so its page can hold the reply url first. */
  function givenId(given: unknown): string | undefined {
    if (given === undefined) return undefined
    if (typeof given !== 'string' || !ASK_ID.test(given)) {
      throw new HookRejected(400, 'ask.id must be 16 to 64 characters of [A-Za-z0-9._-]')
    }
    return given
  }

  function waitMsOf(event: HookEvent): number {
    const given = parseAsk(event.payload, config.maxActions)?.wait
    if (given === undefined) return config.waitMs
    return clamp(seconds(given))
  }

  function clamp(ms: number | undefined): number {
    if (ms === undefined) return 0
    return Math.min(Math.max(ms, 0), config.maxWaitMs)
  }
}

/** `wait` is in seconds, because that is how a person writes a timeout. */
function seconds(given: unknown): number | undefined {
  const value = typeof given === 'string' ? Number(given) : given
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.round(value * 1000)
}

/**
 * Waiting only makes sense if the question got somewhere. A call nobody took is
 * answered right away, and its `results` say why.
 */
function worthWaiting(body: Record<string, unknown>): boolean {
  if (body['queued'] === true) return true
  const results = Array.isArray(body['results']) ? (body['results'] as DeliveryResult[]) : []
  return results.some((result) => result.status === 'sent')
}

class TooLarge extends Error {}

/**
 * What the reply sent along. A JSON object goes through untouched, a form post
 * becomes an object with one key per field, and anything else is kept as text.
 * An empty body is an answer without data, which is what a yes or a no is.
 */
function readBody(request: RouteRequest, max: number): unknown {
  if (request.body.trim() === '') return undefined
  if (Buffer.byteLength(request.body) > max) throw new TooLarge()
  const type = request.headers['content-type'] ?? ''
  if (type.includes('json')) return JSON.parse(request.body) as unknown
  if (type.includes('x-www-form-urlencoded')) {
    const fields = new Map<string, string[]>()
    for (const [key, value] of new URLSearchParams(request.body)) {
      fields.set(key, [...(fields.get(key) ?? []), value])
    }
    return Object.fromEntries(
      [...fields].map(([key, values]) => [key, values.length === 1 ? values[0] : values]),
    )
  }
  return request.body
}

/** A browser gets the page, a fetch that asked for JSON gets JSON. */
function wantsJson(request: RouteRequest): boolean {
  const accept = request.headers['accept'] ?? ''
  if (accept.includes('application/json')) return true
  return accept !== '' && !accept.includes('text/html') && !accept.includes('*/*')
}

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function when(at: number): string {
  return new Date(at).toISOString().slice(0, 19).replace('T', ' ') + ' UTC'
}

/**
 * The pages this plugin serves. One card, no JS, and it follows the theme of
 * whoever opens it, because this is the one part of Hooky that a person who
 * never saw the interface is going to look at.
 */
function page(status: number, title: string, card: string[]): RouteResponse {
  const style = [
    ':root { color-scheme: light dark;',
    '  --bg:#f6f6f7; --panel:#ffffff; --line:#d4d4d8; --fg:#18181b; --fg2:#52525b; --go:#18181b; }',
    '@media (prefers-color-scheme: dark) { :root {',
    '  --bg:#101012; --panel:#17171a; --line:#34343a; --fg:#e7e7ea; --fg2:#a1a1aa; --go:#e7e7ea; } }',
    '* { box-sizing: border-box; }',
    'body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;',
    '  background: var(--bg); color: var(--fg);',
    "  font: 15px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }",
    '.card { width: 100%; max-width: 420px; background: var(--panel);',
    '  border: 1px solid var(--line); padding: 24px; }',
    'h1 { margin: 0 0 8px; font-size: 17px; font-weight: 600; overflow-wrap: anywhere; }',
    'p { margin: 0 0 16px; color: var(--fg2); overflow-wrap: anywhere; }',
    'p:last-child { margin-bottom: 0; }',
    '.q { padding-top: 12px; border-top: 1px solid var(--line); }',
    '.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }',
    'form { margin: 0; }',
    'button { width: 100%; padding: 13px 16px; cursor: pointer;',
    '  font: 600 15px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;',
    '  background: var(--go); color: var(--panel); border: 1px solid var(--go); }',
    'button:hover { opacity: .88; }',
  ].join('\n')

  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${esc(title)}</title>`,
    `<style>\n${style}\n</style>`,
    '</head>',
    `<body><div class="card">${card.join('\n')}</div></body>`,
    '</html>',
  ].join('\n')

  return { status, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html }
}
