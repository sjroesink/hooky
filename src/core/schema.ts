import Schema from '@deepseek-ai/schemastery'
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
