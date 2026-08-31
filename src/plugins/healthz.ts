import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'healthz'
export const inject = ['server']

export interface Config {
  path: string
}

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  path: Schema.string().default('/healthz'),
})

export function apply(ctx: Context, config: Config): void {
  ctx.server.route('GET', config.path, () => ({
    status: 200,
    body: { status: 'ok', channels: ctx.get('notify')?.names ?? [] },
  }))
}
