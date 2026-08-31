import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '../core/events.ts'

export const name = 'retry'
export const inject = ['timer']

export interface Config {
  attempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  attempts: Schema.natural().default(3).description('Total attempts, the first one included.'),
  baseDelayMs: Schema.natural().default(500),
  maxDelayMs: Schema.natural().default(8_000),
})

/**
 * Answers `notify/retry` with the backoff. `ctx.timeout` rejects when this
 * fiber unloads, so a reload never leaves a retry loop running behind it.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('retry')

  ctx.on('notify/retry', async (channel, error, attempt) => {
    if (attempt >= config.attempts) {
      logger.warn(`${channel} gave up after ${attempt} attempt(s): ${error}`)
      return undefined
    }
    const delay = Math.min(config.baseDelayMs * 2 ** (attempt - 1), config.maxDelayMs)
    logger.warn(`${channel} attempt ${attempt} failed (${error}), retrying in ${delay}ms`)
    try {
      await ctx.timeout(delay)
    } catch {
      return undefined
    }
    return true
  })
}
