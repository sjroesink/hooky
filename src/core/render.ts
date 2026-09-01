import type { MessageMap } from './routes.ts'
import { interpolate } from './template.ts'
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

/**
 * Apply one target's map, so the same event can read differently per channel.
 * Templates resolve against the event, `level` is a plain override. A field the
 * map does not mention keeps what the renderer produced.
 */
export function shape(message: Message, map?: MessageMap): Message {
  if (!map) return message
  const event = message.event
  const url = map.url === undefined ? message.url : interpolate(map.url, event) || undefined
  return {
    ...message,
    title: map.title === undefined ? message.title : interpolate(map.title, event),
    body: map.body === undefined ? message.body : interpolate(map.body, event),
    level: map.level ?? message.level,
    url,
    tags:
      map.tags === undefined
        ? message.tags
        : map.tags.map((tag) => interpolate(tag, event)).filter((tag) => tag.length > 0),
  }
}
