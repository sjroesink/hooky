import type { DeliveryResult, HookEvent, Message, RawHook, SubmitResult } from './types.ts'

/**
 * The pipeline, as events. Importing this file for its side effect is what makes
 * `ctx.on('hook/receive', ...)` typecheck in a plugin.
 *
 * A waterfall listener that only observes must call `next()` exactly once.
 * Returning without it is the veto, and that is how auth rejects a request.
 * Calling it twice is outside the contract: cordis consumes its listener list
 * with `shift()`, so a second call skips a listener instead of repeating the
 * chain. That is why the retry loop is a separate serial event.
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Turn a raw request into an event, or veto it by returning `null`.
     * @mode waterfall
     */
    'hook/receive'(raw: RawHook, next: () => Promise<HookEvent | null>): Promise<HookEvent | null>
    /**
     * Hand an event in. The default delivers it right away; the outbox plugin
     * takes ownership instead by returning without calling `next()`, after it
     * persisted the event.
     * @mode waterfall
     */
    'hook/submit'(event: HookEvent, next: () => Promise<SubmitResult>): Promise<SubmitResult>
    /**
     * Turn an event into the message that gets sent.
     * @mode waterfall
     */
    'notify/render'(event: HookEvent, next: () => Promise<Message>): Promise<Message>
    /**
     * Wrap the delivery of one message to one channel. Rate limiting, dedupe and
     * quiet hours live here. Retries happen inside `next()`, so one message
     * costs one slot no matter how many attempts it takes.
     * @mode waterfall
     */
    'notify/deliver'(
      message: Message,
      channel: string,
      next: () => Promise<DeliveryResult>,
    ): Promise<DeliveryResult>
    /**
     * Asked after every failed attempt. Return `true` to try again, after
     * waiting as long as you want to wait. Anything else gives up.
     * @mode serial
     */
    'notify/retry'(channel: string, error: string, attempt: number): Promise<boolean | undefined>
    /**
     * Observation only, after every channel settled.
     * @mode emit
     */
    'notify/delivered'(results: DeliveryResult[], event: HookEvent): void
  }
}
