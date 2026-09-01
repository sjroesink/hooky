import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { constantTimeEquals } from '../core/routes.ts'
import type {} from '../core/events.ts'

export const name = 'auth-secret'

export interface Config {
  secret: string
  header: string
  hooks: string[]
}

export const Config: Schema<Partial<Config> & { secret: string }, Config> = Schema.object({
  secret: Schema.string().required().role('secret'),
  header: Schema.string().default('x-hooky-secret'),
  hooks: Schema.array(String).default([]).description('Only guard these hooks; empty guards all of them.'),
})

/**
 * Rejects a request by returning without calling `next()`. Registered with
 * `prepend: true` because auth has to run before any normalizer, and plugins
 * load concurrently so list order in cordis.yml decides nothing.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('auth')
  const header = config.header.toLowerCase()

  ctx.on(
    'hook/receive',
    async (raw, next) => {
      if (config.hooks.length > 0 && !config.hooks.includes(raw.hook)) return next()
      if (!constantTimeEquals(raw.headers[header] ?? '', config.secret)) {
        logger.warn(`hook ${raw.hook}: missing or wrong ${header}`)
        return null
      }
      // Vouch for the request, which is what `ingest-http` requires.
      raw.authorized = true
      return next()
    },
    { prepend: true },
  )
}

