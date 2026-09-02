import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { assertOk } from '../core/http.ts'
import { envelopeOf } from '../core/render.ts'
import { MatcherSchema } from '../core/schema.ts'
import { interpolate } from '../core/template.ts'
import {
  ChannelSkip,
  type ChannelSetting,
  type HookEvent,
  type Matcher,
  type Message,
} from '../core/types.ts'

export const name = 'channel-webhook'
export const inject = ['notify']

const METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'GET'] as const
type Method = (typeof METHODS)[number]

export interface Config {
  channel: string
  url: string
  method: Method
  headers: string
  body: string
  timeoutMs: number
  match: Matcher
}

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  channel: Schema.string().default('webhook'),
  url: Schema.string()
    .default('')
    .description(
      'Default destination, for when every hook calls the same one. Normally empty: a url is a destination, so it belongs on the target.',
    ),
  method: Schema.union(METHODS)
    .default('POST')
    .description('Method for a target that does not name one.'),
  headers: Schema.string()
    .default('')
    .role('textarea')
    .description(
      'Headers every target sends, one `name: value` per line. A target adds to this and overrides a name it repeats.',
    ),
  body: Schema.string()
    .default('')
    .role('textarea')
    .description(
      'Body template for a target that does not bring one. Empty means the event as JSON, the same shape the sse channel streams.',
    ),
  timeoutMs: Schema.natural().default(10_000),
  match: MatcherSchema,
})

/**
 * What a target may set for itself. All four are the point of this channel: the
 * destination, the method, the headers and the body are exactly what differs per
 * hook, and none of them belong in the composition.
 */
export const SETTINGS: ChannelSetting[] = [
  {
    key: 'url',
    label: 'url',
    placeholder: 'https://n8n.example/webhook/deploys',
    hint: 'Where this target posts. Templates work, so {{payload.callbackUrl}} lets the caller name its own destination. Only do that on a hook whose callers you trust.',
  },
  {
    key: 'method',
    label: 'method',
    placeholder: 'POST',
    hint: 'POST, PUT, PATCH, DELETE or GET. A GET carries no body.',
  },
  {
    key: 'headers',
    label: 'headers',
    secret: true,
    multiline: true,
    placeholder: 'authorization: Bearer …\nx-source: hooky',
    hint: 'One `name: value` per line, templates included. This is where a token goes, which is why it counts as a credential.',
  },
  {
    key: 'body',
    label: 'body',
    multiline: true,
    placeholder: '{"text": "{{title}}", "build": "{{payload.buildId}}"}',
    hint: 'Templated. Values land JSON-escaped for a JSON content type, so a quote in a title cannot break the body. Empty sends the event as JSON.',
  },
]

/**
 * A hook that calls another webhook. One row, and every hook says for itself
 * where it posts, with which method, which headers and which body, because that
 * is what differs between an n8n flow, a Home Assistant endpoint and somebody
 * else's API.
 *
 * The body is a template over the message as this target shaped it, so a `map`
 * and a body template compose. Leave it empty and the event goes out as JSON in
 * the same shape the sse channel streams, which is the right thing for a program
 * on the other end.
 *
 * Two things to know. The url may be a template, and a url out of the payload
 * hands the choice of destination to whoever posts to that hook. And a webhook
 * pointed at another hook on this same instance is a loop: every outgoing call
 * carries `x-hooky-event`, so the receiving side can see what it is answering.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.notify.register({
    name: config.channel,
    match: config.match,
    settings: SETTINGS,
    // The answers to a question go out as structured data in the default body,
    // so there is nothing to append to a body somebody else wrote.
    actions: true,
    async send(message, signal, settings) {
      const scope = scopeFor(message)
      const url = interpolate(pick(settings?.['url'], config.url), scope).trim()
      // Nowhere to post is not a failure: retrying finds the same nowhere.
      if (url === '') {
        throw new ChannelSkip(`no url: set one on this target, or a default on the ${config.channel} row`)
      }
      const target = urlOf(url)
      const method = methodOf(pick(settings?.['method'], config.method))
      const template = pick(settings?.['body'], config.body)

      const headers = {
        'user-agent': 'hooky',
        'x-hooky-event': message.event.id,
        'x-hooky-hook': message.event.hook,
        ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
        ...headersFrom(config.headers, scope),
        ...headersFrom(settings?.['headers'] ?? '', scope),
      }

      const response = await fetch(target, {
        method,
        headers,
        ...(method === 'GET'
          ? {}
          : { body: bodyFor(template, headers['content-type'] ?? '', message, scope) }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
      })
      await assertOk(response, config.channel)
    },
  })
}

/** A target's own value, or the row's default when the target says nothing. */
function pick(own: string | undefined, fallback: string): string {
  const trimmed = own?.trim() ?? ''
  return trimmed === '' ? fallback : trimmed
}

/**
 * What a template sees: the message as this target shaped it, over the event it
 * came from. So a `map.title` and a body template agree instead of the template
 * quietly reading the title from before the map.
 */
function scopeFor(message: Message): HookEvent {
  return {
    ...message.event,
    title: message.title,
    body: message.body,
    level: message.level,
    ...(message.url === undefined ? {} : { url: message.url }),
    tags: message.tags,
  }
}

/**
 * A misconfigured target is a skip and not a failure. A typo in the method or in
 * a header line is not going to fix itself on the fourth attempt, and a skip
 * says what is wrong where somebody will read it.
 */
export function urlOf(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ChannelSkip(`'${url}' is not a url: it needs a scheme and a host`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ChannelSkip(`'${url}' is not http or https`)
  }
  return parsed
}

export function methodOf(value: string): Method {
  const wanted = value.trim().toUpperCase()
  const found = METHODS.find((method) => method === wanted)
  if (!found) throw new ChannelSkip(`'${value}' is not one of ${METHODS.join(', ')}`)
  return found
}

/**
 * `name: value` per line, templates in the value. A blank line and a `#` comment
 * are skipped, so a header block can be annotated.
 *
 * A newline out of a template is replaced by a space rather than sent: a value
 * that carries one would otherwise write a header of its own, and a payload is
 * not allowed to decide what headers go out.
 */
export function headersFrom(block: string, scope: HookEvent): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const raw of block.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const cut = line.indexOf(':')
    if (cut <= 0) throw new ChannelSkip(`'${line}' is not a header: write one 'name: value' per line`)
    const name = line.slice(0, cut).trim().toLowerCase()
    headers[name] = interpolate(line.slice(cut + 1).trim(), scope).replace(/[\r\n]+/g, ' ')
  }
  return headers
}

/** The body, from the template or from the event when there is no template. */
export function bodyFor(
  template: string,
  contentType: string,
  message: Message,
  scope: HookEvent,
): string {
  if (template === '') return JSON.stringify(envelopeOf(message))
  return interpolate(template, scope, escaperFor(contentType))
}

/**
 * How a value is written into the body. A JSON body breaks on a quote in a
 * title, so a value lands JSON-escaped without its quotes; a form body needs
 * percent-encoding; anything else goes in as it is, because that is what a plain
 * text body means.
 */
export function escaperFor(contentType: string): ((value: string) => string) | undefined {
  const type = contentType.toLowerCase()
  if (type.includes('json')) return (value) => JSON.stringify(value).slice(1, -1)
  if (type.includes('x-www-form-urlencoded')) return encodeURIComponent
  return undefined
}
