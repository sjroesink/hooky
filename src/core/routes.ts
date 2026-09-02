/**
 * Hooks as data. A hook has a name, its own secret and a list of targets; a
 * target names a channel and, optionally, what the message to that channel
 * looks like. Definitions live in the store, so adding a hook is an API call
 * and not a config edit.
 *
 * `cordis.yml` stays about what the application can do: which plugins run and
 * which channels exist. This layer decides what it does with them.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { DeliveryResult, Level, Matcher, Message } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    routes: RoutesService
  }
}

/** Per target: what goes from this event to this channel. */
export interface MessageMap {
  /** Template; `{{title}}` and `{{payload.a.b}}` resolve against the event. */
  title?: string
  body?: string
  url?: string
  /** Fixed override, not a template: the level decides ntfy priority and Telegram sound. */
  level?: Level
  /** Templates as well; replaces the event's tags when given. */
  tags?: string[]
}

export interface HookTarget {
  /** A registered channel name, so `telegram` or `telegram-oncall`. */
  channel: string
  map?: MessageMap
  /** Extra filter inside the hook, e.g. only from `error` up to this channel. */
  match?: Matcher
  /**
   * Channel settings for this target only, over whatever the channel row
   * configures. Which keys mean something is the channel's business: it declares
   * them as `ChannelSetting[]` and reads them in `send`. This is where a Teams
   * webhook url lives, so one hook can post in another Teams channel than the
   * next without a second plugin row.
   */
  settings?: Record<string, string>
}

export interface HookDefinition {
  name: string
  description?: string
  disabled: boolean
  /** SHA-256 of the secret, or null for an open hook. Never the secret itself. */
  secretHash: string | null
  /**
   * The moment this hook stops accepting calls, in epoch ms. Absent means it
   * never does. Past it the definition stays where it is and answers 410, so a
   * temporary hook goes quiet on its own without taking its history with it.
   */
  expiresAt?: number
  targets: HookTarget[]
  createdAt: number
  updatedAt: number
}

export interface HookInput {
  name: string
  description?: string
  disabled?: boolean
  expiresAt?: number
  targets?: HookTarget[]
  /** A secret to use, or `false` for an open hook. Omitted means: generate one. */
  secret?: string | false
}

export interface HookPatch {
  description?: string
  disabled?: boolean
  /** A moment in epoch ms, or null to take the expiry off again. */
  expiresAt?: number | null
  /** Replaces the whole list. Use setTarget/removeTarget for one target. */
  targets?: HookTarget[]
}

/** A message with its map applied, as the channel receives it. */
export interface ShapedMessage {
  title: string
  body: string
  level: Level
  url?: string
  tags: string[]
}

/** What a dry run answers per target. */
export interface Preview {
  channel: string
  /** Absent when this target does not want the event, or its channel is gone. */
  message?: ShapedMessage
  /** Why nothing would be sent to this channel. */
  skipped?: string
}

/**
 * What one real run answers: what went out, and what the channel said about it.
 * `result` is absent exactly when `skipped` says why nothing was attempted.
 */
export interface RunResult extends Preview {
  result?: DeliveryResult
}

/** Why a request was refused, so the caller can pick a status code. */
export type AuthVerdict = 'ok' | 'unknown' | 'disabled' | 'expired' | 'refused'

/**
 * The hook registry. Reads are synchronous because the secret check runs inside
 * a request; writes go to the store and update the same cache.
 */
export interface RoutesService {
  list(): HookDefinition[]
  get(name: string): HookDefinition | undefined
  /** The generated secret comes back here once and is never readable again. */
  create(input: HookInput): Promise<{ hook: HookDefinition; secret?: string }>
  update(name: string, patch: HookPatch): Promise<HookDefinition>
  setTarget(name: string, target: HookTarget): Promise<HookDefinition>
  removeTarget(name: string, channel: string): Promise<HookDefinition>
  rotate(name: string): Promise<{ hook: HookDefinition; secret: string }>
  remove(name: string): Promise<boolean>
  /**
   * Remove every hook whose moment has passed. Returns the names removed.
   * Cleaning up is a thing you do: an expiry stops a hook by itself, but
   * nothing deletes a definition on a timer.
   */
  pruneExpired(now?: number): Promise<string[]>
  /** Replace every definition, for `hooks import`. Returns the count written. */
  replaceAll(hooks: HookDefinition[]): Promise<number>
  /** Dry run: the resolved message per target, without sending anything. */
  preview(name: string, payload: unknown): Promise<Preview[]>
  /**
   * Send this payload to one target for real, routing skipped. `override`
   * replaces that target's map and match for this run only, so an edit can be
   * tried before it is saved. Nothing is written and nothing is queued.
   */
  run(name: string, channel: string, payload: unknown, override?: Partial<HookTarget>): Promise<RunResult>
  /** Targets for this message, or undefined when no hook defines its name. */
  targetsFor(message: Message): HookTarget[] | undefined
  /** Does this hook accept this secret? */
  authorize(name: string, provided: string): AuthVerdict
}

/** Thrown by the service so the API can answer 404 without string matching. */
export class NoSuchHook extends Error {
  name = 'NoSuchHook'

  constructor(hook: string) {
    super(`no hook named '${hook}'`)
  }
}

/** Thrown on a create that would overwrite, so the API can answer 409. */
export class HookExists extends Error {
  name = 'HookExists'

  constructor(hook: string) {
    super(`hook '${hook}' already exists`)
  }
}

/** Thrown when the hook has no target for that channel, so the API can answer 404. */
export class NoSuchTarget extends Error {
  name = 'NoSuchTarget'

  constructor(hook: string, channel: string) {
    super(`hook '${hook}' has no target for channel '${channel}'`)
  }
}

/**
 * Drop what a schema filled in. Schemastery gives an absent array a `[]`, and an
 * empty `tags` in a map would otherwise wipe the event's tags, so inside a
 * target an empty value means "leave this alone" and never "make this empty".
 */
export function tidyTarget(target: HookTarget): HookTarget {
  const tidied: HookTarget = { channel: target.channel }
  const map = tidyMap(target.map)
  if (map) tidied.map = map
  const match = tidyMatch(target.match)
  if (match) tidied.match = match
  const settings = tidySettings(target.settings)
  if (settings) tidied.settings = settings
  return tidied
}

/** An empty value is not a setting: it means "use what the channel row says". */
function tidySettings(settings: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!settings) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(settings)) {
    const trimmed = String(value ?? '').trim()
    if (trimmed !== '') out[key] = trimmed
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function tidyMap(map: MessageMap | undefined): MessageMap | undefined {
  if (!map) return undefined
  const out: MessageMap = {}
  if (map.title) out.title = map.title
  if (map.body) out.body = map.body
  if (map.url) out.url = map.url
  if (map.level) out.level = map.level
  if (map.tags?.length) out.tags = map.tags
  return Object.keys(out).length > 0 ? out : undefined
}

/** A matcher that accepts everything is the same as no matcher. */
function tidyMatch(match: Matcher | undefined): Matcher | undefined {
  if (!match) return undefined
  const out: Matcher = {}
  if (match.hooks?.length) out.hooks = match.hooks
  if (match.minLevel && match.minLevel !== 'debug') out.minLevel = match.minLevel
  if (match.tags?.length) out.tags = match.tags
  return Object.keys(out).length > 0 ? out : undefined
}

/** Is this hook past its moment? A hook without one never is. */
export function hasExpired(hook: HookDefinition, now = Date.now()): boolean {
  return hook.expiresAt !== undefined && hook.expiresAt <= now
}

/**
 * When a hook should stop accepting calls, from whatever the caller wrote.
 * `2h`, `30m`, `7d` and `90s` are counted from now, a number is an epoch in ms,
 * and anything else is read as a date. `null`, `false` and an empty string mean
 * no expiry at all, which is how one is taken off again.
 *
 * Throws on input it cannot read, so the API can answer 400 instead of quietly
 * making a hook that dies in 1970.
 */
export function parseExpiry(input: unknown, now = Date.now()): number | undefined {
  if (input === undefined || input === null || input === false || input === '') return undefined
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) throw new Error(`'${input}' is not a moment in time`)
    return Math.trunc(input)
  }
  if (typeof input !== 'string') throw new Error('an expiry is a duration like 2h, an epoch in ms, or a date')
  const text = input.trim()
  const relative = /^(\d+)\s*([smhdw])$/i.exec(text)
  if (relative) {
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[
      relative[2]!.toLowerCase() as 's' | 'm' | 'h' | 'd' | 'w'
    ]
    return now + Number(relative[1]) * unit
  }
  if (/^\d+$/.test(text)) return parseExpiry(Number(text), now)
  const parsed = Date.parse(text)
  if (Number.isNaN(parsed)) {
    throw new Error(`'${text}' is not a duration like 2h or 7d, an epoch in ms, or a date`)
  }
  return parsed
}

/** A fresh secret. Prefixed so it is recognizable in a log or a paste. */
export function newSecret(): string {
  return `hk_${randomBytes(24).toString('base64url')}`
}

/** The stored form. The secret itself is never written anywhere. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

/** Compare two strings through their digests: constant time, no length leak. */
export function constantTimeEquals(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest()
  const b = createHash('sha256').update(right).digest()
  return timingSafeEqual(a, b)
}

/** A `null` hash is an open hook, which accepts anything including no header. */
export function secretMatches(provided: string, hash: string | null): boolean {
  if (hash === null) return true
  return constantTimeEquals(hashSecret(provided), hash)
}
