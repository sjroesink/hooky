/**
 * A question a hook call asks, and the one url that answers it. The vocabulary
 * and the pure parts live here, so the store can keep an ask and a channel can
 * render one without either of them importing the plugin that does the waiting.
 */
import { randomBytes } from 'node:crypto'
import type { MessageAction } from './types.ts'

/**
 * One answer a caller offers. Without a `url` it gets a reply url of its own,
 * which is what makes it an answer; with one it is a plain link that answers
 * nothing and is only there to be tapped.
 */
export interface AskAction {
  /** Slug that names this answer. It is the last segment of its reply url. */
  value: string
  title: string
  url?: string
}

/** What the caller asked for, still in the caller's own words. */
export interface AskRequest {
  /** `ask.id`: an id the caller brought along. Not validated here. */
  id?: unknown
  /** `ask.wait`: seconds to hold the call. Not clamped here. */
  wait?: unknown
  /** Answers to render. Empty is fine: then the reply url is the whole contract. */
  actions: AskAction[]
}

/**
 * What came back. `action` is the answer that was picked, or null when the reply
 * only carried a body. `data` is that body, whatever it was.
 */
export interface AskAnswer {
  action: string | null
  at: number
  data?: unknown
}

export interface StoredAsk {
  id: string
  /** The event this question rode out on. */
  eventId: string
  hook: string
  question: string
  /** Urls already composed, so a later pass sends exactly the same links. */
  actions: MessageAction[]
  /**
   * The instance as the asking caller reached it. Stored, because the answer to
   * a hook call is built outside any request and still has to print a url.
   */
  baseUrl: string
  answered: AskAnswer | null
  createdAt: number
  expiresAt: number
}

/**
 * What answering did. `already` is a second reply to a question that is settled,
 * `expired` a reply that outlived its ask, and `unknown` an id or an answer
 * nobody recognizes.
 */
export type AnswerVerdict = 'answered' | 'already' | 'expired' | 'unknown'

/**
 * An ask id has to survive being a path segment, and it is the only thing that
 * keeps a question private, so a caller that brings its own brings a long one.
 * Sixteen characters is the floor, and random is the point.
 */
export const ASK_ID = /^[A-Za-z0-9._-]{16,64}$/

/** Same for an answer: it is a path segment, and it names one answer. */
export const ANSWER = /^[A-Za-z0-9._-]{1,32}$/

export function newAskId(): string {
  return randomBytes(16).toString('base64url')
}

/**
 * Read the question out of a payload. `ask` is a namespace of its own, so a
 * webhook from somewhere else cannot turn into a question by accident, and
 * everything the caller decides about the question sits in one place.
 *
 * An ask without a single action is a question all the same. Then the reply url
 * is the whole contract and what gets posted to it is the answer, which is how
 * a form the caller hosts itself works.
 */
export function parseAsk(payload: unknown, max: number): AskRequest | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const raw = (payload as Record<string, unknown>)['ask']
  if (raw === true) return { actions: [] }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const one = raw as Record<string, unknown>
  return {
    ...(one['id'] === undefined ? {} : { id: one['id'] }),
    ...(one['wait'] === undefined ? {} : { wait: one['wait'] }),
    actions: parseActions(one['actions'], max),
  }
}

/**
 * The answers to offer. Anything that is not an object with a title falls away,
 * because a list of answers is a list a person is going to read.
 */
export function parseActions(raw: unknown, max: number): AskAction[] {
  if (!Array.isArray(raw)) return []
  const actions: AskAction[] = []
  const taken = new Set<string>()
  for (const entry of raw) {
    if (actions.length === max) break
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const one = entry as Record<string, unknown>
    const title = typeof one['title'] === 'string' ? one['title'].trim() : ''
    if (title === '') continue

    const base = slugFor(typeof one['value'] === 'string' ? one['value'] : title, actions.length)
    let value = base
    for (let n = 1; taken.has(value); n++) value = `${base}-${n}`
    taken.add(value)

    const url = typeof one['url'] === 'string' ? one['url'].trim() : ''
    actions.push({ value, title: title.slice(0, 64), ...(url === '' ? {} : { url }) })
  }
  return actions
}

/** A value has to survive being a path segment and still say which answer it is. */
export function slugFor(value: string, index: number): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 32)
    .replace(/[-.]+$/, '')
  return slug === '' ? `a${index + 1}` : slug
}

/** Where a reply goes: one url per ask, with the answer as an optional segment. */
export function replyUrl(options: { base: string; prefix: string; ask: string }, answer?: string): string {
  const one = `${options.base}${options.prefix}/reply/${options.ask}`
  return answer === undefined ? one : `${one}/${answer}`
}

/** The urls a stored ask carries: a reply url per answer, links as they came. */
export function actionsFor(
  actions: AskAction[],
  options: { base: string; prefix: string; ask: string },
): MessageAction[] {
  return actions.map((action) => ({
    value: action.value,
    title: action.title,
    url: action.url ?? replyUrl(options, action.value),
    reply: action.url === undefined,
  }))
}

/**
 * The lines under the body, for every channel that has no buttons of its own.
 * One answer per line, because on a phone a line is what you tap.
 */
export function appendActions(body: string, actions: MessageAction[]): string {
  const lines = actions.map((action) => `${action.title}: ${action.url}`)
  return [body.trim(), lines.join('\n')].filter((part) => part !== '').join('\n\n')
}
