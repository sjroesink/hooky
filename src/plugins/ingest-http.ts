import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { HookRejected, normalize } from '../core/normalize.ts'
import type { RouteRequest, RouteResponse } from '../core/server.ts'
import {
  describe,
  outcomeOf,
  type HookAnswer,
  type HookEvent,
  type RawHook,
  type SubmitResult,
} from '../core/types.ts'
import type {} from '../core/events.ts'

export const name = 'ingest-http'
export const inject = ['server', 'hooks']

export interface Config {
  prefix: string
  requireAuth: boolean
  waitMs: number
}

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  prefix: Schema.string().default('/hooks').description('Path prefix; the hook name is the next segment.'),
  requireAuth: Schema.boolean()
    .default(true)
    .description('Refuse a request no listener vouched for, so losing the auth plugin closes the door.'),
  waitMs: Schema.natural()
    .default(10_000)
    .description('How long to wait for the queue to process a call. 0 answers the moment it is stored.'),
})

/**
 * The HTTP half of ingest. It reads a request and hands an event to
 * `ctx.hooks.dispatch`. Any other source does the same without touching this file.
 *
 * Two doors, one handler. The plain route waits for the queue, so the caller
 * hears what each channel said; `/async` answers the moment the event is safe,
 * for a caller that fires and forgets.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('ingest')

  async function handle(request: RouteRequest, waitMs: number): Promise<RouteResponse> {
    let event
    let raw: RawHook | undefined
    try {
      raw = {
        hook: request.params['hook'] ?? '',
        headers: request.headers,
        json: parseJson(request.headers['content-type'], request.body),
        text: request.body,
      }
      const current = raw
      event = await ctx.waterfall('hook/receive', current, async () => normalize(current))
    } catch (error) {
      if (error instanceof HookRejected) {
        logger.warn(`hook ${raw?.hook ?? '?'} rejected: ${error.message}`)
        return { status: error.status, body: { error: error.message } }
      }
      logger.error(error)
      return { status: 500, body: { error: describe(error) } }
    }

    if (!event) {
      // A listener vetoed by returning without calling next().
      return { status: 401, body: { error: 'rejected' } }
    }

    if (config.requireAuth && !raw?.authorized) {
      // Nothing authorized this request. That is the case when no auth plugin is
      // mounted at all, so the default here is closed rather than open.
      logger.warn(`hook ${raw?.hook ?? '?'}: no plugin vouched for this request`)
      return { status: 401, body: { error: 'rejected' } }
    }

    const result = await ctx.hooks.submit(event, { waitMs })
    logger.info(`hook ${event.hook} (${event.id}) ${howItWent(result)}`)

    const answer = answerFor(event, result)
    return ctx.waterfall('hook/answer', answer, event, async () => answer)
  }

  ctx.server.route('POST', `${config.prefix}/:hook`, (request) => handle(request, config.waitMs))
  // Three segments, so the router never confuses this with a hook named `async`.
  ctx.server.route('POST', `${config.prefix}/:hook/async`, (request) => handle(request, 0))
}

/**
 * What the caller gets back: the event, and how far the queue got with it.
 * `200` once nothing is owed any more, `202` while a pass is still to come. A
 * failed delivery is not a 5xx: the outbox owns the retry, so a caller that
 * retries on its own would send the same notification twice.
 */
function answerFor(event: HookEvent, result: SubmitResult): HookAnswer {
  const pass = result.pass
  const results = result.results
  return {
    status: result.queued ? 202 : 200,
    body: {
      id: result.id,
      hook: event.hook,
      queued: result.queued,
      state: result.queued ? 'pending' : 'done',
      // A pass knows its own outcome. Without one the event was delivered inside
      // the request, which is one attempt and nothing owed.
      outcome: pass ? pass.outcome : results ? outcomeOf(results) : null,
      attempts: pass?.attempts ?? (results ? 1 : 0),
      nextAttemptAt: pass?.nextAttemptAt ?? null,
      results: results ?? [],
    },
  }
}

/** One line for the log, in the words of the queue. */
function howItWent(result: SubmitResult): string {
  const results = result.results
  if (!results) return 'queued'
  const sent = results.filter((one) => one.status === 'sent').length
  return `${sent}/${results.length} channel(s) took it, ${result.queued ? 'another pass due' : 'settled'}`
}

function parseJson(contentType: string | undefined, body: string): Record<string, unknown> | undefined {
  if (!contentType?.includes('json') || body.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    throw new HookRejected(400, `invalid JSON body: ${describe(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HookRejected(400, 'JSON body must be an object')
  }
  return parsed as Record<string, unknown>
}
