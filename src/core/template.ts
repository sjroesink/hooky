/**
 * The templating behind a target's `map`. No dependency and no expressions: a
 * `{{path}}` is looked up in the event and that is the only thing that can
 * happen, which is what makes it safe to store a template in the database and
 * edit it over the API.
 */
import type { HookEvent } from './types.ts'

const PLACEHOLDER = /\{\{\s*([\w.$-]+)\s*\}\}/g

/** Everything a template can reach. `message` is an alias for the body. */
export function scopeOf(event: HookEvent): Record<string, unknown> {
  return {
    id: event.id,
    hook: event.hook,
    level: event.level,
    title: event.title,
    body: event.body ?? '',
    message: event.body ?? '',
    url: event.url ?? '',
    tags: event.tags,
    receivedAt: event.receivedAt,
    payload: event.payload,
  }
}

/** Replace every `{{path}}`. A path that resolves to nothing becomes empty. */
export function interpolate(template: string, event: HookEvent): string {
  const scope = scopeOf(event)
  return template.replace(PLACEHOLDER, (_match, path: string) => stringify(lookup(scope, path)))
}

/** Names a template can use, for an error message or a UI hint. */
export function paths(event: HookEvent): string[] {
  return Object.keys(scopeOf(event))
}

/** Walks a dotted path, array indices included. Anything missing is undefined. */
function lookup(scope: Record<string, unknown>, path: string): unknown {
  let current: unknown = scope
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** A value in a message is text: arrays join, objects become compact JSON. */
function stringify(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (Array.isArray(value)) return value.map((item) => stringify(item)).join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
