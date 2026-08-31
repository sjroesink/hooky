import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { HookEvent, Message } from '../src/core/types.ts'
import * as hooksPlugin from '../src/plugins/hooks.ts'

export function event(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    id: randomUUID(),
    hook: 'test',
    receivedAt: Date.now(),
    level: 'info',
    title: 'titel',
    tags: [],
    payload: {},
    ...overrides,
  }
}

/** A context with the two seams mounted and a list to collect messages in. */
export async function harness(): Promise<{ ctx: Context; seen: Message[] }> {
  const ctx = new Context()
  await ctx.plugin(hooksPlugin)
  return { ctx, seen: [] }
}

/** Replace global fetch for one test and hand back every call it saw. */
export function captureFetch(
  respond: (url: string, init: RequestInit) => Response = () => new Response('{}', { status: 200 }),
): { calls: { url: string; init: RequestInit }[]; restore: () => void } {
  const original = globalThis.fetch
  const calls: { url: string; init: RequestInit }[] = []
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    return respond(url, init)
  }) as typeof fetch
  return { calls, restore: () => void (globalThis.fetch = original) }
}
