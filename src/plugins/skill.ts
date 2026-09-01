import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { constantTimeEquals, type HookDefinition } from '../core/routes.ts'
import { originOf, type RouteRequest } from '../core/server.ts'
import type {} from '../core/events.ts'

export const name = 'skill'
export const inject = ['server']

export interface Config {
  prefix: string
  hooksPrefix: string
  apiPrefix: string
  secret: string
}

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  prefix: Schema.string().default('/skills').description('Where the index and the documents are served.'),
  hooksPrefix: Schema.string()
    .default('/hooks')
    .description('Named in the documents, so keep it in step with the ingest row.'),
  apiPrefix: Schema.string().default('/api').description('Named in the documents, same story.'),
  secret: Schema.string()
    .default('')
    .role('secret')
    .description('The admin token. A request that presents it also gets the hooks defined right now.'),
})

/**
 * One document per question somebody actually has, because a skill is picked by
 * its description: sending a notification, defining the hooks that route them,
 * finding out what happened to a call, and extending Hooky itself. Splitting
 * them also splits the credentials: sending needs no admin token, and the last
 * one is not an HTTP job at all.
 *
 * The file name is the skill name, and the frontmatter says it again for the
 * agent that installs it.
 */
const SKILLS = ['hooky-send', 'hooky-manage', 'hooky-history', 'hooky-plugin'] as const

/**
 * The instance, as documents an agent can read and install as skills. Each one
 * is filled in from the instance itself: the address the caller reached, the
 * channels registered right now, and with the admin token the hooks that exist.
 *
 * The prose lives in `src/skill/*.md`. Outside production it is read per request,
 * so an edit plus a refresh is enough; `.md` is not a module, so HMR does not
 * watch it.
 */
export function apply(ctx: Context, config: Config): void {
  const folder = join(dirname(fileURLToPath(import.meta.url)), '..', 'skill')
  const prefix = config.prefix.replace(/\/+$/, '')
  const hooks = config.hooksPrefix.replace(/\/+$/, '')
  const api = config.apiPrefix.replace(/\/+$/, '')
  const production = process.env['NODE_ENV'] === 'production'
  const cache = new Map<string, string>()

  /** Normalized, so a Windows checkout does not serve a different document. */
  function read(skill: string): string {
    const cached = cache.get(skill)
    if (cached !== undefined) return cached
    const source = readFileSync(join(folder, `${skill}.md`), 'utf8').replace(/\r\n/g, '\n')
    if (production) cache.set(skill, source)
    return source
  }

  const fill = (source: string, request: RouteRequest) =>
    source
      .replaceAll('__BASE__', originOf(request, ctx.server.address))
      .replaceAll('__PREFIX__', prefix)
      .replaceAll('__HOOKS__', hooks)
      .replaceAll('__API__', api)
      .replaceAll('__CHANNELS__', channels(ctx))
      .replaceAll('__DEFINED__', defined(ctx, api, authorized(request, config.secret)))

  for (const skill of SKILLS) {
    ctx.server.route('GET', `${prefix}/${skill}/SKILL.md`, (request) => ({
      status: 200,
      body: fill(read(skill), request),
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
    }))
  }

  ctx.server.route('GET', prefix, (request) => ({
    status: 200,
    body: index(entries(request), originOf(request, ctx.server.address), prefix),
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  }))

  ctx.server.route('GET', `${prefix}.json`, (request) => ({
    status: 200,
    body: { skills: entries(request) },
  }))

  // This plugin is the one that knows which documents exist and where they are
  // served, so it is the one that puts them in agents.txt. Unload it and the
  // Skills lines go with it.
  ctx.on('agents/declare', async (_document, origin, next) => {
    const base = await next()
    return {
      ...base,
      skills: [
        ...base.skills,
        ...SKILLS.map((skill) => ({
          url: `${origin}${prefix}/${skill}/SKILL.md`,
          description: frontmatter(read(skill)).description,
        })),
      ],
    }
  })

  /** Name, description and url per skill, straight out of the documents. */
  function entries(request: RouteRequest) {
    const base = originOf(request, ctx.server.address)
    return SKILLS.map((skill) => ({
      ...frontmatter(read(skill)),
      url: `${base}${prefix}/${skill}/SKILL.md`,
    }))
  }
}

/** The index. Not a skill itself, and it says so. */
function index(skills: { name: string; description: string; url: string }[], base: string, prefix: string): string {
  return [
    '# Hooky skills',
    '',
    `Hooky serves what it can do as skills, filled in by the instance at \`${base}\`. Each document is a`,
    'skill file with its frontmatter, so installing them is a copy:',
    '',
    '```sh',
    `for skill in ${skills.map((skill) => skill.name).join(' ')}; do`,
    '  mkdir -p .claude/skills/$skill',
    `  curl -s ${base}${prefix}/$skill/SKILL.md > .claude/skills/$skill/SKILL.md`,
    'done',
    '```',
    '',
    'This page is the index and not a skill, so do not save it as one. `' + prefix + '.json` is the same',
    'list as JSON, and `/agents.txt` names the same documents for an agent that starts at the root.',
    '',
    ...skills.flatMap((skill) => [`## ${skill.name}`, '', skill.description, '', `\`${skill.url}\``, '']),
  ].join('\n')
}

/** Name and description out of the frontmatter, without a YAML dependency. */
function frontmatter(source: string): { name: string; description: string } {
  const block = /^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? ''
  const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(block)?.[1]?.trim() ?? ''
  return { name: field('name'), description: field('description') }
}

function channels(ctx: Context): string {
  const names = ctx.get('notify')?.names ?? []
  return names.length > 0 ? names.map((name) => `\`${name}\``).join(', ') : 'none'
}

/**
 * The one section that is about this instance and not about Hooky. Without the
 * admin token it says where to look instead, because which hooks exist is not
 * something a public document should hand out.
 */
function defined(ctx: Context, api: string, allowed: boolean): string {
  const head = '## What is defined here'
  if (!allowed) {
    return `${head}\n\nNot in this document. \`GET ${api}/hooks\` with the admin token lists the hooks, their targets and whether they are on. Send that same token to this document and the hooks are named here instead.`
  }
  const hooks = ctx.get('routes')?.list() ?? []
  if (hooks.length === 0) {
    return `${head}\n\nNothing yet. Every call answers 404 until a hook exists by that name, so the first step is a \`POST ${api}/hooks\`.`
  }
  return [
    head,
    '',
    '| Hook | Targets | State | Secret | For |',
    '|---|---|---|---|---|',
    ...hooks.map(row),
  ].join('\n')
}

function row(hook: HookDefinition): string {
  const targets =
    hook.targets.length === 0
      ? 'none, so a call goes nowhere'
      : hook.targets.map((target) => (target.map ? `${target.channel} (mapped)` : target.channel)).join(', ')
  const cells = [
    `\`${hook.name}\``,
    targets,
    hook.disabled ? 'off' : 'on',
    hook.secretHash ? 'own' : 'open',
    hook.description ?? '',
  ]
  return `| ${cells.map(cell).join(' | ')} |`
}

/** A description is free text, and a table row is one line with no pipes in it. */
function cell(value: string): string {
  return value.replace(/\s+/g, ' ').replaceAll('|', '\\|').trim()
}

/** The admin token, the same two headers the API accepts. */
function authorized(request: RouteRequest, secret: string): boolean {
  // No secret configured is not the same as an empty secret matching an empty
  // header: with nothing to compare against, nobody is authorized.
  if (secret === '') return false
  const header = request.headers['authorization'] ?? ''
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7) : ''
  const provided = bearer || request.headers['x-hooky-secret'] || ''
  return provided !== '' && constantTimeEquals(provided, secret)
}

