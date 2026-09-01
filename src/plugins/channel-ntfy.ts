import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { postJson } from '../core/http.ts'
import { MatcherSchema } from '../core/schema.ts'
import { ChannelSkip, type ChannelSetting, type Level, type Matcher } from '../core/types.ts'

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

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  channel: Schema.string().default('ntfy'),
  server: Schema.string().default('https://ntfy.sh'),
  topic: Schema.string()
    .default('')
    .description(
      'Default topic, for when every hook publishes to the same one. Leave it empty and set the topic per target instead.',
    ),
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

/**
 * What a target may set for itself. A topic is a destination, so it belongs to
 * the hook: one row, and every hook publishes where it wants.
 */
export const SETTINGS: ChannelSetting[] = [
  {
    key: 'topic',
    label: 'topic',
    placeholder: 'my-alerts',
    hint: 'The ntfy topic this target publishes to. Anyone who knows a topic can read it, so make it hard to guess.',
  },
  {
    key: 'server',
    label: 'server',
    placeholder: 'https://ntfy.sh',
    hint: 'Only for a target on another instance than the row.',
  },
  {
    key: 'token',
    label: 'access token',
    secret: true,
    hint: 'For a protected topic the token on the row does not cover.',
  },
]

export function apply(ctx: Context, config: Config): void {
  ctx.notify.register({
    name: config.channel,
    match: config.match,
    settings: SETTINGS,
    async send(message, signal, settings) {
      const topic = settings?.['topic']?.trim() || config.topic
      // Nothing to publish to is not a failure: retrying finds the same nothing.
      if (topic === '') {
        throw new ChannelSkip('no topic: set one on this target, or a default on the ntfy row')
      }
      const server = settings?.['server']?.trim() || config.server
      const token = settings?.['token']?.trim() || config.token
      await postJson({
        // The publish-as-JSON form. The header form needs RFC 2047 encoding for
        // anything outside ASCII, and this way that problem does not exist.
        url: `${server.replace(/\/+$/, '')}/`,
        payload: {
          topic,
          title: message.title,
          message: message.body || message.title,
          priority: PRIORITY[message.level],
          tags: [...config.tags, ...message.tags],
          markdown: true,
          ...(message.url ? { click: message.url } : {}),
        },
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal,
        timeoutMs: config.timeoutMs,
        label: 'ntfy',
      })
    },
  })
}
