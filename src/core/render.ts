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
 * The message as a program receives it: the shaped fields, the tags, the answers
 * to a question when there are any, and the payload as it came in. The sse
 * channel streams this and the webhook channel posts it, so the two cannot drift
 * apart into two dialects of the same thing.
 */
export function envelopeOf(message: Message): Record<string, unknown> {
  return {
    id: message.event.id,
    hook: message.event.hook,
    receivedAt: message.event.receivedAt,
    level: message.level,
    title: message.title,
    body: message.body,
    ...(message.url === undefined ? {} : { url: message.url }),
    tags: message.tags,
    ...(message.actions?.length ? { actions: message.actions } : {}),
    ...(message.event.replayOf === undefined ? {} : { replayOf: message.event.replayOf }),
    payload: message.event.payload,
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
