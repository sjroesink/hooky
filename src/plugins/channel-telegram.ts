import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
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
      await postJson({
        url: `${config.apiBase}/bot${config.token}/sendMessage`,
        payload: {
          chat_id: config.chatId,
          text: format(message),
          parse_mode: 'HTML',
          ...(config.threadId > 0 ? { message_thread_id: config.threadId } : {}),
          ...(message.actions?.length ? { reply_markup: keyboard(message.actions) } : {}),
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
