import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { HookRejected, normalize } from '../core/normalize.ts'
import { render, shape } from '../core/render.ts'
import {
  HookExists,
  NoSuchHook,
  NoSuchTarget,
  hasExpired,
  hashSecret,
  newSecret,
  secretMatches,
  tidyTarget,
  type AuthVerdict,
  type HookDefinition,
  type HookInput,
  type HookPatch,
  type HookTarget,
  type Preview,
  type RoutesService,
  type RunResult,
  type ShapedMessage,
} from '../core/routes.ts'
import { HookTargetSchema } from '../core/schema.ts'
import { describe, matches, type Message, type RawHook } from '../core/types.ts'
import type {} from '../core/events.ts'

export const name = 'routes'
export const inject = ['store']

/** A hook name has to survive being a path segment. */
const NAME = /^[a-z0-9][a-z0-9._-]*$/i

export interface SeedHook {
  name: string
  description?: string
  targets: HookTarget[]
}

export interface Config {
  header: string
  always: string[]
  fallback: 'matchers' | 'none'
  remember: boolean
  seed: SeedHook[]
  seedSecret: string
}

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  header: Schema.string().default('x-hooky-secret').description('Header carrying the hook secret.'),
  always: Schema.array(String)
    .default([])
    .description('Channels every hook delivers to, on top of its own targets.'),
  fallback: Schema.union(['matchers', 'none'] as const)
    .default('matchers')
    .description(
      'What to do with an event whose hook is not defined: let the channel matchers decide, or drop it. Only reachable outside the HTTP ingest, which answers 404 for an unknown name.',
    ),
  remember: Schema.boolean()
    .default(true)
    .description(
      'Keep a call for a hook that is not defined or is switched off, so you can see what arrived and define it from that payload. The store caps how many.',
    ),
  seed: Schema.array(
    Schema.object({
      name: Schema.string().required(),
      description: Schema.string(),
      targets: Schema.array(HookTargetSchema).default([]),
    }),
  )
    .default([])
    .description('Hooks to create on the first boot, when the table is still empty.'),
  seedSecret: Schema.string()
    .default('')
    .role('secret')
    .description('Secret the seeded hooks get. Empty means: do not seed.'),
})

/**
 * The hook registry. Reads come from a cache because the secret check runs
 * inside a request; writes go to the store and refresh that same cache, and
 * this service is the only writer, so it cannot go stale.
 */
class Routes extends Service implements RoutesService {
  // TS `private`, not `#private`: the service is reached through a proxy that
  // rebinds `this.ctx`, and a `#field` brand check fails on a proxy receiver.
  private cache = new Map<string, HookDefinition>()
  private settings: Config

  constructor(ctx: Context, config: Config) {
    super(ctx, 'routes')
    this.settings = config
  }

  /** Fill the cache once, at mount. */
  async load(): Promise<void> {
    for (const hook of await this.ctx.store.listHooks()) this.cache.set(hook.name, hook)
  }

  list(): HookDefinition[] {
    return [...this.cache.values()].sort((left, right) => left.name.localeCompare(right.name))
  }

  get(name: string): HookDefinition | undefined {
    return this.cache.get(name)
  }

  async create(input: HookInput): Promise<{ hook: HookDefinition; secret?: string }> {
    if (!NAME.test(input.name)) {
      throw new Error(`'${input.name}' is not a usable hook name: letters, digits, dot, dash, underscore`)
    }
    if (this.cache.has(input.name)) throw new HookExists(input.name)
    const secret = input.secret === false ? undefined : input.secret ?? newSecret()
    const now = Date.now()
    const hook = await this.write({
      name: input.name,
      description: input.description,
      disabled: input.disabled ?? false,
      expiresAt: input.expiresAt,
      secretHash: secret === undefined ? null : hashSecret(secret),
      targets: input.targets ?? [],
      createdAt: now,
      updatedAt: now,
    })
    return secret === undefined ? { hook } : { hook, secret }
  }

  async update(name: string, patch: HookPatch): Promise<HookDefinition> {
    const hook = this.demand(name)
    return this.write({
      ...hook,
      description: 'description' in patch ? patch.description : hook.description,
      disabled: 'disabled' in patch ? patch.disabled ?? false : hook.disabled,
      expiresAt: 'expiresAt' in patch ? patch.expiresAt ?? undefined : hook.expiresAt,
      targets: 'targets' in patch ? patch.targets ?? [] : hook.targets,
      updatedAt: Date.now(),
    })
  }

  async setTarget(name: string, target: HookTarget): Promise<HookDefinition> {
    const hook = this.demand(name)
    const targets = hook.targets.filter((existing) => existing.channel !== target.channel)
    targets.push(target)
    return this.write({ ...hook, targets, updatedAt: Date.now() })
  }

  async removeTarget(name: string, channel: string): Promise<HookDefinition> {
    const hook = this.demand(name)
    return this.write({
      ...hook,
      targets: hook.targets.filter((target) => target.channel !== channel),
      updatedAt: Date.now(),
    })
  }

  async rotate(name: string): Promise<{ hook: HookDefinition; secret: string }> {
    const hook = this.demand(name)
    const secret = newSecret()
    return {
      hook: await this.write({ ...hook, secretHash: hashSecret(secret), updatedAt: Date.now() }),
      secret,
    }
  }

  async remove(name: string): Promise<boolean> {
    const removed = await this.ctx.store.removeHook(name)
    this.cache.delete(name)
    return removed
  }

  async pruneExpired(now = Date.now()): Promise<string[]> {
    const gone = this.list()
      .filter((hook) => hasExpired(hook, now))
      .map((hook) => hook.name)
    for (const name of gone) await this.remove(name)
    return gone
  }

  /** For `hooks import`: the definitions replace what is there, hashes included. */
  async replaceAll(hooks: HookDefinition[]): Promise<number> {
    for (const name of [...this.cache.keys()]) await this.remove(name)
    for (const hook of hooks) await this.write(hook)
    return hooks.length
  }

  async preview(name: string, payload: unknown): Promise<Preview[]> {
    const hook = this.demand(name)
    const message = await this.messageFor(name, payload)
    // `get`, not `this.ctx.notify`: notify is not in `inject`, and reaching an
    // uninjected service directly throws instead of answering undefined.
    const registered = new Set(this.ctx.get('notify')?.names ?? [])

    return this.allTargets(hook).map((target) => {
      if (!matches(target.match, message)) {
        return { channel: target.channel, skipped: 'the target matcher does not accept this event' }
      }
      if (registered.size > 0 && !registered.has(target.channel)) {
        return { channel: target.channel, skipped: `no channel named '${target.channel}' is registered` }
      }
      return { channel: target.channel, message: viewOf(shape(message, target.map)) }
    })
  }

  /**
   * The real thing, to one channel. This is what a target's `run` in the UI
   * does: the message goes out over the channel, so a Telegram target actually
   * makes Telegram buzz.
   *
   * The event is built and rendered as a call would be, but it is never stored
   * and never queued. A run that fails is a failure of this run and not of an
   * event somebody has to replay later.
   */
  async run(
    name: string,
    channel: string,
    payload: unknown,
    override: Partial<HookTarget> = {},
  ): Promise<RunResult> {
    const hook = this.demand(name)
    const stored = this.allTargets(hook).find((target) => target.channel === channel)
    if (!stored) throw new NoSuchTarget(name, channel)
    const target = tidyTarget({ ...stored, ...override, channel })

    const message = await this.messageFor(name, payload)
    if (!matches(target.match, message)) {
      return { channel, skipped: 'the target matcher does not accept this event' }
    }
    const notify = this.ctx.get('notify')
    if (!notify) return { channel, skipped: 'there is no notify service in this composition' }

    // Shaped here, then handed over without the map: it is applied once, so a
    // `{{path}}` the payload itself carries is not resolved a second time. The
    // settings do go along, because they say where this target posts at all.
    // A channel that is not registered comes back as a skipped result from
    // notify, which is the same answer a real delivery would give.
    const shaped = shape(message, target.map)
    const result = await notify.deliverTo(shaped, { channel, ...(target.settings ? { settings: target.settings } : {}) })
    return { channel, message: viewOf(shaped), result }
  }

  /** The event a payload produces, rendered but not yet shaped per target. */
  private async messageFor(name: string, payload: unknown): Promise<Message> {
    const event = normalize(rawFrom(name, payload))
    return this.ctx.waterfall('notify/render', event, async () => render(event))
  }

  targetsFor(message: Message): HookTarget[] | undefined {
    const hook = this.cache.get(message.event.hook)
    // Only reachable for events that did not come through the HTTP ingest, such
    // as /api/send or a replay of a hook that has since been removed.
    if (!hook) return this.settings.fallback === 'none' ? [] : undefined
    if (hook.disabled || hasExpired(hook)) return []
    return this.allTargets(hook).filter((target) => matches(target.match, message))
  }

  authorize(name: string, provided: string): AuthVerdict {
    const hook = this.cache.get(name)
    if (!hook) return 'unknown'
    if (hook.disabled) return 'disabled'
    // Before the secret check, like `disabled`: what the caller sent does not
    // matter any more once the hook is past its moment.
    if (hasExpired(hook)) return 'expired'
    return secretMatches(provided, hook.secretHash) ? 'ok' : 'refused'
  }

  /** The hook's own targets plus the `always` channels it does not name itself. */
  private allTargets(hook: HookDefinition): HookTarget[] {
    const named = new Set(hook.targets.map((target) => target.channel))
    const always = this.settings.always
      .filter((channel) => !named.has(channel))
      .map((channel) => ({ channel }))
    return [...hook.targets, ...always]
  }

  private demand(name: string): HookDefinition {
    const hook = this.cache.get(name)
    if (!hook) throw new NoSuchHook(name)
    return hook
  }

  private async write(input: HookDefinition): Promise<HookDefinition> {
    const hook = { ...input, targets: input.targets.map((target) => tidyTarget(target)) }
    await this.ctx.store.saveHook(hook)
    this.cache.set(hook.name, hook)
    return hook
  }
}

/**
 * Hooks as a layer of their own: the definitions decide who gets a call and what
 * the message looks like per channel, so a channel plugin no longer needs a
 * matcher and the same event can read differently on Telegram than on ntfy.
 *
 * It also owns authentication, because a secret belongs to a hook and not to the
 * installation. `ingest-http` refuses anything this plugin did not vouch for, so
 * unloading it closes the door instead of opening it.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const logger = ctx.logger('routes')
  const routes = new Routes(ctx, config)
  await routes.load()

  if (routes.list().length === 0 && config.seed.length > 0) {
    if (config.seedSecret === '') {
      logger.warn(
        `not seeding ${config.seed.length} hook(s): seedSecret is empty, and a hook without a secret is not a default`,
      )
    } else {
      for (const hook of config.seed) {
        await routes.create({ ...hook, secret: config.seedSecret })
        logger.info(`seeded hook '${hook.name}' -> ${hook.targets.map((t) => t.channel).join(', ') || 'no targets'}`)
      }
    }
  }

  const header = config.header.toLowerCase()

  /**
   * Keep the call before answering, so the UI can show what arrived for a name
   * nobody defined and offer that payload as the start of a definition. A wrong
   * secret is not kept: that body is the one an attacker controls for free.
   */
  async function turnAway(raw: RawHook, status: number, reason: string): Promise<never> {
    if (config.remember) {
      try {
        await ctx.store.reject(normalize(raw), { status, reason })
      } catch (error) {
        logger.warn(`could not keep the rejected call for '${raw.hook}': ${describe(error)}`)
      }
    }
    throw new HookRejected(status, reason)
  }

  ctx.on(
    'hook/receive',
    async (raw, next) => {
      const verdict = routes.authorize(raw.hook, secretFrom(raw, header))
      if (verdict === 'unknown') return turnAway(raw, 404, `no hook named '${raw.hook}'`)
      if (verdict === 'disabled') return turnAway(raw, 410, `hook '${raw.hook}' is disabled`)
      if (verdict === 'expired') {
        const at = routes.get(raw.hook)?.expiresAt ?? 0
        return turnAway(raw, 410, `hook '${raw.hook}' expired on ${new Date(at).toISOString()}`)
      }
      if (verdict === 'refused') {
        logger.warn(`hook ${raw.hook}: missing or wrong secret`)
        return null
      }
      raw.authorized = true
      return next()
    },
    { prepend: true },
  )

  ctx.on('notify/target', (message) => routes.targetsFor(message))
}

/** The hook secret, from its own header or from a bearer token. */
function secretFrom(raw: RawHook, header: string): string {
  const own = raw.headers[header]
  if (own) return own
  const authorization = raw.headers['authorization'] ?? ''
  return authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7) : ''
}

/** A message as a channel receives it, for a preview row or a run answer. */
function viewOf(message: Message): ShapedMessage {
  return {
    title: message.title,
    body: message.body,
    level: message.level,
    url: message.url,
    tags: message.tags,
  }
}

/** A preview payload, shaped like the request the ingest would have received. */
function rawFrom(hook: string, payload: unknown): RawHook {
  const isObject = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
  return {
    hook,
    headers: {},
    json: isObject ? (payload as Record<string, unknown>) : undefined,
    text: typeof payload === 'string' ? payload : JSON.stringify(payload ?? {}),
  }
}
