import type { DeliveryResult, HookEvent, Level } from './types.ts'

/** How an event ended up, once nothing is owed any more. */
export type Outcome = 'delivered' | 'partial' | 'failed'

export interface StoredEvent {
  event: HookEvent
  /** 'pending' while the outbox still owes attempts, 'done' once settled. */
  state: 'pending' | 'done'
  outcome: Outcome | null
  /** Outbox passes so far, not per-channel tries. */
  attempts: number
  nextAttemptAt: number | null
  /** Latest known result per channel. */
  deliveries: DeliveryResult[]
}

export interface EventQuery {
  hook?: string
  level?: Level
  state?: 'pending' | 'done'
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
  /** Distinct hook names, for the filter dropdown. */
  hooks: string[]
  outcomes: Record<string, number>
  channels: Record<string, Record<string, number>>
  oldest: number | null
  newest: number | null
}

/** What the outbox writes back after one pass. */
export interface AttemptRecord {
  state: 'pending' | 'done'
  outcome: Outcome | null
  attempts: number
  nextAttemptAt: number | null
}

/**
 * The durability seam. SQLite provides it; a Postgres provider only has to
 * satisfy this interface, which is why every method is async.
 */
export interface StoreService {
  append(event: HookEvent): Promise<void>
  get(id: string): Promise<StoredEvent | undefined>
  list(query: EventQuery): Promise<{ total: number; rows: StoredEvent[] }>
  /** Pending events whose next attempt is due. */
  due(now: number, limit: number): Promise<StoredEvent[]>
  recordAttempt(id: string, results: DeliveryResult[], record: AttemptRecord): Promise<void>
  /** Channels that already took this event, so a retry skips them. */
  sentChannels(id: string): Promise<string[]>
  /** Drop settled events received before `before`. Returns rows removed. */
  prune(before: number): Promise<number>
  stats(): Promise<StoreStats>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    store: StoreService
  }
}
