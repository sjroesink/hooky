import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { constantTimeEquals } from '../core/routes.ts'
import { MatcherSchema } from '../core/schema.ts'
import type { RouteRequest } from '../core/server.ts'
import { ChannelSkip, type Matcher, type Message } from '../core/types.ts'

export const name = 'channel-sse'
export const inject = ['notify', 'server']

export interface Config {
  channel: string
  prefix: string
  secret: string
  heartbeatMs: number
  maxClients: number
  match: Matcher
}

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  channel: Schema.string().default('sse'),
  prefix: Schema.string().default('/sse').description('Path prefix; the hook name is the next segment.'),
  secret: Schema.string()
    .default('')
    .role('secret')
    .description(
      'Admin token that may listen on any hook. A subscriber that only knows one hook can use that hook own secret instead, so this is for an operator and for the odd tool that watches everything.',
    ),
  heartbeatMs: Schema.natural()
    .default(25_000)
    .description('Comment frame to keep an idle connection alive through a proxy. 0 turns it off.'),
  maxClients: Schema.natural().default(20).description('Open streams per hook. Past it a subscriber gets 503.'),
  match: MatcherSchema,
})

/** One open stream. `push` writes a frame, `close` ends it from this side. */
interface Subscriber {
  hook: string
  push: (frame: string) => void
  close: () => void
}

/**
 * Server-sent events as a channel. Registering to listen is coupling this
 * channel to a hook and then holding `GET /sse/<hook>` open, so who hears what
 * is decided by the hook definition like everything else: the target's matcher
 * and its mapping apply, and the history shows a delivery per subscriber batch.
 *
 * Nobody listening is a skip and not a failure. A stream is a thing that comes
 * and goes, and an event nobody was watching for is not a delivery that needs
 * retrying for an hour.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('sse')
  const prefix = config.prefix.replace(/\/+$/, '')
  const listeners = new Map<string, Set<Subscriber>>()

  function add(subscriber: Subscriber): void {
    const set = listeners.get(subscriber.hook) ?? new Set<Subscriber>()
    listeners.set(subscriber.hook, set)
    set.add(subscriber)
    logger.info(`listening on ${subscriber.hook}: ${set.size} stream(s)`)
  }

  function drop(subscriber: Subscriber): void {
    const set = listeners.get(subscriber.hook)
    if (!set?.delete(subscriber)) return
    if (set.size === 0) listeners.delete(subscriber.hook)
    logger.info(`left ${subscriber.hook}: ${set.size} stream(s)`)
  }

  // Everything that is open goes when this fiber does, so a reload does not
  // leave a browser hanging on a stream nothing will ever write to again.
  ctx.effect(() => () => {
    for (const set of [...listeners.values()]) for (const subscriber of [...set]) subscriber.close()
    listeners.clear()
  })

  if (config.heartbeatMs > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        for (const set of listeners.values()) for (const subscriber of set) subscriber.push(': keepalive\n\n')
      }, config.heartbeatMs)
      return () => clearInterval(timer)
    }, 'sse heartbeat')
  }

  ctx.notify.register({
    name: config.channel,
    match: config.match,
    // A subscriber gets the answers as a list in the frame, not as lines of text.
    actions: true,
    async send(message) {
      const set = listeners.get(message.event.hook)
      if (!set?.size) throw new ChannelSkip('nobody is listening on this hook')
      const frame = frameOf(message)
      for (const subscriber of [...set]) subscriber.push(frame)
    },
  })

  ctx.server.route('GET', `${prefix}/:hook`, (request) => {
    const hook = request.params['hook'] ?? ''
    if (!allowed(request, hook)) {
      logger.warn(`refused a stream on ${hook}: missing or wrong secret`)
      return { status: 401, body: { error: 'unauthorized' } }
    }

    // A hook that does not target this channel would open a stream that stays
    // silent forever, which is the one real trap in this design. Say so instead.
    const routes = ctx.get('routes')
    const definition = routes?.get(hook)
    if (routes && !definition) return { status: 404, body: { error: `no hook named '${hook}'` } }
    if (definition && !definition.targets.some((target) => target.channel === config.channel)) {
      return {
        status: 409,
        body: {
          error: `hook '${hook}' has no '${config.channel}' target, so nothing would arrive on this stream`,
        },
      }
    }

    const open = listeners.get(hook)?.size ?? 0
    if (open >= config.maxClients) {
      return { status: 503, body: { error: `${open} streams on '${hook}' already, which is the limit` } }
    }

    return {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // nginx buffers a response body by default, which turns a live stream
        // into a stream that arrives all at once, at the end.
        'x-accel-buffering': 'no',
      },
      stream: streamFor(hook),
    }
  })

  /** A stream that registers itself while it is being read. */
  function streamFor(hook: string): ReadableStream<string> {
    let subscriber: Subscriber | undefined
    return new ReadableStream<string>({
      start(controller) {
        const one: Subscriber = {
          hook,
          push(frame) {
            try {
              controller.enqueue(frame)
            } catch {
              // The stream is closed on the other side and the cancel has not
              // reached us yet. Drop it now rather than throwing at the sender.
              drop(one)
            }
          },
          close() {
            drop(one)
            try {
              controller.close()
            } catch {
              // Already closed, which is the outcome either way.
            }
          },
        }
        subscriber = one
        add(one)
        controller.enqueue(`retry: 5000\n: listening on ${hook}\n\n`)
      },
      cancel() {
        if (subscriber) drop(subscriber)
      },
    })
  }

  /**
   * Either the operator, or somebody who knows this hook's own secret. Whoever
   * may post to a hook may listen to it: same secret, same trust.
   */
  function allowed(request: RouteRequest, hook: string): boolean {
    const provided = tokenOf(request)
    if (provided === '') return false
    if (config.secret !== '' && constantTimeEquals(provided, config.secret)) return true
    // `get` and not `inject`: this channel works without the routes plugin, and
    // then the admin token is the only way in.
    return ctx.get('routes')?.authorize(hook, provided) === 'ok'
  }
}

/**
 * A secret from a header, or from the query string. An `EventSource` in a
 * browser cannot set headers, so the query is the only way in from a page; it
 * does land in an access log, which is worth knowing before you use it.
 */
function tokenOf(request: RouteRequest): string {
  const authorization = request.headers['authorization'] ?? ''
  const bearer = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7) : ''
  return bearer || request.headers['x-hooky-secret'] || request.query.get('secret') || ''
}

/**
 * One event as one frame. `data` is a single line because JSON escapes its own
 * newlines, and the event id doubles as the SSE id so a client can tell a replay
 * from a first delivery.
 */
export function frameOf(message: Message): string {
  const data = {
    id: message.event.id,
    hook: message.event.hook,
    receivedAt: message.event.receivedAt,
    level: message.level,
    title: message.title,
    body: message.body,
    ...(message.url === undefined ? {} : { url: message.url }),
    tags: message.tags,
    ...(message.actions?.length ? { actions: message.actions } : {}),
    ...(message.event.replayOf === undefined ? {} : { replayOf: message.event.replayOf }),
    payload: message.event.payload,
  }
  return `id: ${message.event.id}\nevent: message\ndata: ${JSON.stringify(data)}\n\n`
}
