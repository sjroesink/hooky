import type { HookDefinition } from './routes.ts'
import type { DeliveryResult, HookEvent, Level, Outcome, PassRecord } from './types.ts'

/** Why a call never entered the pipeline. */
export interface Rejection {
  /** What the caller got: 404 for a name nobody defined, 410 for a hook that is off. */
  status: number
  reason: string
}

export interface StoredEvent {
  event: HookEvent
  /**
   * 'pending' while the outbox still owes attempts, 'done' once settled, and
   * 'rejected' for a call no hook took. A rejected row is never delivered and
   * never retried; it is kept so you can see what arrived and define the hook.
   */
  state: 'pending' | 'done' | 'rejected'
  outcome: Outcome | null
  /** Outbox passes so far, not per-channel tries. */
  attempts: number
  nextAttemptAt: number | null
  /** Latest known result per channel. */
  deliveries: DeliveryResult[]
  /** Set for a rejected call, absent for every other state. */
  rejection?: Rejection
}

export interface EventQuery {
  hook?: string
  level?: Level
  state?: 'pending' | 'done' | 'rejected'
  outcome?: Outcome
  /** Only events that have a record for this channel. */
  channel?: string
  since?: number
  until?: number
  /** Substring of title or body. */
  search?: string
  limit: number
  offset: number
}

export interface StoreStats {
  events: number
  pending: number
  /** Calls kept for a hook that was not defined or was switched off. */
  rejected: number
  /** Distinct hook names, for the filter dropdown. */
  hooks: string[]
  outcomes: Record<string, number>
  channels: Record<string, Record<string, number>>
  oldest: number | null
  newest: number | null
}

/**
 * The durability seam. SQLite provides it; a Postgres provider only has to
 * satisfy this interface, which is why every method is async.
 */
export interface StoreService {
  append(event: HookEvent): Promise<void>
  /**
   * Keep a call that no hook took. The ingest path is public, so this is capped:
   * past the cap the oldest rejected call makes room for the newest.
   */
  reject(event: HookEvent, rejection: Rejection): Promise<void>
  get(id: string): Promise<StoredEvent | undefined>
  list(query: EventQuery): Promise<{ total: number; rows: StoredEvent[] }>
  /** Pending events whose next attempt is due. */
  due(now: number, limit: number): Promise<StoredEvent[]>
  recordAttempt(id: string, results: DeliveryResult[], record: PassRecord): Promise<void>
  /** Channels that already took this event, so a retry skips them. */
  sentChannels(id: string): Promise<string[]>
  /** Drop settled events received before `before`. Returns rows removed. */
  prune(before: number): Promise<number>
  stats(): Promise<StoreStats>

  /** Hook definitions. Read once at mount; the routes service caches them. */
  listHooks(): Promise<HookDefinition[]>
  saveHook(hook: HookDefinition): Promise<void>
  removeHook(name: string): Promise<boolean>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    store: StoreService
  }
}
