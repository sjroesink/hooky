import type { HookEvent, Message } from './types.ts'

/** The default behind the `notify/render` waterfall. A template plugin replaces this. */
export function render(event: HookEvent): Message {
  return {
    title: event.title,
    body: event.body ?? '',
    level: event.level,
    url: event.url,
    tags: event.tags,
    event,
  }
}
