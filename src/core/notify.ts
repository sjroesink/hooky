import { Service, type Context } from '@deepseek-ai/cordis'
import { appendActions } from './ask.ts'
import { shape } from './render.ts'
import type { HookTarget } from './routes.ts'
import {
  ChannelSkip,
  describe,
  matches,
  type Channel,
  type ChannelSetting,
  type DeliveryResult,
  type Message,
} from './types.ts'
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
   * What each channel accepts per target, for the channels that accept anything.
   * The API hands this to the UI so a target editor can ask for a Teams webhook
   * url without this file, or that form, knowing what Teams is.
   */
  get settings(): Record<string, ChannelSetting[]> {
    const out: Record<string, ChannelSetting[]> = {}
    for (const [name, channel] of this.registry) {
      if (channel.settings?.length) out[name] = channel.settings
    }
    return out
  }

  /**
   * Fan out, minus the channels a previous outbox pass already reached. One
   * failing channel does not affect the others.
   *
   * A `notify/target` listener decides where the message goes and shapes it per
   * channel. With no listener the channel matchers decide, which is what keeps
   * this service usable without the routes plugin.
   */
  async deliver(message: Message, skipChannels: string[] = []): Promise<DeliveryResult[]> {
    const routed = this.ctx.bail('notify/target', message)
    const targets = (routed ?? this.byMatcher(message)).filter(
      (target) => !skipChannels.includes(target.channel),
    )
    return Promise.all(targets.map((target) => this.deliverTo(message, target)))
  }

  /** The fallback routing: every channel that accepts the message itself. */
  private byMatcher(message: Message): HookTarget[] {
    return [...this.registry.values()]
      .filter((channel) => matches(channel.match, message))
      .map((channel) => ({ channel: channel.name }))
  }

  /**
   * One target, routing skipped. `deliver` uses it per target, and a per-target
   * run from the UI uses it to put one message through the same rate limit,
   * retry and channel a real call goes through.
   *
   * A target names a channel that may not exist, for instance because its
   * plugin is unloaded. That is a visible skip rather than silence, so the UI
   * shows why nothing arrived.
   */
  async deliverTo(message: Message, target: HookTarget): Promise<DeliveryResult> {
    const channel = this.registry.get(target.channel)
    if (!channel) {
      this.ctx.logger('notify').warn(
        `event ${message.event.id} targets channel '${target.channel}', which is not registered`,
      )
      return {
        channel: target.channel,
        status: 'skipped',
        reason: `no channel named '${target.channel}' is registered`,
      }
    }
    return this.wrap(shape(message, target.map), channel, target.settings)
  }

  private async wrap(
    message: Message,
    channel: Channel,
    settings?: Record<string, string>,
  ): Promise<DeliveryResult> {
    const shown = withActions(message, channel)
    try {
      return await this.ctx.waterfall('notify/deliver', shown, channel.name, () =>
        this.send(shown, channel, settings),
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
  private async send(
    message: Message,
    channel: Channel,
    settings?: Record<string, string>,
  ): Promise<DeliveryResult> {
    for (let attempt = 1; ; attempt++) {
      const problem = await this.attempt(message, channel, settings)
      if (!problem) return { channel: channel.name, status: 'sent', attempts: attempt }
      // The channel says there is nothing to send to. Trying again would produce
      // the same answer, so this is not a failure and the policy is not asked.
      if (problem instanceof ChannelSkip) {
        return { channel: channel.name, status: 'skipped', reason: problem.message }
      }
      const again = await this.ctx.serial('notify/retry', channel.name, problem, attempt)
      if (again !== true) {
        return { channel: channel.name, status: 'failed', error: problem, attempts: attempt }
      }
    }
  }

  /**
   * One attempt. Answers with the error message, a `ChannelSkip` the channel
   * threw, or undefined when it went out.
   */
  private async attempt(
    message: Message,
    channel: Channel,
    settings?: Record<string, string>,
  ): Promise<string | ChannelSkip | undefined> {
    const controller = new AbortController()
    let release: (() => unknown) | undefined
    try {
      // Unloading the caller aborts sends that are still in flight.
      release = this.ctx.effect(() => () => controller.abort(new Error('fiber unloaded')))
    } catch {
      // Fiber already gone. Send anyway rather than dropping the notification.
    }
    try {
      await channel.send(message, controller.signal, settings)
      return undefined
    } catch (error) {
      if (error instanceof ChannelSkip) return error
      return describe(error)
    } finally {
      release?.()
    }
  }
}

/**
 * The actions as this channel shows them. One that renders them itself keeps the
 * body the caller wrote; every other one gets them as lines under it. This runs
 * after `shape()`, so a target with a body template of its own cannot drop the
 * only way to answer, and before the waterfall, so a rate limit or a dedupe sees
 * the body that really goes out.
 */
function withActions(message: Message, channel: Channel): Message {
  if (!message.actions?.length || channel.actions) return message
  return { ...message, body: appendActions(message.body, message.actions) }
}

export default NotifyService
