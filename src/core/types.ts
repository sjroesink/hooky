/**
 * The vocabulary every plugin agrees on. Nothing here imports cordis, so a
 * plugin can be lifted into its own package while still speaking this language.
 */

export type Level = 'debug' | 'info' | 'warning' | 'error' | 'critical'

export const LEVELS = ['debug', 'info', 'warning', 'error', 'critical'] as const

/** Position of a level on the severity scale; used for `minLevel` comparisons. */
export function rank(level: Level): number {
  return LEVELS.indexOf(level)
}

/** A request as it arrived, before anything interpreted it. */
export interface RawHook {
  /** The `:hook` segment of the request path. */
  hook: string
  /** Lower-cased header names. */
  headers: Record<string, string>
  /** Parsed body, only when the content-type announced JSON. */
  json?: Record<string, unknown>
  /** The body as text, always present (empty string for an empty body). */
  text: string
  /**
   * Set by whoever authorized this request. The ingest refuses a request that
   * nobody vouched for, so losing the auth plugin closes the door instead of
   * opening it.
   */
  authorized?: boolean
}

/** What came in, normalized. Produced by the `hook/receive` waterfall. */
export interface HookEvent {
  /** Correlation id, carried in every log line about this event. */
  id: string
  hook: string
  receivedAt: number
  level: Level
  title: string
  body?: string
  /** Where the reader can click through to. */
  url?: string
  tags: string[]
  /** The raw body, kept for normalizers and templates further down. */
  payload: unknown
  /** Id of the event this one replays, when it came from a replay. */
  replayOf?: string
}

/**
 * One way to answer a question, as a channel receives it. A channel that renders
 * these itself says so; every other channel gets them as lines under the body.
 */
export interface MessageAction {
  /** Stable name of this answer. It is in the reply url and in the answer. */
  value: string
  title: string
  url: string
  /** False for a link the caller supplied itself, which answers nothing. */
  reply: boolean
}

/** What goes out, after the `notify/render` waterfall. */
export interface Message {
  title: string
  body: string
  level: Level
  url?: string
  tags: string[]
  /** Answers to a question. Set by the ask plugin, absent on a plain message. */
  actions?: MessageAction[]
  event: HookEvent
}

/** What a channel filters on. Every field empty means everything. */
export interface Matcher {
  hooks?: string[]
  minLevel?: Level
  tags?: string[]
}

/**
 * One setting a channel accepts per target, so a form can ask for it without
 * knowing what the channel is. A Teams webhook url is the case this exists for:
 * the destination belongs to the hook, not to the composition.
 */
export interface ChannelSetting {
  key: string
  /** Shown next to the input. Defaults to the key. */
  label?: string
  /** A credential. It stays out of summaries and logs. */
  secret?: boolean
  /** Needs more than one line, such as a header block or a body template. */
  multiline?: boolean
  placeholder?: string
  hint?: string
}

/**
 * A channel says this delivery is not applicable: not sent, and not failed
 * either. Throw it from `send` when there is nothing to send to, for instance a
 * target with no destination and a row with no default. It comes back as a
 * `skipped` result, so the outbox does not schedule a pass to try again and the
 * retry policy is never asked.
 */
export class ChannelSkip extends Error {}

export interface Channel {
  /** Unique across the application; two fibers of one plugin need two names. */
  name: string
  match?: Matcher
  /** Settings this channel reads off a target, over its own config. */
  settings?: ChannelSetting[]
  /**
   * This channel renders `message.actions` itself, so the body stays what the
   * caller wrote. Declare it only when every action is shown: a channel with a
   * limit of its own is responsible for what it cannot fit, and `appendActions`
   * from `core/ask.ts` is there for the rest.
   */
  actions?: boolean
  /**
   * Rejects on failure. `signal` aborts when the owning fiber unloads.
   * `settings` is what the target carries, already validated as strings.
   */
  send(message: Message, signal: AbortSignal, settings?: Record<string, string>): Promise<void>
}

export type DeliveryResult =
  | { channel: string; status: 'sent'; attempts: number }
  | { channel: string; status: 'skipped'; reason: string }
  | { channel: string; status: 'failed'; error: string; attempts: number }

/** How an event ended up, once nothing is owed any more. */
export type Outcome = 'delivered' | 'partial' | 'failed'

/** What one queue pass left behind. */
export interface PassRecord {
  state: 'pending' | 'done'
  outcome: Outcome | null
  /** Queue passes so far, not per-channel tries. */
  attempts: number
  nextAttemptAt: number | null
}

/** What `ctx.hooks.submit` answers. */
export interface SubmitResult {
  id: string
  /** The queue still owes this event a pass. */
  queued: boolean
  /** What each channel said, as soon as anything was attempted. */
  results?: DeliveryResult[]
  /** Only when the caller waited and the queue got to it in time. */
  pass?: PassRecord
}

/**
 * What a hook call gets back. A `hook/answer` listener has the last word on it,
 * so a plugin can add a field or answer with a status of its own.
 */
export interface HookAnswer {
  status: number
  body: Record<string, unknown>
}

/** Decide whether a channel wants this message. Every channel filters through this. */
export function matches(matcher: Matcher | undefined, message: Message): boolean {
  if (!matcher) return true
  if (matcher.hooks?.length && !matcher.hooks.includes(message.event.hook)) return false
  if (matcher.minLevel && rank(message.level) < rank(matcher.minLevel)) return false
  if (matcher.tags?.length && !matcher.tags.some((tag) => message.tags.includes(tag))) return false
  return true
}

/**
 * How a set of results reads as one outcome. `alreadySent` counts the channels
 * an earlier pass reached, because they decide between `partial` and `failed`
 * just as much as this pass does. Nothing attempted at all is `null`.
 */
export function outcomeOf(results: DeliveryResult[], alreadySent = 0): Outcome {
  const sent = alreadySent + results.filter((result) => result.status === 'sent').length
  const failed = results.filter((result) => result.status === 'failed').length
  if (failed > 0) return sent > 0 ? 'partial' : 'failed'
  // No targets at all is not a failure: the hook deliberately goes nowhere.
  return sent > 0 || results.length === 0 ? 'delivered' : 'partial'
}

/** Error message without the stack, safe to put in a response body or a log line. */
export function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
