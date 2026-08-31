import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '../core/events.ts'

export const name = 'rate-limit'

export interface Config {
  perChannel: number
  windowMs: number
}

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  perChannel: Schema.natural().default(20),
  windowMs: Schema.natural().default(60_000),
})

/**
 * Sliding window per channel. Prepended, so it sits outside the retry loop: one
 * message costs one slot however many attempts it needs.
 */
export function apply(ctx: Context, config: Config): void {
  const hits = new Map<string, number[]>()
  ctx.effect(() => () => hits.clear())

  ctx.on(
    'notify/deliver',
    async (message, channel, next) => {
      const now = Date.now()
      const recent = (hits.get(channel) ?? []).filter((at) => now - at < config.windowMs)
      if (recent.length >= config.perChannel) {
        hits.set(channel, recent)
        return {
          channel,
          status: 'skipped',
          reason: `rate limited at ${config.perChannel} per ${config.windowMs}ms`,
        }
      }
      recent.push(now)
      hits.set(channel, recent)
      return next()
    },
    { prepend: true },
  )
}
