import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { HookRejected, normalize } from '../core/normalize.ts'
import { describe, type RawHook } from '../core/types.ts'
import type {} from '../core/events.ts'

export const name = 'ingest-http'
export const inject = ['server', 'hooks']

export interface Config {
  prefix: string
}

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  prefix: Schema.string().default('/hooks').description('Path prefix; the hook name is the next segment.'),
})

/**
 * The HTTP half of ingest. It reads a request and hands an event to
 * `ctx.hooks.dispatch`. Any other source does the same without touching this file.
 */
export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('ingest')

  ctx.server.route('POST', `${config.prefix}/:hook`, async (request) => {
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

    const result = await ctx.hooks.submit(event)
    logger.info(
      result.queued
        ? `hook ${event.hook} (${event.id}) queued`
        : `hook ${event.hook} (${event.id}) delivered to ${result.results.length} channel(s)`,
    )
    return { status: 202, body: result }
  })
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
