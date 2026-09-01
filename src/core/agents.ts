/**
 * The two files from https://agents-txt.com: `/agents.txt` for a parser that
 * reads lines, `/agents.json` for one that reads JSON. Both say the same thing,
 * so there is one document here and two renderers.
 *
 * This file is vocabulary and formatting only. Who fills the document in is a
 * plugin's business, and every plugin that has something an agent can use adds
 * its own entries through `agents/declare`.
 */

export const STANDARD = 'https://agents-txt.com'
export const VERSION = '1.0'
export const SCHEMA_URL = 'https://agents-txt.com/schema/agents-json/v1.0.json'

export interface AgentsSite {
  name: string
  url: string
  description?: string
}

/** A skill, an A2A card, a UCP profile: a url and why you would fetch it. */
export interface Endpoint {
  url: string
  description?: string
}

export interface McpEndpoint extends Endpoint {
  /** The only transport the schema allows. */
  type: 'streamable-http'
}

export interface Authorization {
  /** `agent-auth`, `oauth2`, `auth-md`, or an `x-` prefixed scheme of your own. */
  protocols: string[]
  identity?: 'required'
  /** Where the details are. The schema requires it. */
  discovery: string
}

export interface Payments {
  x402?: { chains: string[]; description?: string }
  mpp?: { methods: string[]; description?: string }
  ap2?: { presentations: string[]; spec: string; description?: string }
  /** `true` is the only value there is. Leave it out when paying is optional. */
  required?: true
  pricing?: { amount: string; currency: string }
}

/**
 * The lists are always there, empty at worst, so a listener can spread them
 * without checking first.
 */
export interface AgentsDocument {
  site: AgentsSite
  payments?: Payments
  authorization?: Authorization
  mcp: McpEndpoint[]
  skills: Endpoint[]
  a2a: Endpoint[]
  ucp: Endpoint[]
  webmcp: Endpoint[]
}

export function emptyDocument(site: AgentsSite): AgentsDocument {
  return { site, mcp: [], skills: [], a2a: [], ucp: [], webmcp: [] }
}

/** The payment protocols named in the document, in the order the spec lists them. */
function protocolsOf(payments: Payments | undefined): string[] {
  if (!payments) return []
  return (['x402', 'mpp', 'ap2'] as const).filter((protocol) => payments[protocol] !== undefined)
}

/**
 * `agents.txt`: comments, then one block per capability, blocks separated by a
 * blank line. A block with nothing in it is left out rather than served empty.
 */
export function renderText(document: AgentsDocument, jsonUrl: string): string {
  const blocks: string[][] = [['# agents.txt', `# Standard: ${STANDARD}`, `# JSON: ${jsonUrl}`]]

  const protocols = protocolsOf(document.payments)
  if (protocols.length > 0) {
    const payments = [`Protocols: ${protocols.join(', ')}`]
    if (document.payments?.required) payments.push('Payments: required')
    blocks.push(payments)
  }

  if (document.authorization && document.authorization.protocols.length > 0) {
    const authorization = [`Authorization: ${document.authorization.protocols.join(', ')}`]
    if (document.authorization.identity === 'required') authorization.push('Identity: required')
    blocks.push(authorization)
  }

  // One line per endpoint, because the directives repeat and a comma list is
  // only for protocol ids.
  const lines = (directive: string, endpoints: Endpoint[]) =>
    endpoints.map((endpoint) => `${directive}: ${endpoint.url}`)
  for (const [directive, endpoints] of [
    ['MCP', document.mcp],
    ['Skills', document.skills],
    ['A2A', document.a2a],
    ['UCP', document.ucp],
    ['WebMCP', document.webmcp],
  ] as const) {
    if (endpoints.length > 0) blocks.push(lines(directive, endpoints))
  }

  return blocks.map((block) => block.join('\n')).join('\n\n') + '\n'
}

/** `agents.json`: the same document, with the three fields the schema requires. */
export function renderJson(document: AgentsDocument): Record<string, unknown> {
  const json: Record<string, unknown> = {
    $schema: SCHEMA_URL,
    version: VERSION,
    standard: STANDARD,
    site: document.site,
  }
  if (document.payments && (protocolsOf(document.payments).length > 0 || document.payments.pricing)) {
    json['payments'] = document.payments
  }
  if (document.authorization && document.authorization.protocols.length > 0) {
    json['authorization'] = document.authorization
  }
  for (const key of ['mcp', 'skills', 'a2a', 'ucp', 'webmcp'] as const) {
    // An empty list is not a declaration, so it stays out of the file.
    if (document[key].length > 0) json[key] = document[key]
  }
  return json
}
