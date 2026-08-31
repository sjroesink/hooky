import { randomUUID } from 'node:crypto'
import { LEVELS, type HookEvent, type Level, type RawHook } from './types.ts'

/** Rejection that carries the status code the caller should see. */
export class HookRejected extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'HookRejected'
    this.status = status
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function level(value: unknown): Level {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value)
    ? (value as Level)
    : 'info'
}

/**
 * The default behind the `hook/receive` waterfall: read the fields a caller is
 * expected to send. A source-specific normalizer plugin replaces this for
 * payloads that look nothing like it.
 */
export function normalize(raw: RawHook): HookEvent {
  const json = raw.json ?? {}
  return {
    id: randomUUID(),
    hook: raw.hook,
    receivedAt: Date.now(),
    level: level(json['level']),
    title: text(json['title']) ?? raw.hook,
    body: text(json['message']) ?? text(json['body']) ?? (raw.json ? undefined : text(raw.text)),
    url: text(json['url']),
    tags: Array.isArray(json['tags']) ? json['tags'].filter((tag) => typeof tag === 'string') : [],
    payload: raw.json ?? raw.text,
  }
}
