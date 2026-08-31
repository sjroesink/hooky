import { Service, type Context } from '@deepseek-ai/cordis'
import { render } from './render.ts'
import type { DeliveryResult, HookEvent, SubmitResult } from './types.ts'
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

/**
 * The ingest seam. HTTP is one source; a cron or mail plugin calls the same
 * `submit()`, which is why this file has no idea a request exists.
 */
export class HooksService extends Service {
  static inject = ['notify']

  constructor(ctx: Context) {
    super(ctx, 'hooks')
  }

  /**
   * Hand an event in and let the composition decide what happens. With the
   * outbox plugin loaded the event is persisted and answered immediately; with
   * nothing listening it is delivered before this resolves.
   */
  async submit(event: HookEvent): Promise<SubmitResult> {
    return this.ctx.waterfall('hook/submit', event, async () => ({
      id: event.id,
      queued: false as const,
      results: await this.dispatch(event),
    }))
  }

  /** Render and deliver, here and now. */
  async dispatch(event: HookEvent, options: DispatchOptions = {}): Promise<DeliveryResult[]> {
    const message = await this.ctx.waterfall('notify/render', event, async () => render(event))
    const results = await this.ctx.notify.deliver(message, options.skipChannels)
    this.ctx.emit('notify/delivered', results, event)
    return results
  }
}

export default HooksService
