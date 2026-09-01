import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { Entry, EntryOptions, EntryTree } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { RouteRequest, RouteResponse } from '../core/server.ts'
import {
  HookExists,
  NoSuchHook,
  NoSuchTarget,
  constantTimeEquals,
  type HookDefinition,
  type HookPatch,
  type HookTarget,
} from '../core/routes.ts'
import { HookTargetSchema } from '../core/schema.ts'
import type { EventQuery, StoredEvent } from '../core/store.ts'
import { LEVELS, describe, type HookEvent, type Level, type Outcome } from '../core/types.ts'
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
class NoRoutes extends Error {}
/** A request that is shaped wrong, as opposed to one that failed. */
class BadRequest extends Error {}

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
        if (error instanceof NoRoutes) {
          return { status: 503, body: { error: 'no routes plugin in this composition' } }
        }
        if (error instanceof NoSuchHook) return { status: 404, body: { error: error.message } }
        if (error instanceof NoSuchTarget) return { status: 404, body: { error: error.message } }
        if (error instanceof HookExists) return { status: 409, body: { error: error.message } }
        if (error instanceof BadRequest) return { status: 400, body: { error: error.message } }
        logger.error(error)
        return { status: 500, body: { error: describe(error) } }
      }
    })
  }

  route('GET', '/describe', async () => ({ status: 200, body: describeApi(base) }))

  route('GET', '/stats', async () => ({
    status: 200,
    body: {
      ...(await ctx.store.stats()),
      channels_registered: ctx.notify.names,
      // Definitions that exist right now, so a caller can tell a rejected call
      // that is still stuck from one whose hook has since been defined.
      hooks_defined: ctx.get('routes')?.list().map((hook) => hook.name) ?? [],
    },
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
    if (state === 'pending' || state === 'done' || state === 'rejected') query.state = state
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
    if (found.state === 'rejected') {
      // Nothing took this call the first time. Replaying it before the hook
      // exists would queue an event that can only be rejected again.
      const hook = ctx.get('routes')?.get(found.event.hook)
      if (!hook) {
        return {
          status: 409,
          body: { error: `no hook named '${found.event.hook}', so this call still has nowhere to go` },
        }
      }
      if (hook.disabled) {
        return { status: 409, body: { error: `hook '${found.event.hook}' is switched off` } }
      }
    }
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
    body: {
      channels: ctx.notify.names,
      // Per channel, the settings a target may carry. Empty for a channel that
      // takes everything from its own row.
      settings: ctx.notify.settings,
      stats: (await ctx.store.stats()).channels,
    },
  }))

  /* ---------------- hooks ---------------- */

  route('GET', '/hooks', async (request) => {
    // A backup asks for the hash and wants the definitions as they are, so it
    // gets no `missing` flag: that is a fact about right now, not about the hook.
    const hash = request.query.get('include') === 'hash'
    const channels = hash ? undefined : new Set(ctx.notify.names)
    return {
      status: 200,
      body: { hooks: routesOrThrow().list().map((hook) => hookView(hook, { hash, channels })) },
    }
  })

  /** Replace every definition; this is what `hooks import` sends. */
  route('PUT', '/hooks', async (request) => {
    const input = json(request.body)
    const rows = input['hooks']
    if (!Array.isArray(rows)) throw new BadRequest('body must be { "hooks": [...] }')
    const written = await routesOrThrow().replaceAll(rows.map((row) => definitionFrom(row)))
    logger.warn(`replaced the hook table with ${written} definition(s)`)
    return { status: 200, body: { hooks: written } }
  })

  route('GET', '/hooks/:name', async (request) => {
    const channels = new Set(ctx.notify.names)
    return { status: 200, body: hookView(demand(request.params['name']!), { channels }) }
  })

  route('POST', '/hooks', async (request) => {
    const input = json(request.body)
    const created = await routesOrThrow().create({
      name: typeof input['name'] === 'string' ? input['name'] : '',
      description: typeof input['description'] === 'string' ? input['description'] : undefined,
      disabled: input['disabled'] === true,
      targets: targetsFrom(input['targets']),
      secret:
        input['secret'] === false
          ? false
          : typeof input['secret'] === 'string'
            ? input['secret']
            : undefined,
    })
    logger.info(`created hook '${created.hook.name}'`)
    return {
      status: 201,
      body:
        created.secret === undefined
          ? { hook: hookView(created.hook), open: true }
          : { hook: hookView(created.hook), secret: created.secret, note: 'shown once, not stored' },
    }
  })

  route('PATCH', '/hooks/:name', async (request) => {
    const input = json(request.body)
    const patch: HookPatch = {}
    if ('description' in input) {
      patch.description = typeof input['description'] === 'string' ? input['description'] : undefined
    }
    if ('disabled' in input) patch.disabled = input['disabled'] === true
    if ('targets' in input) patch.targets = targetsFrom(input['targets']) ?? []
    const hook = await routesOrThrow().update(request.params['name']!, patch)
    logger.info(`updated hook '${hook.name}'`)
    return { status: 200, body: hookView(hook) }
  })

  route('PUT', '/hooks/:name/targets/:channel', async (request) => {
    const target = targetFrom({ ...json(request.body), channel: request.params['channel'] })
    const hook = await routesOrThrow().setTarget(request.params['name']!, target)
    logger.info(`hook '${hook.name}' now targets ${target.channel}`)
    return { status: 200, body: hookView(hook) }
  })

  route('DELETE', '/hooks/:name/targets/:channel', async (request) => {
    const channel = request.params['channel']!
    const hook = await routesOrThrow().removeTarget(request.params['name']!, channel)
    logger.info(`hook '${hook.name}' no longer targets ${channel}`)
    return { status: 200, body: hookView(hook) }
  })

  route('POST', '/hooks/:name/rotate', async (request) => {
    const rotated = await routesOrThrow().rotate(request.params['name']!)
    logger.warn(`rotated the secret of hook '${rotated.hook.name}'`)
    return {
      status: 200,
      body: { hook: hookView(rotated.hook), secret: rotated.secret, note: 'shown once, not stored' },
    }
  })

  route('POST', '/hooks/:name/preview', async (request) => {
    const name = request.params['name']!
    const payload = request.body ? json(request.body) : {}
    return { status: 200, body: { hook: name, targets: await routesOrThrow().preview(name, payload) } }
  })

  /**
   * A real send to one channel, so a Telegram target actually buzzes. `map`,
   * `match` and `settings` in the body replace the stored ones for this run
   * only, which is how the UI tries an edit before saving it. Nothing is stored
   * and nothing is queued: the answer is the whole record of the attempt.
   */
  route('POST', '/hooks/:name/targets/:channel/run', async (request) => {
    const name = request.params['name']!
    const channel = request.params['channel']!
    const input = request.body ? json(request.body) : {}
    const validated = targetFrom({
      channel,
      ...(input['map'] === undefined ? {} : { map: input['map'] }),
      ...(input['match'] === undefined ? {} : { match: input['match'] }),
      ...(input['settings'] === undefined ? {} : { settings: input['settings'] }),
    })
    // Only the keys the caller sent: an absent `map` keeps the stored mapping,
    // while `map: {}` is a deliberate "no mapping for this run".
    const override: Partial<HookTarget> = {
      ...(input['map'] === undefined ? {} : { map: validated.map }),
      ...(input['match'] === undefined ? {} : { match: validated.match }),
      ...(input['settings'] === undefined ? {} : { settings: validated.settings }),
    }
    const run = await routesOrThrow().run(name, channel, input['payload'] ?? {}, override)
    logger.info(`ran hook '${name}' to ${channel}: ${run.result?.status ?? `skipped, ${run.skipped}`}`)
    return { status: 200, body: { hook: name, ...run } }
  })

  route('DELETE', '/hooks/:name', async (request) => {
    const name = request.params['name']!
    demand(name)
    await routesOrThrow().remove(name)
    logger.info(`removed hook '${name}'`)
    return { status: 200, body: { name, removed: true } }
  })

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

  /** Throws a 503-shaped error when the composition has no routes plugin. */
  function routesOrThrow() {
    const routes = ctx.get('routes')
    if (!routes) throw new NoRoutes()
    return routes
  }

  function demand(name: string): HookDefinition {
    const hook = routesOrThrow().get(name)
    if (!hook) throw new NoSuchHook(name)
    return hook
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

/** Never the secret, and never the hash unless it was asked for by name. */
function hookView(hook: HookDefinition, options: { hash?: boolean; channels?: Set<string> } = {}) {
  return {
    name: hook.name,
    description: hook.description ?? null,
    disabled: hook.disabled,
    hasSecret: hook.secretHash !== null,
    ...(options.hash ? { secretHash: hook.secretHash } : {}),
    targets: hook.targets.map((target) =>
      options.channels ? { ...target, missing: !options.channels.has(target.channel) } : target,
    ),
    createdAt: hook.createdAt,
    updatedAt: hook.updatedAt,
  }
}

/** One target, through the same schema the seed config uses. */
function targetFrom(input: unknown): HookTarget {
  try {
    return HookTargetSchema(input as Partial<HookTarget> & { channel: string })
  } catch (error) {
    throw new BadRequest(describe(error))
  }
}

function targetsFrom(input: unknown): HookTarget[] | undefined {
  if (input === undefined) return undefined
  if (!Array.isArray(input)) throw new BadRequest('targets must be an array')
  return input.map((entry) => targetFrom(entry))
}

/** A definition as `hooks export` produced it, hash included. */
function definitionFrom(input: unknown): HookDefinition {
  if (typeof input !== 'object' || input === null) throw new BadRequest('a hook must be an object')
  const row = input as Record<string, unknown>
  if (typeof row['name'] !== 'string' || row['name'] === '') {
    throw new BadRequest('a hook needs a name')
  }
  const now = Date.now()
  return {
    name: row['name'],
    description: typeof row['description'] === 'string' ? row['description'] : undefined,
    disabled: row['disabled'] === true,
    secretHash: typeof row['secretHash'] === 'string' ? row['secretHash'] : null,
    targets: targetsFrom(row['targets']) ?? [],
    createdAt: typeof row['createdAt'] === 'number' ? row['createdAt'] : now,
    updatedAt: typeof row['updatedAt'] === 'number' ? row['updatedAt'] : now,
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
    rejection: stored.rejection ?? null,
  }
}

function authorized(request: RouteRequest, secret: string): boolean {
  const header = request.headers['authorization'] ?? ''
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7) : ''
  const provided = bearer || request.headers['x-hooky-secret'] || ''
  return constantTimeEquals(provided, secret)
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
      {
        method: 'POST',
        path: `${base}/events/:id/replay`,
        use: 'submit a copy as a new event; 409 for a rejected call whose hook is still undefined',
      },
      {
        method: 'POST',
        path: `${base}/send`,
        body: { hook: 'string', title: 'string', body: 'string?', level: LEVELS, url: 'string?', tags: 'string[]?' },
        use: 'send a notification without going through a webhook',
      },
      {
        method: 'GET',
        path: `${base}/channels`,
        use: 'registered channels, the settings each accepts per target, and their delivery counts',
      },
      {
        method: 'GET',
        path: `${base}/hooks`,
        query: ['include=hash'],
        use: 'defined hooks with their targets; a target says which channel gets what',
      },
      {
        method: 'PUT',
        path: `${base}/hooks`,
        body: { hooks: 'HookDefinition[]' },
        use: 'replace every definition, for restoring a backup',
      },
      { method: 'GET', path: `${base}/hooks/:name`, use: 'one hook' },
      {
        method: 'POST',
        path: `${base}/hooks`,
        body: {
          name: 'string',
          description: 'string?',
          disabled: 'boolean?',
          targets: 'HookTarget[]?',
          secret: 'string | false, omit to generate one',
        },
        use: 'define a hook; the secret comes back once and is stored as a hash',
      },
      {
        method: 'PATCH',
        path: `${base}/hooks/:name`,
        body: { description: 'string?', disabled: 'boolean?', targets: 'HookTarget[]?' },
        use: 'change a hook; targets replaces the whole list',
      },
      {
        method: 'PUT',
        path: `${base}/hooks/:name/targets/:channel`,
        body: {
          map: '{ title?, body?, url?: template, level?: Level, tags?: template[] }',
          match: '{ minLevel?: Level, tags?: string[] }',
          settings: 'channel settings for this target, e.g. { webhook } for teams; see GET /channels',
        },
        use: 'add one channel to a hook and say what it receives',
      },
      { method: 'DELETE', path: `${base}/hooks/:name/targets/:channel`, use: 'remove one channel' },
      { method: 'POST', path: `${base}/hooks/:name/rotate`, use: 'new secret, shown once' },
      {
        method: 'POST',
        path: `${base}/hooks/:name/preview`,
        body: 'the payload a caller would POST',
        use: 'the resolved message per channel, without sending anything',
      },
      {
        method: 'POST',
        path: `${base}/hooks/:name/targets/:channel/run`,
        body: {
          payload: 'the body a caller would POST',
          map: 'MessageMap?, replaces the stored one for this run',
          match: 'Matcher?, replaces the stored one for this run',
          settings: 'Record<string, string>?, replaces the stored ones for this run',
        },
        use: 'send that payload to that one channel for real; nothing is stored or queued',
      },
      { method: 'DELETE', path: `${base}/hooks/:name`, use: 'remove a hook' },
      { method: 'GET', path: `${base}/plugins`, use: 'loader entries with fiber state and config' },
      { method: 'POST', path: `${base}/plugins`, body: { name: 'string', config: 'object?', disabled: 'boolean?' }, use: 'mount a plugin and write it to cordis.yml' },
      { method: 'PATCH', path: `${base}/plugins/:id`, body: { config: 'object?', disabled: 'boolean?' }, use: 'reconfigure or disable an entry; config merges per key' },
      { method: 'POST', path: `${base}/plugins/:id/remount`, use: 'reload an entry, for one stuck in failed' },
      { method: 'DELETE', path: `${base}/plugins/:id`, use: 'unmount and remove an entry' },
    ],
    levels: LEVELS,
    outcomes: ['delivered', 'partial', 'failed'],
    templates: {
      syntax: '{{path}}',
      paths: ['title', 'body', 'message', 'hook', 'level', 'url', 'id', 'tags', 'payload.<any.path>'],
      note: 'a path that resolves to nothing becomes an empty string',
    },
  }
}
