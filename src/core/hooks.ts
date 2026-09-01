import { Service, type Context } from '@deepseek-ai/cordis'
import { render } from './render.ts'
import type { DeliveryResult, HookEvent, PassRecord, SubmitResult } from './types.ts'
import type {} from './events.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    hooks: HooksService
  }
}

export interface DispatchOptions {
  /** Channels to leave alone, because a previous pass already reached them. */
  skipChannels?: string[]
}

export interface SubmitOptions {
  /**
   * Wait this long for the queue to process the event, so the caller hears what
   * the channels said. 0 answers as soon as the event is safe, which is what a
   * caller that only fires and forgets wants.
   */
  waitMs?: number
}

/** What a waiting caller hears back: the pass, and what the channels said. */
interface Processed {
  pass: PassRecord
  results: DeliveryResult[]
}

/**
 * The ingest seam. HTTP is one source; a cron or mail plugin calls the same
 * `submit()`, which is why this file has no idea a request exists.
 */
export class HooksService extends Service {
  static inject = ['notify']

  /** Callers waiting for their own event, by id. One listener fills them. */
  private waiting = new Map<string, (processed: Processed | undefined) => void>()

  constructor(ctx: Context) {
    super(ctx, 'hooks')

    this.ctx.on('hook/processed', (id, pass, results) => {
      this.waiting.get(id)?.({ pass, results })
    })

    // A fiber that goes away must not leave a request hanging on a promise.
    this.ctx.effect(() => () => {
      for (const settle of this.waiting.values()) settle(undefined)
      this.waiting.clear()
    })
  }

  /**
   * Hand an event in and let the composition decide what happens. With the
   * outbox plugin loaded the event is persisted first; with nothing listening it
   * is delivered before this resolves.
   *
   * `waitMs` bridges the two: the event is queued as always, and this waits for
   * the queue to come round to it before answering. A wait that runs out loses
   * nothing, because the outbox owns the event either way.
   */
  async submit(event: HookEvent, options: SubmitOptions = {}): Promise<SubmitResult> {
    // Registered before the waterfall runs: the outbox starts its sweep inside
    // its own listener, so the pass can be over before `submit` resolves.
    const waiter = options.waitMs ? this.expect(event.id, options.waitMs) : undefined
    try {
      const result = await this.ctx.waterfall('hook/submit', event, async () => ({
        id: event.id,
        queued: false,
        results: await this.dispatch(event),
      }))
      if (!waiter || !result.queued) return result

      const processed = await waiter.answer
      if (!processed) return result
      return {
        id: event.id,
        queued: processed.pass.state === 'pending',
        results: processed.results,
        pass: processed.pass,
      }
    } finally {
      waiter?.cancel()
    }
  }

  /** Render and deliver, here and now. */
  async dispatch(event: HookEvent, options: DispatchOptions = {}): Promise<DeliveryResult[]> {
    const message = await this.ctx.waterfall('notify/render', event, async () => render(event))
    const results = await this.ctx.notify.deliver(message, options.skipChannels)
    this.ctx.emit('notify/delivered', results, event)
    return results
  }

  /**
   * Watch for the queue processing one event. The answer is undefined when it
   * did not happen within `waitMs`, or when this fiber unloaded first.
   */
  private expect(id: string, waitMs: number) {
    let settle: (processed: Processed | undefined) => void = () => {}
    const answer = new Promise<Processed | undefined>((resolve) => {
      settle = resolve
    })
    this.waiting.set(id, settle)
    const timer = setTimeout(() => settle(undefined), waitMs)
    const cancel = () => {
      clearTimeout(timer)
      this.waiting.delete(id)
    }
    // Whatever settles it, the bookkeeping goes with it.
    void answer.then(cancel)
    return { answer, cancel }
  }
}

export default HooksService
