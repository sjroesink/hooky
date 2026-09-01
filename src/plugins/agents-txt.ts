import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  emptyDocument,
  renderJson,
  renderText,
  type AgentsDocument,
  type Endpoint,
} from '../core/agents.ts'
import { originOf, type RouteRequest } from '../core/server.ts'
import type {} from '../core/events.ts'

export const name = 'agents-txt'
export const inject = ['server']

export interface Config {
  siteName: string
  siteUrl: string
  siteDescription: string
  mcp: Endpoint[]
  a2a: Endpoint[]
  ucp: Endpoint[]
  webmcp: Endpoint[]
  authProtocols: string[]
  authIdentity: boolean
  authDiscovery: string
  cacheSeconds: number
  robots: boolean
}

const EndpointSchema: Schema<Partial<Endpoint> & { url: string }, Endpoint> = Schema.object({
  url: Schema.string().required().description('Absolute url, https outside a test.'),
  description: Schema.string().description('Why an agent would fetch it.'),
})

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  siteName: Schema.string().default('Hooky').description('The name in the site block.'),
  siteUrl: Schema.string()
    .default('')
    .description('The canonical url. Empty means: the address this caller reached.'),
  siteDescription: Schema.string()
    .default('Webhook receiver that turns a call into a notification.')
    .description('One line about what this instance is for.'),
  mcp: Schema.array(EndpointSchema).default([]).description('Streamable HTTP MCP endpoints on this origin.'),
  a2a: Schema.array(EndpointSchema).default([]).description('A2A agent cards.'),
  ucp: Schema.array(EndpointSchema).default([]).description('UCP profiles.'),
  webmcp: Schema.array(EndpointSchema).default([]).description('WebMCP endpoints.'),
  authProtocols: Schema.array(String)
    .default([])
    .description('Auth protocol ids: agent-auth, oauth2, auth-md, or an x- prefixed one of your own.'),
  authIdentity: Schema.boolean()
    .default(false)
    .description('Say that an agent has to identify itself. Only read when a protocol is named.'),
  authDiscovery: Schema.string()
    .default('')
    .description('Where the auth details are. The schema requires it, so a protocol without this is dropped.'),
  cacheSeconds: Schema.natural()
    .default(3600)
    .description('Cache-Control max-age. 0 serves no-store, which is what a dev instance wants.'),
  robots: Schema.boolean()
    .default(false)
    .description(
      'Also serve /robots.txt allowing the two files and nothing else. Off by default: a Hooky instance is not a public site, and a proxy in front of it may already serve one.',
    ),
})

/**
 * `/agents.txt` and `/agents.json`, the discovery files from
 * https://agents-txt.com. The paths are fixed by the spec, so there is no prefix
 * to configure: an agent looks for them at the root of the origin.
 *
 * What goes in them comes from two places. Whatever the operator declares here,
 * and whatever the mounted plugins declare themselves through `agents/declare`.
 * The skill plugin uses that to list its own documents, so adding a skill or
 * moving its prefix never leaves a stale url in this file.
 */
export function apply(ctx: Context, config: Config): void {
  const declared = {
    mcp: config.mcp.map((endpoint) => ({ ...endpoint, type: 'streamable-http' as const })),
    a2a: config.a2a,
    ucp: config.ucp,
    webmcp: config.webmcp,
  }
  // The schema requires `discovery`, so a protocol list without one is not a
  // declaration that would validate. Better to leave the block out than to
  // serve a file nothing accepts.
  const authorization =
    config.authProtocols.length > 0 && config.authDiscovery !== ''
      ? {
          protocols: config.authProtocols,
          ...(config.authIdentity ? { identity: 'required' as const } : {}),
          discovery: config.authDiscovery,
        }
      : undefined

  async function build(request: RouteRequest): Promise<AgentsDocument> {
    const origin = originOf(request, ctx.server.address)
    const base: AgentsDocument = {
      ...emptyDocument({
        name: config.siteName,
        url: config.siteUrl || origin,
        description: config.siteDescription || undefined,
      }),
      ...declared,
      ...(authorization ? { authorization } : {}),
    }
    return ctx.waterfall('agents/declare', base, origin, async () => base)
  }

  const headers = (contentType: string) => ({
    'content-type': contentType,
    // Both files MUST be readable from a browser agent on another origin.
    'access-control-allow-origin': '*',
    'cache-control': config.cacheSeconds > 0 ? `public, max-age=${config.cacheSeconds}` : 'no-store',
  })

  ctx.server.route('GET', '/agents.txt', async (request) => ({
    status: 200,
    body: renderText(await build(request), `${originOf(request, ctx.server.address)}/agents.json`),
    headers: headers('text/plain; charset=utf-8'),
  }))

  // Exactly `application/json`, the way the spec writes it, so a strict reader
  // has nothing to complain about.
  ctx.server.route('GET', '/agents.json', async (request) => ({
    status: 200,
    body: renderJson(await build(request)),
    headers: headers('application/json'),
  }))

  if (config.robots) {
    ctx.server.route('GET', '/robots.txt', () => ({
      status: 200,
      body: 'User-agent: *\nAllow: /agents.txt\nAllow: /agents.json\nDisallow: /\n',
      headers: headers('text/plain; charset=utf-8'),
    }))
  }
}
