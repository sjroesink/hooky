import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'ui'
export const inject = ['server']

export interface Config {
  path: string
  apiPrefix: string
}

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  path: Schema.string().default('/').description('Where the page is served.'),
  apiPrefix: Schema.string().default('/api').description('Passed to the page so it knows where to fetch.'),
})

/**
 * One HTML file with inline CSS and JS, so there is no bundler and no second dev
 * server. HMR watches modules, and index.html is not one, so outside production
 * the file is read per request: edit, refresh, done. In production it is read
 * once at load.
 */
export function apply(ctx: Context, config: Config): void {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html')
  const prefix = config.apiPrefix.replace(/\/+$/, '')
  const cached = process.env['NODE_ENV'] === 'production' ? read() : undefined

  function read(): string {
    // replaceAll, not replace: the placeholder appears in the page copy and again
    // in the script that has to know where to fetch.
    return readFileSync(file, 'utf8').replaceAll('__API_PREFIX__', prefix)
  }

  ctx.server.route('GET', config.path, () => ({
    status: 200,
    body: cached ?? read(),
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }))
}
