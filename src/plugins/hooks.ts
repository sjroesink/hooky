import type { Context } from '@deepseek-ai/cordis'
import { HooksService } from '../core/hooks.ts'
import { NotifyService } from '../core/notify.ts'

export const name = 'hooks'

/**
 * Mounts the two seams that hold the pipeline: `ctx.notify` for channels and
 * `ctx.hooks` for whatever wants to feed an event in.
 */
export function apply(ctx: Context): void {
  ctx.plugin(NotifyService)
  ctx.plugin(HooksService)
}
