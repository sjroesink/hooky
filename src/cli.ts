#!/usr/bin/env node
/**
 * Thin client over the HTTP API, JSON in and JSON out, so an agent can drive the
 * whole system without knowing anything about cordis. `hooky describe` prints
 * the command catalog and the API catalog in one object.
 *
 *   HOOKY_URL     default http://127.0.0.1:3000
 *   HOOKY_SECRET  bearer token, same value the api plugin is configured with
 */

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
      '--state': 'pending|done',
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
