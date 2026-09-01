import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { StoredEvent } from '../core/store.ts'
import { describe, outcomeOf, type DeliveryResult, type PassRecord } from '../core/types.ts'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type {} from '../core/events.ts'

export const name = 'outbox'
export const inject = ['store', 'hooks', 'timer']

export interface Config {
  attempts: number
  baseDelayMs: number
  maxDelayMs: number
  batch: number
  pollMs: number
}

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  attempts: Schema.natural().default(8).description('Outbox passes before an event is given up on.'),
  baseDelayMs: Schema.natural().default(30_000),
  maxDelayMs: Schema.natural().default(3_600_000),
  batch: Schema.natural().default(20).description('Events picked up per sweep.'),
  pollMs: Schema.natural().default(15_000).description('How often to look for work that is due.'),
})

/**
 * Durability, as a plugin. It takes ownership of `hook/submit` by returning
 * without calling `next()`: the event is persisted and answered immediately,
 * and delivery happens here. Unload this plugin and the pipeline falls back to
 * delivering inside the request, with nothing else changing.
 *
 * The retry plugin covers seconds inside one attempt. This covers hours and
 * survives a restart, because the queue is the events table.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('outbox')
  let running = false
  let again = false

  ctx.on('hook/submit', async (event) => {
    await ctx.store.append(event)
    void sweep()
    return { id: event.id, queued: true }
  })

  async function sweep(): Promise<void> {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      // Bounded, so a store that keeps handing back the same row cannot spin.
      for (let round = 0; round < 100; round++) {
        const due = await ctx.store.due(Date.now(), config.batch)
        if (due.length === 0) break
        for (const row of due) await pass(row)
      }
    } catch (error) {
      logger.error(error)
    } finally {
      running = false
      if (again) {
        again = false
        void sweep()
      }
    }
  }

  async function pass(row: StoredEvent): Promise<void> {
    const attempts = row.attempts + 1
    let results
    try {
      const skip = await ctx.store.sentChannels(row.event.id)
      results = await ctx.hooks.dispatch(row.event, { skipChannels: skip })
    } catch (error) {
      // Nothing was attempted, so give the event another pass rather than losing it.
      results = [{ channel: '-', status: 'failed' as const, error: describe(error), attempts: 1 }]
    }

    const failed = results.filter((result) => result.status === 'failed')
    const earlier = await ctx.store.sentChannels(row.event.id)

    const record = settle(row, attempts, results, failed.length, earlier.length)
    await ctx.store.recordAttempt(row.event.id, results, record)
    // After the write, so a caller waiting for this event reads a store that
    // already knows how the pass went.
    ctx.emit('hook/processed', row.event.id, record, results)
  }

  /** What this pass leaves behind: settled, given up on, or due again later. */
  function settle(
    row: StoredEvent,
    attempts: number,
    results: DeliveryResult[],
    failed: number,
    earlier: number,
  ): PassRecord {
    if (failed === 0) {
      return { state: 'done', outcome: outcomeOf(results, earlier), attempts, nextAttemptAt: null }
    }
    if (attempts >= config.attempts) {
      logger.warn(
        `event ${row.event.id} gave up after ${attempts} pass(es); ${failed} channel(s) never took it`,
      )
      return { state: 'done', outcome: outcomeOf(results, earlier), attempts, nextAttemptAt: null }
    }
    const delay = Math.min(config.baseDelayMs * 2 ** (attempts - 1), config.maxDelayMs)
    logger.warn(
      `event ${row.event.id} pass ${attempts} left ${failed} channel(s) failing, next pass in ${Math.round(delay / 1000)}s`,
    )
    // No outcome yet: it is not settled, it is waiting.
    return { state: 'pending', outcome: null, attempts, nextAttemptAt: Date.now() + delay }
  }

  // Both are effects: the interval stops and the kickoff is cancelled on unload.
  ctx.interval(() => void sweep(), config.pollMs)
  ctx.timeout(() => void sweep(), 0)
}
