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

declare module '@deepseek-ai/cordis' {
  interface Context {
    server: ServerService
  }
}
