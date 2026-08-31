import { Service, type Context } from '@deepseek-ai/cordis'
import { describe, matches, type Channel, type DeliveryResult, type Message } from './types.ts'
import type {} from './events.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    notify: NotifyService
  }
}

/**
 * The delivery seam. Channels register here; nothing in this file knows what a
 * Telegram or an ntfy request looks like.
 */
export class NotifyService extends Service {
  // TS `private`, not `#private`: the service is reached through a proxy that
  // rebinds `this.ctx`, and a `#field` brand check fails on a proxy receiver.
  private registry = new Map<string, Channel>()

  constructor(ctx: Context) {
    super(ctx, 'notify')
  }

  /**
   * Register a channel. `this.ctx` is the caller's context here, so the disposer
   * hangs on the registering plugin's fiber and the channel leaves with it.
   */
  register(channel: Channel): () => Promise<void> {
    return this.ctx.effect(() => {
      if (this.registry.has(channel.name)) {
        throw new Error(`channel '${channel.name}' is already registered`)
      }
      this.registry.set(channel.name, channel)
      return () => {
        this.registry.delete(channel.name)
      }
    }, `ctx.notify.register(${channel.name})`)
  }

  /** Names of the channels currently registered, in registration order. */
  get names(): string[] {
    return [...this.registry.keys()]
  }

  /**
   * Fan out to every channel whose matcher accepts the message, minus the ones
   * a previous outbox pass already reached. One failing channel does not affect
   * the others.
   */
  async deliver(message: Message, skipChannels: string[] = []): Promise<DeliveryResult[]> {
    const targets = [...this.registry.values()].filter(
      (channel) => !skipChannels.includes(channel.name) && matches(channel.match, message),
    )
    return Promise.all(targets.map((channel) => this.wrap(message, channel)))
  }

  private async wrap(message: Message, channel: Channel): Promise<DeliveryResult> {
    try {
      return await this.ctx.waterfall('notify/deliver', message, channel.name, () =>
        this.send(message, channel),
      )
    } catch (error) {
      // A listener threw instead of returning a result.
      return { channel: channel.name, status: 'failed', error: describe(error), attempts: 0 }
    }
  }

  /**
   * The innermost `next` of the waterfall: attempt the send, and keep attempting
   * while a `notify/retry` listener says to. The loop lives here so the policy
   * plugin does not have to call `next()` more than once.
   */
  private async send(message: Message, channel: Channel): Promise<DeliveryResult> {
    for (let attempt = 1; ; attempt++) {
      const error = await this.attempt(message, channel)
      if (!error) return { channel: channel.name, status: 'sent', attempts: attempt }
      const again = await this.ctx.serial('notify/retry', channel.name, error, attempt)
      if (again !== true) {
        return { channel: channel.name, status: 'failed', error, attempts: attempt }
      }
    }
  }

  /** One attempt. Returns the error message, or undefined when it went out. */
  private async attempt(message: Message, channel: Channel): Promise<string | undefined> {
    const controller = new AbortController()
    let release: (() => unknown) | undefined
    try {
      // Unloading the caller aborts sends that are still in flight.
      release = this.ctx.effect(() => () => controller.abort(new Error('fiber unloaded')))
    } catch {
      // Fiber already gone. Send anyway rather than dropping the notification.
    }
    try {
      await channel.send(message, controller.signal)
      return undefined
    } catch (error) {
      return describe(error)
    } finally {
      release?.()
    }
  }
}

export default NotifyService
