import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Entry, EntryOptions, EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { RouteRequest, RouteResponse } from '../core/server.ts'
import type { EventQuery, Outcome, StoredEvent } from '../core/store.ts'
import { LEVELS, describe, type HookEvent, type Level } from '../core/types.ts'
import type {} from '../core/events.ts'

export const name = 'api'
// `loader` is deliberately not injected: reading history must work in a
// composition that has no loader, so the plugin endpoints probe for it instead.
export const inject = ['server', 'store', 'notify', 'hooks']

export interface Config {
  prefix: string
  secret: string
}

export const Config: Schema<Partial<Config> & { secret: string }, Config> = Schema.object({
  prefix: Schema.string().default('/api'),
  secret: Schema.string().required().role('secret').description('Sent as a bearer token by the UI and the CLI.'),
})

class NoLoader extends Error {}

/**
 * `FiberState` is a const enum, so it has no runtime value to import. These are
 * its numbers, from the cordis typings.
 */
const FIBER_STATE = ['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'] as const

/**
 * Entries the UI must not offer a switch for: the config entry carries every
 * other row, and these two are what the page itself is talking to.
 */
const CRITICAL = ['/ui.ts', '/api.ts']

/**
 * One read and write surface for both the UI and the CLI. It exposes the store
 * for history and `ctx.loader` for the composition, so enabling a channel or
 * changing its config is an API call that also lands in cordis.yml.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('api')
  const base = config.prefix.replace(/\/+$/, '')

  const route = (method: string, path: string, handler: (request: RouteRequest) => Promise<RouteResponse>) => {
    ctx.server.route(method, `${base}${path}`, async (request) => {
      if (!authorized(request, config.secret)) {
        return { status: 401, body: { error: 'unauthorized' } }
      }
      try {
        return await handler(request)
      } catch (error) {
        if (error instanceof NoLoader) {
          return { status: 503, body: { error: 'no loader in this composition' } }
        }
        logger.error(error)
        return { status: 500, body: { error: describe(error) } }
      }
    })
  }

  route('GET', '/describe', async () => ({ status: 200, body: describeApi(base) }))

  route('GET', '/stats', async () => ({
    status: 200,
    body: { ...(await ctx.store.stats()), channels_registered: ctx.notify.names },
  }))

  route('GET', '/events', async (request) => {
    const params = request.query
    const query: EventQuery = {
      limit: clamp(Number(params.get('limit') ?? 50), 1, 500),
      offset: Math.max(0, Number(params.get('offset') ?? 0)),
    }
    const hook = params.get('hook')
    if (hook) query.hook = hook
    const level = params.get('level')
    if (level && (LEVELS as readonly string[]).includes(level)) query.level = level as Level
    const state = params.get('state')
    if (state === 'pending' || state === 'done') query.state = state
    const outcome = params.get('outcome')
    if (outcome === 'delivered' || outcome === 'partial' || outcome === 'failed') {
      query.outcome = outcome as Outcome
    }
    const channel = params.get('channel')
    if (channel) query.channel = channel
    const search = params.get('search')
    if (search) query.search = search
    const since = params.get('since')
    if (since) query.since = parseSince(since)
    const result = await ctx.store.list(query)
    return {
      status: 200,
      body: {
        total: result.total,
        limit: query.limit,
        offset: query.offset,
        events: result.rows.map(view),
      },
    }
  })

  route('GET', '/events/:id', async (request) => {
    const found = await ctx.store.get(request.params['id']!)
    if (!found) return { status: 404, body: { error: 'no such event' } }
    return { status: 200, body: { ...view(found), payload: found.event.payload } }
  })

  route('POST', '/events/:id/replay', async (request) => {
    const found = await ctx.store.get(request.params['id']!)
    if (!found) return { status: 404, body: { error: 'no such event' } }
    const replay: HookEvent = {
      ...found.event,
      id: randomUUID(),
      receivedAt: Date.now(),
      replayOf: found.event.id,
    }
    const result = await ctx.hooks.submit(replay)
    return { status: 202, body: result }
  })

  route('POST', '/send', async (request) => {
    const input = json(request.body)
    const hook = typeof input['hook'] === 'string' ? input['hook'] : 'manual'
    const level = typeof input['level'] === 'string' && (LEVELS as readonly string[]).includes(input['level'])
      ? (input['level'] as Level)
      : 'info'
    const event: HookEvent = {
      id: randomUUID(),
      hook,
      receivedAt: Date.now(),
      level,
      title: typeof input['title'] === 'string' && input['title'] ? input['title'] : hook,
      body: typeof input['body'] === 'string' ? input['body'] : undefined,
      url: typeof input['url'] === 'string' ? input['url'] : undefined,
      tags: Array.isArray(input['tags']) ? input['tags'].filter((tag) => typeof tag === 'string') : [],
      payload: input,
    }
    return { status: 202, body: await ctx.hooks.submit(event) }
  })

  route('GET', '/channels', async () => ({
    status: 200,
    body: { channels: ctx.notify.names, stats: (await ctx.store.stats()).channels },
  }))

  route('GET', '/plugins', async () => {
    const loader = ctx.get('loader')
    if (!loader) return { status: 503, body: { error: 'no loader in this composition' } }
    return { status: 200, body: { plugins: [...loader.entries()].map(describeEntry) } }
  })

  route('POST', '/plugins', async (request) => {
    const input = json(request.body)
    if (typeof input['name'] !== 'string') {
      return { status: 400, body: { error: 'name is required' } }
    }
    const tree = persistent()
    const options = {
      name: input['name'],
      config: input['config'] ?? {},
      ...(input['disabled'] === true ? { disabled: true } : {}),
      ...(typeof input['id'] === 'string' ? { id: input['id'] } : {}),
    } as Omit<EntryOptions, 'id'>

    // `tree.create()` only resolves ids from the root loader, so mount through
    // the group itself and then link the row and persist it.
    const id = await tree.root.create(options)
    const entry = loaderOrThrow().resolve(id)
    if (!tree.root.data.includes(entry.options)) tree.root.data.push(entry.options)
    tree.write()
    logger.info(`created plugin entry ${id} (${input['name']})`)
    return { status: 201, body: { id, plugin: describeEntry(entry) } }
  })

  route('PATCH', '/plugins/:id', async (request) => {
    const id = request.params['id']!
    const entry = find(id)
    if (!entry) return { status: 404, body: { error: 'no such plugin entry' } }
    const input = json(request.body)
    const patch: { config?: unknown; disabled?: boolean | null } = {}
    if ('config' in input) {
      // Merge per key, so a `!!js` expression in an untouched key keeps its raw form.
      patch.config = { ...(entry.options.config ?? {}), ...(input['config'] as object) }
    }
    if ('disabled' in input) patch.disabled = input['disabled'] === true ? true : null
    await loaderOrThrow().update(id, patch)
    logger.info(`updated plugin entry ${id}`)
    return { status: 200, body: { id, plugin: describeEntry(find(id)!) } }
  })

  route('POST', '/plugins/:id/remount', async (request) => {
    const id = request.params['id']!
    const entry = find(id)
    if (!entry) return { status: 404, body: { error: 'no such plugin entry' } }
    await entry.refresh()
    logger.info(`remounted plugin entry ${id}`)
    return { status: 200, body: { id, plugin: describeEntry(entry) } }
  })

  route('DELETE', '/plugins/:id', async (request) => {
    const id = request.params['id']!
    const entry = find(id)
    if (!entry) return { status: 404, body: { error: 'no such plugin entry' } }
    // Not `ctx.loader.remove(id)`: that hands the subtree-prefixed id to
    // EntryGroup.remove, which looks up the plain row id in its store, finds
    // nothing and reports success without removing anything.
    await entry.parent.remove(entry.options.id)
    entry.parent.tree.write()
    logger.info(`removed plugin entry ${id}`)
    return { status: 200, body: { id, removed: find(id) === undefined } }
  })

  /**
   * cordis.yml rows live in the subtree of the include entry. Creating in the
   * loader root would mount the plugin but never write it down, so a new row
   * goes into that subtree.
   */
  function persistent(): EntryTree {
    for (const entry of loaderOrThrow().entries()) {
      if (entry.subtree) return entry.subtree
    }
    return loaderOrThrow()
  }

  /** Throws a 503-shaped error when the composition has no loader. */
  function loaderOrThrow() {
    const loader = ctx.get('loader')
    if (!loader) throw new NoLoader()
    return loader
  }

  function find(id: string): Entry | undefined {
    for (const entry of loaderOrThrow().entries()) {
      if (entry.id === id) return entry
    }
    return undefined
  }

  function describeEntry(entry: Entry) {
    const state = entry.fiber?.state
    return {
      id: entry.id,
      name: entry.options.name,
      disabled: entry.disabled,
      state: state === undefined ? 'unmounted' : (FIBER_STATE[state] ?? String(state)),
      config: entry.options.config ?? null,
      critical: entry.subtree !== undefined || CRITICAL.some((tail) => entry.options.name.endsWith(tail)),
    }
  }
}

function view(stored: StoredEvent) {
  return {
    id: stored.event.id,
    hook: stored.event.hook,
    level: stored.event.level,
    title: stored.event.title,
    body: stored.event.body ?? null,
    url: stored.event.url ?? null,
    tags: stored.event.tags,
    receivedAt: stored.event.receivedAt,
    replayOf: stored.event.replayOf ?? null,
    state: stored.state,
    outcome: stored.outcome,
    attempts: stored.attempts,
    nextAttemptAt: stored.nextAttemptAt,
    deliveries: stored.deliveries,
  }
}

function authorized(request: RouteRequest, secret: string): boolean {
  const header = request.headers['authorization'] ?? ''
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7) : ''
  const provided = bearer || request.headers['x-hooky-secret'] || ''
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(secret).digest()
  return timingSafeEqual(a, b)
}

function json(body: string): Record<string, unknown> {
  if (!body) return {}
  const parsed: unknown = JSON.parse(body)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** Accepts an epoch in ms, or a relative form like `30m`, `2h`, `7d`. */
export function parseSince(input: string): number {
  const relative = /^(\d+)([smhd])$/.exec(input.trim())
  if (relative) {
    const amount = Number(relative[1])
    const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as 's' | 'm' | 'h' | 'd']
    return Date.now() - amount * unit
  }
  const epoch = Number(input)
  if (Number.isFinite(epoch)) return epoch
  const parsed = Date.parse(input)
  return Number.isNaN(parsed) ? 0 : parsed
}

/** Machine-readable catalog, so an agent can learn the surface in one call. */
function describeApi(base: string) {
  return {
    auth: 'Authorization: Bearer <secret>, or x-hooky-secret',
    endpoints: [
      { method: 'GET', path: `${base}/describe`, use: 'this catalog' },
      { method: 'GET', path: `${base}/stats`, use: 'counts per outcome and per channel' },
      {
        method: 'GET',
        path: `${base}/events`,
        query: ['hook', 'level', 'state', 'outcome', 'channel', 'search', 'since', 'limit', 'offset'],
        use: 'webhook calls, newest first',
      },
      { method: 'GET', path: `${base}/events/:id`, use: 'one call including its payload' },
      { method: 'POST', path: `${base}/events/:id/replay`, use: 'submit a copy as a new event' },
      {
        method: 'POST',
        path: `${base}/send`,
        body: { hook: 'string', title: 'string', body: 'string?', level: LEVELS, url: 'string?', tags: 'string[]?' },
        use: 'send a notification without going through a webhook',
      },
      { method: 'GET', path: `${base}/channels`, use: 'registered channels and their delivery counts' },
      { method: 'GET', path: `${base}/plugins`, use: 'loader entries with fiber state and config' },
      { method: 'POST', path: `${base}/plugins`, body: { name: 'string', config: 'object?', disabled: 'boolean?' }, use: 'mount a plugin and write it to cordis.yml' },
      { method: 'PATCH', path: `${base}/plugins/:id`, body: { config: 'object?', disabled: 'boolean?' }, use: 'reconfigure or disable an entry; config merges per key' },
      { method: 'POST', path: `${base}/plugins/:id/remount`, use: 'reload an entry, for one stuck in failed' },
      { method: 'DELETE', path: `${base}/plugins/:id`, use: 'unmount and remove an entry' },
    ],
    levels: LEVELS,
    outcomes: ['delivered', 'partial', 'failed'],
  }
}
