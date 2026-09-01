import Schema from '@deepseek-ai/schemastery'
import type { HookTarget, MessageMap } from './routes.ts'
import { LEVELS, type Level, type Matcher } from './types.ts'

export const LevelSchema = Schema.union(LEVELS) as Schema<Level>

/**
 * Reused by every channel plugin, so `match` means the same thing everywhere.
 */
export const MatcherSchema: Schema<Matcher> = Schema.object({
  hooks: Schema.array(String).default([]).description('Only these hook names; empty means all.'),
  minLevel: LevelSchema.default('debug').description('Drop anything below this level.'),
  tags: Schema.array(String).default([]).description('At least one of these tags; empty means all.'),
})

/**
 * What one hook sends to one channel. Every field is a `{{path}}` template
 * except `level`, which is a plain override. A field left out keeps whatever the
 * renderer produced.
 */
export const MessageMapSchema: Schema<MessageMap> = Schema.object({
  title: Schema.string().description('Template, e.g. "{{title}} on {{hook}}".'),
  body: Schema.string().description('Template; {{message}} is the incoming body.'),
  url: Schema.string().description('Template for the click-through link.'),
  level: LevelSchema.description('Override the level for this channel only.'),
  tags: Schema.array(String).description('Templates; replaces the tags when given.'),
})

/** One target: a channel, what it gets, and an optional filter of its own. */
export const HookTargetSchema: Schema<Partial<HookTarget> & { channel: string }, HookTarget> = Schema.object({
  channel: Schema.string().required().description('A registered channel name.'),
  map: MessageMapSchema,
  match: MatcherSchema,
  settings: Schema.dict(String).description(
    'Channel settings for this target only, e.g. the Teams webhook url. The channel declares which keys it reads.',
  ),
})
