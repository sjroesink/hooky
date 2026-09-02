#!/usr/bin/env node
/**
 * Thin client over the HTTP API, JSON in and JSON out, so an agent can drive the
 * whole system without knowing anything about cordis. `hooky describe` prints
 * the command catalog and the API catalog in one object.
 *
 *   HOOKY_URL     default http://127.0.0.1:3000
 *   HOOKY_SECRET  bearer token, same value the api plugin is configured with
 *
 * Both come from a `.env` in the working directory when they are not exported.
 */
import { readFile } from 'node:fs/promises'
import { loadEnv } from './core/env.ts'

loadEnv()

interface Command {
  use: string
  args?: string
  flags?: Record<string, string>
  run(argv: string[], flags: Flags): Promise<unknown>
}

type Flags = Record<string, string | boolean>

const BASE = (process.env['HOOKY_URL'] ?? 'http://127.0.0.1:3000').replace(/\/+$/, '')
const PREFIX = process.env['HOOKY_API_PREFIX'] ?? '/api'
const SECRET = process.env['HOOKY_SECRET'] ?? ''

/** What `--data` falls back to, for a preview or a run without one. */
const SAMPLE_PAYLOAD = '{"title":"a test from the CLI","message":"a sample body","level":"warning","tags":["sample"]}'

async function call(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`${BASE}${PREFIX}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${SECRET}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  const parsed: unknown = text ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(`${method} ${path} responded ${response.status}: ${text.slice(0, 300)}`)
  }
  return parsed
}

function query(flags: Flags, keys: string[]): string {
  const params = new URLSearchParams()
  for (const key of keys) {
    const value = flags[key]
    if (typeof value === 'string' && value.length > 0) params.set(key, value)
  }
  const rendered = params.toString()
  return rendered ? `?${rendered}` : ''
}

/** `--set a=1 --set b.c=x` becomes `{ a: 1, 'b.c': 'x' }` with JSON-ish coercion. */
function assignments(raw: string | boolean | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const list = Array.isArray(raw) ? raw : raw === undefined || typeof raw === 'boolean' ? [] : [raw]
  for (const item of list) {
    const index = item.indexOf('=')
    if (index < 0) throw new Error(`--set expects key=value, got '${item}'`)
    const key = item.slice(0, index)
    const value = item.slice(index + 1)
    out[key] = coerce(value)
  }
  return out
}

/**
 * Like `assignments`, minus the coercion. A channel setting is a string: a
 * webhook url stays a url and `format=card` does not become anything else.
 */
function plainAssignments(raw: string | boolean | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  const list = Array.isArray(raw) ? raw : raw === undefined || typeof raw === 'boolean' ? [] : [raw]
  for (const item of list) {
    const index = item.indexOf('=')
    if (index < 0) throw new Error(`--set expects key=value, got '${item}'`)
    out[item.slice(0, index)] = item.slice(index + 1)
  }
  return out
}

function coerce(value: string): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  if (value !== '' && !Number.isNaN(Number(value))) return Number(value)
  if (value.startsWith('{') || value.startsWith('[')) {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

const commands: Record<string, Command> = {
  describe: {
    use: 'print this catalog plus the API catalog',
    async run() {
      return { cli: catalog(), api: await call('GET', '/describe') }
    },
  },
  stats: {
    use: 'counts per outcome and per channel',
    async run() {
      return call('GET', '/stats')
    },
  },
  'events list': {
    use: 'webhook calls, newest first',
    flags: {
      '--hook': 'only this hook',
      '--level': 'debug|info|warning|error|critical',
      '--state': 'pending|done|rejected (a call no hook took)',
      '--outcome': 'delivered|partial|failed',
      '--channel': 'only calls with a record for this channel',
      '--search': 'substring of title or body',
      '--since': 'epoch ms, or 30m / 2h / 7d',
      '--limit': 'default 50',
      '--offset': 'default 0',
    },
    async run(_argv, flags) {
      const keys = ['hook', 'level', 'state', 'outcome', 'channel', 'search', 'since', 'limit', 'offset']
      return call('GET', `/events${query(flags, keys)}`)
    },
  },
  'events show': {
    use: 'one call including its payload',
    args: '<id>',
    async run(argv) {
      return call('GET', `/events/${need(argv[0], 'id')}`)
    },
  },
  'events replay': {
    use: 'submit a copy of a call as a new event',
    args: '<id>',
    async run(argv) {
      return call('POST', `/events/${need(argv[0], 'id')}/replay`)
    },
  },
  send: {
    use: 'send a notification without going through a webhook',
    args: '<hook>',
    flags: {
      '--title': 'defaults to the hook name',
      '--body': 'message text',
      '--level': 'default info',
      '--url': 'click-through link',
      '--tags': 'comma separated',
    },
    async run(argv, flags) {
      const tags = typeof flags['tags'] === 'string' ? flags['tags'].split(',').filter(Boolean) : []
      return call('POST', '/send', {
        hook: need(argv[0], 'hook'),
        title: flags['title'],
        body: flags['body'],
        level: flags['level'],
        url: flags['url'],
        tags,
      })
    },
  },
  'channels list': {
    use: 'registered channels and their delivery counts',
    async run() {
      return call('GET', '/channels')
    },
  },
  'hooks list': {
    use: 'defined hooks with their targets',
    flags: { '--hash': 'include the secret hash, for a backup' },
    async run(_argv, flags) {
      return call('GET', `/hooks${flags['hash'] === true ? '?include=hash' : ''}`)
    },
  },
  'hooks show': {
    use: 'one hook, with its targets and mapping',
    args: '<name>',
    async run(argv) {
      return call('GET', `/hooks/${need(argv[0], 'name')}`)
    },
  },
  'hooks add': {
    use: 'define a hook; the secret is printed once and stored as a hash',
    args: '<name>',
    flags: {
      '--target': 'channel to deliver to, repeatable',
      '--description': 'what this hook is for',
      '--secret': 'use this secret instead of a generated one',
      '--open': 'no secret at all; anyone who knows the name can post',
      '--disabled': 'define it without accepting calls yet',
      '--expires-in': 'stop accepting calls after this long, e.g. 2h or 7d',
    },
    async run(argv, flags) {
      return call('POST', '/hooks', {
        name: need(argv[0], 'name'),
        description: typeof flags['description'] === 'string' ? flags['description'] : undefined,
        disabled: flags['disabled'] === true,
        expiresIn: typeof flags['expires-in'] === 'string' ? flags['expires-in'] : undefined,
        targets: many(flags['target']).map((channel) => ({ channel })),
        secret:
          flags['open'] === true
            ? false
            : typeof flags['secret'] === 'string'
              ? flags['secret']
              : undefined,
      })
    },
  },
  'hooks set': {
    use: 'change the description, the expiry, or turn a hook off without removing it',
    args: '<name>',
    flags: {
      '--description': 'new description',
      '--disabled': 'true or false',
      '--expires-in': 'expire this long from now, e.g. 2h, 7d, or a date',
      '--no-expiry': 'let it accept calls again for as long as it exists',
    },
    async run(argv, flags) {
      const body: Record<string, unknown> = {}
      if (typeof flags['description'] === 'string') body['description'] = flags['description']
      if (flags['disabled'] !== undefined) body['disabled'] = flags['disabled'] !== 'false'
      if (typeof flags['expires-in'] === 'string') body['expiresIn'] = flags['expires-in']
      if (flags['no-expiry'] === true) body['expiresIn'] = null
      return call('PATCH', `/hooks/${need(argv[0], 'name')}`, body)
    },
  },
  'hooks prune': {
    use: 'remove every hook whose expiry has passed; their events stay in the history',
    async run() {
      return call('DELETE', '/hooks?expired=1')
    },
  },
  'hooks target': {
    use: 'add a channel to a hook and say what that channel receives',
    args: '<name> <channel>',
    flags: {
      '--title': 'template, e.g. "{{title}} on {{hook}}"',
      '--body': 'template; {{message}} is the incoming body, \\n becomes a newline',
      '--url': 'template for the click-through link',
      '--level': 'override the level for this channel only',
      '--tag': 'tag template, repeatable; replaces the tags',
      '--min-level': 'only deliver to this channel from this level up',
      '--only-tag': 'only deliver when the event carries this tag, repeatable',
      '--set': 'channel setting key=value, repeatable; teams takes webhook, webhook takes url, method, headers and body',
    },
    async run(argv, flags) {
      const map: Record<string, unknown> = {}
      if (typeof flags['title'] === 'string') map['title'] = withNewlines(flags['title'])
      if (typeof flags['body'] === 'string') map['body'] = withNewlines(flags['body'])
      if (typeof flags['url'] === 'string') map['url'] = flags['url']
      if (typeof flags['level'] === 'string') map['level'] = flags['level']
      if (many(flags['tag']).length > 0) map['tags'] = many(flags['tag'])

      const match: Record<string, unknown> = {}
      if (typeof flags['min-level'] === 'string') match['minLevel'] = flags['min-level']
      if (many(flags['only-tag']).length > 0) match['tags'] = many(flags['only-tag'])

      const settings = plainAssignments(flags['set'])

      return call('PUT', `/hooks/${need(argv[0], 'name')}/targets/${need(argv[1], 'channel')}`, {
        ...(Object.keys(map).length > 0 ? { map } : {}),
        ...(Object.keys(match).length > 0 ? { match } : {}),
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
      })
    },
  },
  'hooks untarget': {
    use: 'remove one channel from a hook',
    args: '<name> <channel>',
    async run(argv) {
      return call('DELETE', `/hooks/${need(argv[0], 'name')}/targets/${need(argv[1], 'channel')}`)
    },
  },
  'hooks rotate': {
    use: 'new secret for a hook; the old one stops working immediately',
    args: '<name>',
    async run(argv) {
      return call('POST', `/hooks/${need(argv[0], 'name')}/rotate`)
    },
  },
  'hooks preview': {
    use: 'the message each channel would get for a payload, without sending it',
    args: '<name>',
    flags: { '--data': 'JSON payload; a sample is used when omitted' },
    async run(argv, flags) {
      const raw = typeof flags['data'] === 'string' ? flags['data'] : SAMPLE_PAYLOAD
      return call('POST', `/hooks/${need(argv[0], 'name')}/preview`, JSON.parse(raw) as unknown)
    },
  },
  'hooks run': {
    use: 'send a payload to one channel of a hook for real, to see it arrive',
    args: '<name> <channel>',
    flags: {
      '--data': 'JSON payload; a sample is used when omitted',
      '--set': 'channel setting key=value for this run only, repeatable',
    },
    async run(argv, flags) {
      const raw = typeof flags['data'] === 'string' ? flags['data'] : SAMPLE_PAYLOAD
      const name = need(argv[0], 'name')
      const channel = need(argv[1], 'channel')
      const settings = plainAssignments(flags['set'])
      return call('POST', `/hooks/${name}/targets/${channel}/run`, {
        payload: JSON.parse(raw) as unknown,
        ...(Object.keys(settings).length > 0 ? { settings } : {}),
      })
    },
  },
  'hooks remove': {
    use: 'remove a hook; calls to that name answer 404 afterwards',
    args: '<name>',
    async run(argv) {
      return call('DELETE', `/hooks/${need(argv[0], 'name')}`)
    },
  },
  'hooks export': {
    use: 'every definition as JSON, hashes included, for a backup or a second host',
    async run() {
      return call('GET', '/hooks?include=hash')
    },
  },
  'hooks import': {
    use: 'replace every definition with the contents of a hooks export',
    args: '<file>',
    async run(argv) {
      const parsed: unknown = JSON.parse(await readFile(need(argv[0], 'file'), 'utf8'))
      const hooks =
        Array.isArray(parsed) ? parsed : (parsed as { hooks?: unknown[] } | null)?.hooks
      if (!Array.isArray(hooks)) throw new Error('the file must be a hooks export or an array of hooks')
      return call('PUT', '/hooks', { hooks })
    },
  },
  'plugins list': {
    use: 'loader entries with fiber state and config',
    async run() {
      return call('GET', '/plugins')
    },
  },
  'plugins add': {
    use: 'mount a plugin and write the row to cordis.yml',
    args: '<module-specifier>',
    flags: {
      '--id': 'row id in cordis.yml; generated when omitted',
      '--set': 'config key=value, repeatable',
      '--disabled': 'add it without starting it',
    },
    async run(argv, flags) {
      return call('POST', '/plugins', {
        name: need(argv[0], 'module specifier'),
        id: typeof flags['id'] === 'string' ? flags['id'] : undefined,
        config: assignments(flags['set']),
        disabled: flags['disabled'] === true,
      })
    },
  },
  'plugins set': {
    use: 'reconfigure an entry; keys you do not name keep their value',
    args: '<id>',
    flags: { '--set': 'config key=value, repeatable' },
    async run(argv, flags) {
      return call('PATCH', `/plugins/${need(argv[0], 'id')}`, { config: assignments(flags['set']) })
    },
  },
  'plugins enable': {
    use: 'start an entry and clear disabled in cordis.yml',
    args: '<id>',
    async run(argv) {
      return call('PATCH', `/plugins/${need(argv[0], 'id')}`, { disabled: false })
    },
  },
  'plugins disable': {
    use: 'unmount an entry but keep its row',
    args: '<id>',
    async run(argv) {
      return call('PATCH', `/plugins/${need(argv[0], 'id')}`, { disabled: true })
    },
  },
  'plugins remount': {
    use: 'reload an entry, for one stuck in failed',
    args: '<id>',
    async run(argv) {
      return call('POST', `/plugins/${need(argv[0], 'id')}/remount`)
    },
  },
  'plugins remove': {
    use: 'unmount an entry and delete its row',
    args: '<id>',
    async run(argv) {
      return call('DELETE', `/plugins/${need(argv[0], 'id')}`)
    },
  },
}

/** A flag that may be repeated, as a list. */
function many(raw: Flags[string] | undefined): string[] {
  if (raw === undefined || typeof raw === 'boolean') return []
  return Array.isArray(raw) ? (raw as unknown as string[]) : [raw]
}
/** A shell cannot type a newline into a flag, so let the template say it. */
function withNewlines(value: string): string {
  return value.replaceAll('\\n', '\n').replaceAll('\\t', '\t')
}
function need(value: string | undefined, what: string): string {
  if (!value) throw new Error(`missing ${what}`)
  return value
}

function catalog() {
  return {
    usage: 'hooky <command> [args] [--flag value]',
    env: {
      HOOKY_URL: `where the instance runs, now ${BASE}`,
      HOOKY_SECRET: SECRET ? 'set' : 'NOT SET, every call will get 401',
      HOOKY_API_PREFIX: PREFIX,
    },
    output: 'JSON on stdout, errors as {"error": "..."} on stdout with exit code 1',
    commands: Object.entries(commands).map(([name, command]) => ({
      command: name,
      args: command.args ?? null,
      use: command.use,
      flags: command.flags ?? {},
    })),
  }
}

/** Splits `--flag value`, `--flag=value` and bare `--flag`. Repeated flags collect. */
function parse(argv: string[]): { words: string[]; flags: Flags } {
  const words: string[] = []
  const flags: Flags = {}
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (!token.startsWith('--')) {
      words.push(token)
      continue
    }
    const equals = token.indexOf('=')
    const key = (equals < 0 ? token.slice(2) : token.slice(2, equals)) || ''
    let value: string | boolean
    if (equals >= 0) {
      value = token.slice(equals + 1)
    } else if (argv[index + 1] !== undefined && !argv[index + 1]!.startsWith('--')) {
      value = argv[++index]!
    } else {
      value = true
    }
    const existing = flags[key]
    if (existing === undefined) {
      flags[key] = value
    } else if (Array.isArray(existing)) {
      ;(existing as unknown[]).push(value)
    } else {
      flags[key] = [existing, value] as unknown as string
    }
  }
  return { words, flags }
}

async function main(): Promise<void> {
  const { words, flags } = parse(process.argv.slice(2))
  if (words.length === 0 || words[0] === 'help' || flags['help'] === true) {
    process.stdout.write(JSON.stringify(catalog(), null, 2) + '\n')
    return
  }

  // Longest match first, so 'events list' beats a hypothetical 'events'.
  const key = [words.slice(0, 2).join(' '), words[0]!].find((candidate) => candidate in commands)
  if (!key) {
    throw new Error(`unknown command '${words.join(' ')}'; run 'hooky describe' for the catalog`)
  }
  const rest = words.slice(key.split(' ').length)
  const result = await commands[key]!.run(rest, flags)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stdout.write(JSON.stringify({ error: message }, null, 2) + '\n')
  process.exitCode = 1
})
