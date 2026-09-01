import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { postJson } from '../core/http.ts'
import { MatcherSchema } from '../core/schema.ts'
import type { ChannelSetting, Level, Matcher, Message } from '../core/types.ts'

export const name = 'channel-teams'
export const inject = ['notify']

export interface Config {
  channel: string
  webhook: string
  format: 'card' | 'text'
  facts: boolean
  version: string
  timeoutMs: number
  match: Matcher
}

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  channel: Schema.string().default('teams'),
  webhook: Schema.string()
    .default('')
    .role('secret')
    .description(
      'Default workflow trigger url, for when every hook posts to the same Teams channel. Leave it empty and set the url per target instead. It carries its own signature, so it is a credential.',
    ),
  format: Schema.union(['card', 'text'] as const)
    .default('card')
    .description(
      'What the flow expects. `card` posts an Adaptive Card in the message envelope, which is what the webhook templates ask for. `text` posts `{ "text": "..." }` for a flow built around a plain string.',
    ),
  facts: Schema.boolean()
    .default(true)
    .description('Put the hook, the level and the tags under the message as a fact list.'),
  version: Schema.string()
    .default('1.4')
    .description('Adaptive Card schema version. Teams renders 1.0 through 1.5.'),
  timeoutMs: Schema.natural().default(10_000),
  match: MatcherSchema,
})

/**
 * Teams colours a TextBlock by name, not by hex. `attention` is red, `warning`
 * amber, `light` grey.
 */
const COLOR: Record<Level, string> = {
  debug: 'light',
  info: 'default',
  warning: 'warning',
  error: 'attention',
  critical: 'attention',
}

/**
 * What a target may set for itself. The UI renders these as fields in the target
 * editor, so activating `teams` on a hook is: pick the channel, paste the url.
 */
export const SETTINGS: ChannelSetting[] = [
  {
    key: 'webhook',
    label: 'webhook url',
    secret: true,
    placeholder: 'https://…/triggers/manual/paths/invoke?api-version=1&…&sig=…',
    hint: 'From Workflows in Teams, template "Send webhook alerts to a channel". It decides which Teams channel this target posts in.',
  },
  {
    key: 'format',
    label: 'format',
    placeholder: 'card',
    hint: 'card for an Adaptive Card, text for a flow built around a plain string.',
  },
]

/**
 * Microsoft Teams over a Workflows webhook, the Power Automate trigger that
 * replaced the retired Office 365 connectors. A trigger url points at one Teams
 * channel and carries its own signature in the query string, so it is both a
 * destination and a credential.
 *
 * Which is why it belongs on the target: one `teams` row, and every hook says
 * where its own calls land. The row's `webhook` is only a default for when they
 * all land in the same place.
 *
 * What the endpoint accepts depends on the flow behind it. A flow from the
 * webhook templates parses the message envelope with an Adaptive Card in it,
 * which is what `format: card` sends. A flow written around a plain string wants
 * `{ "text": "..." }`, which is `format: text`. The wrong one answers 400 and
 * the outbox keeps retrying it, so this is worth getting right once.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.notify.register({
    name: config.channel,
    match: config.match,
    settings: SETTINGS,
    async send(message, signal, settings) {
      const url = settings?.['webhook']?.trim() || config.webhook
      if (url === '') {
        // Not a crash: this comes back as a failed delivery naming the fix.
        throw new Error(
          'no webhook url: set one on this target, or a default on the teams row',
        )
      }
      const format = settings?.['format'] === 'text' || settings?.['format'] === 'card'
        ? settings['format']
        : config.format
      await postJson({
        url,
        payload: format === 'text' ? { text: summary(message) } : envelope(message, config),
        signal,
        timeoutMs: config.timeoutMs,
        label: config.channel,
      })
    },
  })
}

/**
 * The message envelope. `attachments` with one adaptive card is the shape the
 * trigger schema describes; posting a bare card, or a legacy MessageCard, is the
 * usual cause of a 400 here.
 */
export function envelope(
  message: Message,
  options: { version: string; facts: boolean },
): Record<string, unknown> {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        // Null and not left out, because a Parse JSON step in the flow may
        // insist on the key being there.
        contentUrl: null,
        content: card(message, options),
      },
    ],
  }
}

function card(message: Message, options: { version: string; facts: boolean }): Record<string, unknown> {
  const body: Record<string, unknown>[] = [
    {
      type: 'TextBlock',
      text: message.title,
      weight: 'Bolder',
      size: 'Medium',
      wrap: true,
      color: COLOR[message.level],
    },
  ]
  if (message.body) body.push({ type: 'TextBlock', text: message.body, wrap: true })
  if (options.facts) {
    const facts = [
      { title: 'Hook', value: message.event.hook },
      { title: 'Level', value: message.level },
      ...(message.tags.length > 0 ? [{ title: 'Tags', value: message.tags.join(', ') }] : []),
    ]
    body.push({ type: 'FactSet', facts })
  }
  // The link goes in the card as well as in the action below it. Microsoft lists
  // buttons not rendering as a known issue for cards posted by the flow bot, and
  // a url nobody can reach is worse than one line of duplication.
  if (message.url) {
    body.push({ type: 'TextBlock', text: `[${message.url}](${message.url})`, wrap: true })
  }

  return {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: options.version,
    body,
    ...(message.url
      ? { actions: [{ type: 'Action.OpenUrl', title: 'Open', url: message.url }] }
      : {}),
  }
}

/** The `text` format: one string, with the title first and the link last. */
export function summary(message: Message): string {
  const lines = [`**${message.title}**`]
  if (message.body) lines.push(message.body)
  if (message.tags.length > 0) lines.push(message.tags.join(', '))
  if (message.url) lines.push(message.url)
  return lines.join('\n\n')
}
