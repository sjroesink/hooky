import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { postJson } from '../core/http.ts'
import { MatcherSchema } from '../core/schema.ts'
import type { Level, Matcher } from '../core/types.ts'

export const name = 'channel-ntfy'
export const inject = ['notify']

export interface Config {
  channel: string
  server: string
  topic: string
  token: string
  tags: string[]
  timeoutMs: number
  match: Matcher
}

export const Config: Schema<Partial<Config> & { topic: string }, Config> = Schema.object({
  channel: Schema.string().default('ntfy'),
  server: Schema.string().default('https://ntfy.sh'),
  topic: Schema.string().required(),
  token: Schema.string().default('').role('secret').description('Access token for a protected topic.'),
  tags: Schema.array(String).default([]).description('Extra ntfy tags, merged with the message tags.'),
  timeoutMs: Schema.natural().default(10_000),
  match: MatcherSchema,
})

/** ntfy priorities: 1 min, 3 default, 5 max. */
const PRIORITY: Record<Level, number> = {
  debug: 1,
  info: 3,
  warning: 4,
  error: 5,
  critical: 5,
}

export function apply(ctx: Context, config: Config): void {
  ctx.notify.register({
    name: config.channel,
    match: config.match,
    async send(message, signal) {
      await postJson({
        // The publish-as-JSON form. The header form needs RFC 2047 encoding for
        // anything outside ASCII, and this way that problem does not exist.
        url: `${config.server.replace(/\/+$/, '')}/`,
        payload: {
          topic: config.topic,
          title: message.title,
          message: message.body || message.title,
          priority: PRIORITY[message.level],
          tags: [...config.tags, ...message.tags],
          markdown: true,
          ...(message.url ? { click: message.url } : {}),
        },
        headers: config.token ? { authorization: `Bearer ${config.token}` } : {},
        signal,
        timeoutMs: config.timeoutMs,
        label: 'ntfy',
      })
    },
  })
}
