import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { RouteHandler, RouteRequest, RouteResponse, ServerService } from '../core/server.ts'

export const name = 'server-node'

export interface Config {
  host: string
  port: number
  maxBodyBytes: number
}

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  host: Schema.string().default('127.0.0.1'),
  port: Schema.natural().default(3000).description('0 binds a free port; read it back from ctx.server.address.'),
  maxBodyBytes: Schema.natural().default(1024 * 1024),
})

interface Route {
  method: string
  segments: string[]
  handler: RouteHandler
}

class TooLarge extends Error {}

class NodeServer extends Service implements ServerService {
  private routes = new Set<Route>()
  private config: Config
  private server: Server

  constructor(ctx: Context, config: Config) {
    super(ctx, 'server')
    this.config = config
    this.server = createServer((request, response) => {
      void this.handle(request, response)
    })
  }

  /**
   * Bind the port as an effect, so unloading the plugin frees it. Awaiting the
   * effect handle waits for the setup body and rethrows a bind failure, which
   * turns a taken port into a plugin startup error.
   */
  async listen(): Promise<void> {
    await this.ctx.effect(async () => {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error)
        this.server.once('error', onError)
        this.server.listen(this.config.port, this.config.host, () => {
          this.server.off('error', onError)
          resolve()
        })
      })
      return async () => {
        this.server.closeAllConnections()
        await new Promise<void>((resolve) => this.server.close(() => resolve()))
      }
    }, 'server.listen()')
  }

  get address(): { host: string; port: number } {
    const bound = this.server.address()
    if (!bound || typeof bound === 'string') {
      throw new Error('server is not listening on a TCP port')
    }
    return { host: bound.address, port: bound.port }
  }

  route(method: string, pattern: string, handler: RouteHandler): () => unknown {
    const route: Route = {
      method: method.toUpperCase(),
      segments: pattern.split('/').filter(Boolean),
      handler,
    }
    // `this.ctx` is the caller's context, so the route leaves with its plugin.
    return this.ctx.effect(() => {
      this.routes.add(route)
      return () => {
        this.routes.delete(route)
      }
    }, `ctx.server.route(${method} ${pattern})`)
  }

  private match(method: string, pathname: string) {
    const actual = pathname.split('/').filter(Boolean)
    for (const route of this.routes) {
      if (route.method !== method) continue
      if (route.segments.length !== actual.length) continue
      const params: Record<string, string> = {}
      let hit = true
      for (const [index, segment] of route.segments.entries()) {
        const value = actual[index]!
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(value)
        } else if (segment !== value) {
          hit = false
          break
        }
      }
      if (hit) return { route, params }
    }
    return undefined
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const method = (request.method ?? 'GET').toUpperCase()
    const found = this.match(method, url.pathname)
    if (!found) return this.write(response, { status: 404, body: { error: 'no such route' } })

    try {
      const body = await this.read(request)
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') headers[key.toLowerCase()] = value
      }
      const payload: RouteRequest = {
        method,
        path: url.pathname,
        params: found.params,
        query: url.searchParams,
        headers,
        body,
      }
      this.write(response, await found.route.handler(payload))
    } catch (error) {
      if (error instanceof TooLarge) {
        return this.write(response, {
          status: 413,
          body: { error: 'body too large' },
          headers: { connection: 'close' },
        })
      }
      this.ctx.logger('server').error(error)
      this.write(response, { status: 500, body: { error: 'internal error' } })
    }
  }

  private async read(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      const buffer = chunk as Buffer
      size += buffer.length
      if (size > this.config.maxBodyBytes) {
        // Do not destroy the request here: the response still has to go out.
        // `connection: close` below ends the exchange once it is written.
        throw new TooLarge()
      }
      chunks.push(buffer)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  private write(response: ServerResponse, result: RouteResponse): void {
    const isText = typeof result.body === 'string'
    const body = result.body === undefined ? '' : isText ? (result.body as string) : JSON.stringify(result.body)
    response.writeHead(result.status, {
      'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      ...result.headers,
    })
    response.end(body)
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const server = new NodeServer(ctx, config)
  await server.listen()
}
