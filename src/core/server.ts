/**
 * The HTTP transport seam. `server-node.ts` provides it over `node:http`; an
 * alternative provider only has to satisfy this interface.
 */

export interface RouteRequest {
  method: string
  path: string
  /** Values of the `:name` segments in the route pattern. */
  params: Record<string, string>
  /** Parsed query string. */
  query: URLSearchParams
  /** Lower-cased header names. */
  headers: Record<string, string>
  body: string
}

export interface RouteResponse {
  status: number
  /** A string goes out as text, anything else as JSON. */
  body?: unknown
  headers?: Record<string, string>
}

export type RouteHandler = (request: RouteRequest) => Promise<RouteResponse> | RouteResponse

export interface ServerService {
  /** Mount a route. The disposer hangs on the calling plugin's fiber. */
  route(method: string, pattern: string, handler: RouteHandler): () => unknown
  /** The address actually bound, so `port: 0` is usable in tests. */
  readonly address: { host: string; port: number }
}

/** A host header is caller-controlled, so it has to look like a host. */
const HOSTISH = /^[A-Za-z0-9.:[\]_-]+$/

/**
 * The instance as the caller reached it, so a document can print urls that can
 * be pasted straight into a shell, behind a reverse proxy as well. A header that
 * is not host-shaped falls back to the address actually bound.
 *
 * It takes the headers and not a whole request, because a hook call carries them
 * on a `RawHook` and needs the same answer.
 */
export function originOf(
  request: { headers: Record<string, string> },
  bound: { host: string; port: number },
): string {
  const host = firstValue(request.headers['x-forwarded-host']) || firstValue(request.headers['host'])
  const scheme = firstValue(request.headers['x-forwarded-proto']) === 'https' ? 'https' : 'http'
  if (!HOSTISH.test(host)) return `${scheme}://${bound.host}:${bound.port}`
  return `${scheme}://${host}`
}

/** A forwarded header can carry a list; the client is the first entry. */
function firstValue(header: string | undefined): string {
  return (header ?? '').split(',')[0]?.trim() ?? ''
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    server: ServerService
  }
}
