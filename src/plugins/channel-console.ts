import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { MatcherSchema } from '../core/schema.ts'
import type { Matcher } from '../core/types.ts'

export const name = 'channel-console'
export const inject = ['notify']

export interface Config {
  channel: string
  match: Matcher
}

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  channel: Schema.string().default('console'),
  match: MatcherSchema,
})

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('hooky')

  ctx.notify.register({
    name: config.channel,
    match: config.match,
    async send(message) {
      const parts = [`[${message.level}] ${message.title}`]
      if (message.body) parts.push(message.body)
      if (message.url) parts.push(message.url)
      logger.info(parts.join(' | '))
    },
  })
}
