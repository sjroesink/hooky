import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {
  AttemptRecord,
  EventQuery,
  Outcome,
  StoreService,
  StoreStats,
  StoredEvent,
} from '../core/store.ts'
import type { DeliveryResult, HookEvent, Level } from '../core/types.ts'

export const name = 'store-sqlite'

export interface Config {
  path: string
  retentionDays: number
}

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  path: Schema.string().default('./data/hooky.db').description('Database file; ":memory:" for tests.'),
  retentionDays: Schema.natural()
    .default(30)
    .description('Prune settled events older than this; 0 keeps everything.'),
})

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id              TEXT PRIMARY KEY,
  hook            TEXT NOT NULL,
  level           TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT,
  url             TEXT,
  tags            TEXT NOT NULL,
  payload         TEXT NOT NULL,
  replay_of       TEXT,
  received_at     INTEGER NOT NULL,
  state           TEXT NOT NULL,
  outcome         TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER
);
CREATE INDEX IF NOT EXISTS events_received_at ON events(received_at DESC);
CREATE INDEX IF NOT EXISTS events_due ON events(state, next_attempt_at);
CREATE TABLE IF NOT EXISTS deliveries (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  channel  TEXT NOT NULL,
  status   TEXT NOT NULL,
  detail   TEXT,
  attempts INTEGER NOT NULL,
  at       INTEGER NOT NULL,
  PRIMARY KEY (event_id, channel)
);
`

interface EventRow {
  id: string
  hook: string
  level: string
  title: string
  body: string | null
  url: string | null
  tags: string
  payload: string
  replay_of: string | null
  received_at: number
  state: string
  outcome: string | null
  attempts: number
  next_attempt_at: number | null
}

interface DeliveryRow {
  event_id: string
  channel: string
  status: string
  detail: string | null
  attempts: number
}

class SqliteStore extends Service implements StoreService {
  private db: DatabaseSync
  private insertEvent: StatementSync
  private upsertDelivery: StatementSync
  private updateState: StatementSync

  constructor(ctx: Context, config: Config) {
    super(ctx, 'store')
    const file = config.path === ':memory:' ? ':memory:' : resolve(process.cwd(), config.path)
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)

    this.insertEvent = this.db.prepare(
      `INSERT INTO events (id, hook, level, title, body, url, tags, payload, replay_of,
                           received_at, state, outcome, attempts, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, 0, 0)`,
    )
    this.upsertDelivery = this.db.prepare(
      `INSERT INTO deliveries (event_id, channel, status, detail, attempts, at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id, channel) DO UPDATE SET
         status = excluded.status, detail = excluded.detail,
         attempts = excluded.attempts, at = excluded.at`,
    )
    this.updateState = this.db.prepare(
      'UPDATE events SET state = ?, outcome = ?, attempts = ?, next_attempt_at = ? WHERE id = ?',
    )
  }

  /** Closing the handle is an effect, so a reload does not leak the file lock. */
  register(): void {
    this.ctx.effect(() => () => this.db.close(), 'store.close()')
  }

  async append(event: HookEvent): Promise<void> {
    this.insertEvent.run(
      event.id,
      event.hook,
      event.level,
      event.title,
      event.body ?? null,
      event.url ?? null,
      JSON.stringify(event.tags),
      JSON.stringify(event.payload ?? null),
      event.replayOf ?? null,
      event.receivedAt,
    )
  }

  async get(id: string): Promise<StoredEvent | undefined> {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as unknown as EventRow | undefined
    if (!row) return undefined
    return this.hydrate([row])[0]
  }

  async list(query: EventQuery): Promise<{ total: number; rows: StoredEvent[] }> {
    const where: string[] = []
    const params: (string | number)[] = []
    const add = (clause: string, ...values: (string | number)[]) => {
      where.push(clause)
      params.push(...values)
    }
    if (query.hook) add('hook = ?', query.hook)
    if (query.level) add('level = ?', query.level)
    if (query.state) add('state = ?', query.state)
    if (query.outcome) add('outcome = ?', query.outcome)
    if (query.since) add('received_at >= ?', query.since)
    if (query.until) add('received_at <= ?', query.until)
    if (query.search) add('(title LIKE ? OR body LIKE ?)', `%${query.search}%`, `%${query.search}%`)
    if (query.channel) {
      add(
        'EXISTS (SELECT 1 FROM deliveries d WHERE d.event_id = events.id AND d.channel = ?)',
        query.channel,
      )
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''

    const counted = this.db.prepare(`SELECT COUNT(*) AS n FROM events ${clause}`).get(...params) as unknown as {
      n: number
    }
    const rows = this.db
      .prepare(`SELECT * FROM events ${clause} ORDER BY received_at DESC LIMIT ? OFFSET ?`)
      .all(...params, query.limit, query.offset) as unknown as EventRow[]
    return { total: counted.n, rows: this.hydrate(rows) }
  }

  async due(now: number, limit: number): Promise<StoredEvent[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM events
         WHERE state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY received_at ASC LIMIT ?`,
      )
      .all(now, limit) as unknown as EventRow[]
    return this.hydrate(rows)
  }

  async recordAttempt(id: string, results: DeliveryResult[], record: AttemptRecord): Promise<void> {
    const at = Date.now()
    for (const result of results) {
      const detail =
        result.status === 'failed'
          ? result.error
          : result.status === 'skipped'
            ? result.reason
            : null
      this.upsertDelivery.run(
        id,
        result.channel,
        result.status,
        detail,
        result.status === 'skipped' ? 0 : result.attempts,
        at,
      )
    }
    this.updateState.run(record.state, record.outcome, record.attempts, record.nextAttemptAt, id)
  }

  async sentChannels(id: string): Promise<string[]> {
    const rows = this.db
      .prepare("SELECT channel FROM deliveries WHERE event_id = ? AND status = 'sent'")
      .all(id) as unknown as { channel: string }[]
    return rows.map((row) => row.channel)
  }

  async prune(before: number): Promise<number> {
    const result = this.db
      .prepare("DELETE FROM events WHERE state = 'done' AND received_at < ?")
      .run(before)
    return Number(result.changes)
  }

  async stats(): Promise<StoreStats> {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS events,
                SUM(CASE WHEN state = 'pending' THEN 1 ELSE 0 END) AS pending,
                MIN(received_at) AS oldest, MAX(received_at) AS newest
         FROM events`,
      )
      .get() as unknown as {
      events: number
      pending: number | null
      oldest: number | null
      newest: number | null
    }

    const outcomes: Record<string, number> = {}
    const outcomeRows = this.db
      .prepare("SELECT COALESCE(outcome, 'open') AS key, COUNT(*) AS n FROM events GROUP BY key")
      .all() as unknown as { key: string; n: number }[]
    for (const row of outcomeRows) {
      outcomes[row.key] = row.n
    }

    const hooks = (
      this.db.prepare('SELECT DISTINCT hook FROM events ORDER BY hook').all() as unknown as {
        hook: string
      }[]
    ).map((row) => row.hook)

    const channels: Record<string, Record<string, number>> = {}
    const channelRows = this.db
      .prepare('SELECT channel, status, COUNT(*) AS n FROM deliveries GROUP BY channel, status')
      .all() as unknown as { channel: string; status: string; n: number }[]
    for (const row of channelRows) {
      const bucket = (channels[row.channel] ??= {})
      bucket[row.status] = row.n
    }

    return {
      events: totals.events,
      pending: totals.pending ?? 0,
      hooks,
      outcomes,
      channels,
      oldest: totals.oldest,
      newest: totals.newest,
    }
  }

  private hydrate(rows: EventRow[]): StoredEvent[] {
    if (rows.length === 0) return []
    const placeholders = rows.map(() => '?').join(', ')
    const deliveries = this.db
      .prepare(`SELECT * FROM deliveries WHERE event_id IN (${placeholders}) ORDER BY channel`)
      .all(...rows.map((row) => row.id)) as unknown as DeliveryRow[]

    const byEvent = new Map<string, DeliveryResult[]>()
    for (const row of deliveries) {
      const result: DeliveryResult =
        row.status === 'sent'
          ? { channel: row.channel, status: 'sent', attempts: row.attempts }
          : row.status === 'skipped'
            ? { channel: row.channel, status: 'skipped', reason: row.detail ?? '' }
            : {
                channel: row.channel,
                status: 'failed',
                error: row.detail ?? '',
                attempts: row.attempts,
              }
      const list = byEvent.get(row.event_id) ?? []
      list.push(result)
      byEvent.set(row.event_id, list)
    }

    return rows.map((row) => ({
      event: {
        id: row.id,
        hook: row.hook,
        level: row.level as Level,
        title: row.title,
        body: row.body ?? undefined,
        url: row.url ?? undefined,
        tags: JSON.parse(row.tags) as string[],
        payload: JSON.parse(row.payload) as unknown,
        replayOf: row.replay_of ?? undefined,
        receivedAt: row.received_at,
      },
      state: row.state as 'pending' | 'done',
      outcome: (row.outcome as Outcome | null) ?? null,
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      deliveries: byEvent.get(row.id) ?? [],
    }))
  }
}

export function apply(ctx: Context, config: Config): void {
  const store = new SqliteStore(ctx, config)
  store.register()
  if (config.retentionDays > 0) {
    const cutoff = Date.now() - config.retentionDays * 86_400_000
    void store.prune(cutoff).then((removed) => {
      if (removed > 0) ctx.logger('store').info(`pruned ${removed} settled event(s)`)
    })
  }
}
