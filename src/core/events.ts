import type { AgentsDocument } from './agents.ts'
import type { HookTarget } from './routes.ts'
import type {
  DeliveryResult,
  HookAnswer,
  HookEvent,
  Message,
  PassRecord,
  RawHook,
  SubmitResult,
} from './types.ts'

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
     * Which channels get this message, and with which mapping. Returning a list
     * takes ownership of the routing; returning nothing leaves it to the channel
     * matchers. An empty list means this hook deliberately goes nowhere.
     *
     * Dispatched with `bail`, which is synchronous, so a listener answers from
     * memory and never from a query.
     * @mode bail
     */
    'notify/target'(message: Message): HookTarget[] | undefined
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
    /**
     * One queue pass is over and the store knows about it. This is where a
     * caller waiting for its own event hears that the queue got to it, so it
     * fires after the write and not, like `notify/delivered`, during the
     * delivery itself.
     * @mode emit
     */
    'hook/processed'(id: string, pass: PassRecord, results: DeliveryResult[]): void
    /**
     * The last word on what the caller gets back. The default is the ingest's
     * own answer, so a listener that only adds something does
     * `const base = await next(); return { ...base, body: { ...base.body, mine } }`.
     *
     * Only the accepted path comes past here. A call that was refused answers
     * through `HookRejected` and never reaches this event.
     * @mode waterfall
     */
    'hook/answer'(
      answer: HookAnswer,
      event: HookEvent,
      next: () => Promise<HookAnswer>,
    ): Promise<HookAnswer>
    /**
     * What `/agents.txt` and `/agents.json` say this instance offers an agent.
     * A plugin that serves something usable adds it here instead of leaving the
     * operator to repeat it in the composition, where it would go stale.
     *
     * `origin` is the instance as this caller reached it, because the files hold
     * absolute urls.
     * @mode waterfall
     */
    'agents/declare'(
      document: AgentsDocument,
      origin: string,
      next: () => Promise<AgentsDocument>,
    ): Promise<AgentsDocument>
  }
}
