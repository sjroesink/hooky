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

/** What goes out, after the `notify/render` waterfall. */
export interface Message {
  title: string
  body: string
  level: Level
  url?: string
  tags: string[]
  event: HookEvent
}

/** What a channel filters on. Every field empty means everything. */
export interface Matcher {
  hooks?: string[]
  minLevel?: Level
  tags?: string[]
}

export interface Channel {
  /** Unique across the application; two fibers of one plugin need two names. */
  name: string
  match?: Matcher
  /** Rejects on failure. `signal` aborts when the owning fiber unloads. */
  send(message: Message, signal: AbortSignal): Promise<void>
}

export type DeliveryResult =
  | { channel: string; status: 'sent'; attempts: number }
  | { channel: string; status: 'skipped'; reason: string }
  | { channel: string; status: 'failed'; error: string; attempts: number }

/** What `ctx.hooks.submit` answers: taken by the outbox, or already delivered. */
export type SubmitResult =
  | { id: string; queued: true }
  | { id: string; queued: false; results: DeliveryResult[] }

/** Decide whether a channel wants this message. Every channel filters through this. */
export function matches(matcher: Matcher | undefined, message: Message): boolean {
  if (!matcher) return true
  if (matcher.hooks?.length && !matcher.hooks.includes(message.event.hook)) return false
  if (matcher.minLevel && rank(message.level) < rank(matcher.minLevel)) return false
  if (matcher.tags?.length && !matcher.tags.some((tag) => message.tags.includes(tag))) return false
  return true
}

/** Error message without the stack, safe to put in a response body or a log line. */
export function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
