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
 * One HTML file with inline CSS and JS, so there is no bundler and no second
 * dev server. It reads the page from disk on load, which means an edit plus the
 * HMR reload of this plugin is enough to see the change.
 */
export function apply(ctx: Context, config: Config): void {
  const here = dirname(fileURLToPath(import.meta.url))
  const html = readFileSync(join(here, '..', 'ui', 'index.html'), 'utf8').replace(
    '__API_PREFIX__',
    config.apiPrefix.replace(/\/+$/, ''),
  )

  ctx.server.route('GET', config.path, () => ({
    status: 200,
    body: html,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }))
}
