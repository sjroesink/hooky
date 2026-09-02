import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { appendActions } from '../core/ask.ts'
import { postJson } from '../core/http.ts'
import { LevelSchema, MatcherSchema } from '../core/schema.ts'
import { rank, type Level, type Matcher, type Message, type MessageAction } from '../core/types.ts'

export const name = 'channel-telegram'
export const inject = ['notify']

export interface Config {
  channel: string
  token: string
  chatId: string
  threadId: number
  silentBelow: Level
  apiBase: string
  timeoutMs: number
  match: Matcher
}

export const Config: Schema<Partial<Config> & { token: string; chatId: string }, Config> = Schema.object({
  channel: Schema.string().default('telegram'),
  token: Schema.string().required().role('secret'),
  chatId: Schema.string().required().description('Chat or group id, from getUpdates or a bot helper.'),
  threadId: Schema.natural().default(0).description('Forum topic id for groups with topics; 0 means none.'),
  silentBelow: LevelSchema.default('warning').description('Send without a notification sound below this level.'),
  apiBase: Schema.string().default('https://api.telegram.org'),
  timeoutMs: Schema.natural().default(10_000),
  match: MatcherSchema,
})

export function apply(ctx: Context, config: Config): void {
  ctx.notify.register({
    name: config.channel,
    match: config.match,
    // Telegram has buttons, so a question gets buttons instead of urls in the
    // text. Every answer fits: there is no limit worth working around here.
    actions: true,
    async send(message, signal) {
      // Telegram refuses a button url it does not read as a public one and
      // answers 400 for the whole message, so a keyboard it will not take means
      // no notification at all. The answers go in the text instead.
      const buttons = buttonable(message.actions)
      await postJson({
        url: `${config.apiBase}/bot${config.token}/sendMessage`,
        payload: {
          chat_id: config.chatId,
          text: format(buttons || !message.actions?.length ? message : withAnswers(message)),
          parse_mode: 'HTML',
          ...(config.threadId > 0 ? { message_thread_id: config.threadId } : {}),
          ...(buttons ? { reply_markup: keyboard(message.actions!) } : {}),
          disable_notification: rank(message.level) < rank(config.silentBelow),
        },
        signal,
        timeoutMs: config.timeoutMs,
        label: 'telegram',
      })
    },
  })
}

/**
 * Can these answers be buttons? Telegram validates a button url and refuses
 * anything it does not consider reachable, `http://localhost:3112/...` included,
 * with a 400 that kills the whole message. An instance whose questions go to
 * Telegram wants a public `publicUrl` on the ask row; until it has one, the
 * answers are still readable as text.
 */
export function buttonable(actions: MessageAction[] | undefined): boolean {
  return Boolean(actions?.length) && actions!.every((action) => reachable(action.url))
}

function reachable(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false
  // An address rather than a name, v4 or v6: not a host Telegram will accept.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[')) return false
  // A bare intranet name has no dot in it, and Telegram wants a real domain.
  return host.includes('.')
}

/** The fallback: the same answers, as lines under the body. */
function withAnswers(message: Message): Message {
  return { ...message, body: appendActions(message.body, message.actions ?? []) }
}

/**
 * One answer per row. A url button needs no callback handler and no bot state,
 * which is why an answer is a link and not a `callback_data`.
 */
export function keyboard(actions: MessageAction[]): Record<string, unknown> {
  return { inline_keyboard: actions.map((action) => [{ text: action.title, url: action.url }]) }
}

/** HTML, not MarkdownV2: escaping is three characters instead of eighteen. */
export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function format(message: Message): string {
  const lines = [`<b>${escapeHtml(message.title)}</b>`]
  if (message.body) lines.push(escapeHtml(message.body))
  if (message.tags.length) lines.push(`<i>${escapeHtml(message.tags.join(', '))}</i>`)
  if (message.url) lines.push(`<a href="${encodeURI(message.url)}">${escapeHtml(message.url)}</a>`)
  return lines.join('\n')
}
