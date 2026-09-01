import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as hooksPlugin from '../src/plugins/hooks.ts'
import * as routesPlugin from '../src/plugins/hook-routes.ts'
import * as serverPlugin from '../src/plugins/server-node.ts'
import * as skillPlugin from '../src/plugins/skill.ts'
import * as storePlugin from '../src/plugins/store-sqlite.ts'

const TOKEN = 'admin-token'
const SKILLS = ['hooky-send', 'hooky-manage', 'hooky-history', 'hooky-plugin']

/** The documents, plus enough of the pipeline for them to have something to say. */
async function stack(t: TestContext, config: Partial<skillPlugin.Config> = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(serverPlugin, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(hooksPlugin)
  await ctx.plugin(storePlugin, { path: ':memory:', retentionDays: 0 })

  await ctx.inject(['notify'], (child) => {
    for (const name of ['telegram', 'ntfy']) {
      child.notify.register({ name, async send() {} })
    }
  })
  await ctx.plugin(routesPlugin, { always: [] })
  await ctx.plugin(skillPlugin, { secret: TOKEN, ...config })

  const base = `http://127.0.0.1:${ctx.server.address.port}`
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, { headers })
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      text: await response.text(),
    }
  }
  const skill = (name: string, headers: Record<string, string> = {}) =>
    get(`/skills/${name}/SKILL.md`, headers)

  return { ctx, base, get, skill }
}

/** The two fields an agent picks a skill by. */
function frontmatter(text: string) {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
  const field = (key: string) => new RegExp(`^${key}: (.+)$`, 'm').exec(block)?.[1] ?? ''
  return { name: field('name'), description: field('description') }
}

test('every skill is a markdown document with the frontmatter to install it', async (t) => {
  const { skill } = await stack(t)

  for (const name of SKILLS) {
    const answer = await skill(name)
    assert.equal(answer.status, 200, name)
    assert.equal(answer.type, 'text/markdown; charset=utf-8', name)

    const front = frontmatter(answer.text)
    assert.equal(front.name, name, 'the frontmatter name is the name it is served under')
    assert.ok(front.description.length > 80, `${name} says when to use it`)
    assert.doesNotMatch(answer.text, /__[A-Z]+__/, `${name} has every placeholder filled`)
  }
})

test('the index names them all, with what they are for and where they are', async (t) => {
  const { base, get } = await stack(t)
  const answer = await get('/skills')

  assert.equal(answer.status, 200)
  assert.equal(answer.type, 'text/markdown; charset=utf-8')
  for (const name of SKILLS) {
    assert.ok(answer.text.includes(`## ${name}`), `${name} has a section`)
    assert.ok(answer.text.includes(`${base}/skills/${name}/SKILL.md`), `${name} has its url`)
  }
  assert.ok(answer.text.includes('mkdir -p .claude/skills/$skill'), 'and it says how to install them')
  assert.ok(answer.text.includes('not a skill'), 'the index says it is not one itself')
  assert.doesNotMatch(answer.text, /__[A-Z]+__/)
})

test('the same list as JSON, out of the documents themselves', async (t) => {
  const { base, get, skill } = await stack(t)
  const answer = await get('/skills.json')

  const listed = (JSON.parse(answer.text) as { skills: { name: string; description: string; url: string }[] })
    .skills
  assert.deepEqual(
    listed.map((one) => one.name),
    SKILLS,
  )
  assert.equal(listed[0]!.url, `${base}/skills/hooky-send/SKILL.md`)
  // The description in the index is the one in the document, not a second copy.
  assert.equal(listed[0]!.description, frontmatter((await skill('hooky-send')).text).description)
})

test('sending needs no admin token, so that document does not teach it', async (t) => {
  const { base, skill } = await stack(t)
  const answer = await skill('hooky-send')

  assert.ok(answer.text.includes(`curl -X POST ${base}/hooks/<hook>`))
  assert.ok(answer.text.includes('x-hooky-secret'))
  assert.ok(answer.text.includes(`${base}/hooks/<hook>/async`), 'both doors are in it')
  assert.ok(answer.text.includes('Never retry on a 202'))
  assert.doesNotMatch(answer.text, /Authorization: Bearer/, 'the admin token is not this audience')
  assert.ok(answer.text.includes(`${base}/skills/hooky-manage/SKILL.md`), 'it points at its siblings')
})

test('managing is the document with the templates and the admin token', async (t) => {
  const { skill } = await stack(t)
  const answer = await skill('hooky-manage')

  assert.ok(answer.text.includes('Authorization: Bearer <admin token>'))
  assert.ok(answer.text.includes('{{payload.a.b}}'), 'templates belong where a map is written')
  assert.ok(answer.text.includes('`telegram`, `ntfy`'), 'and it names the channels that exist')
  assert.ok(answer.text.includes('/targets/telegram/run'))
})

test('the plugin document is about the repository, not about the API', async (t) => {
  const { skill } = await stack(t)
  const answer = await skill('hooky-plugin')

  assert.ok(answer.text.includes('export function apply(ctx: Context'), 'it shows the shape')
  assert.ok(answer.text.includes('notify/target'), 'and names the seams')
  assert.ok(answer.text.includes('src/plugins/channel-console.ts'), 'and points at the smallest example')
  assert.ok(answer.text.includes('pnpm typecheck'), 'and says how to check the work')
  assert.doesNotMatch(answer.text, /## What is defined here/, 'the hook table is not its job')
})

test('the history document is about reading, not about writing', async (t) => {
  const { skill } = await stack(t)
  const answer = await skill('hooky-history')

  assert.ok(answer.text.includes('/events?hook=urgent'))
  assert.ok(answer.text.includes('state=rejected'))
  assert.ok(answer.text.includes('/replay'))
  assert.doesNotMatch(answer.text, /## What is defined here/, 'the hook table is not its job')
})

test('without the admin token no document names a hook', async (t) => {
  const { ctx, skill } = await stack(t)
  await ctx.routes.create({ name: 'wake-me', targets: [{ channel: 'telegram' }] })

  for (const name of SKILLS) {
    const answer = await skill(name)
    assert.doesNotMatch(answer.text, /wake-me/, `${name} is not a directory listing`)
  }
  assert.match(
    (await skill('hooky-send')).text,
    /Not in this document\. `GET \/api\/hooks` with the admin token/,
  )
})

test('with it, the two that route calls name them', async (t) => {
  const { ctx, skill } = await stack(t)
  await ctx.routes.create({
    name: 'wake-me',
    description: 'Wakes me up.\nTelegram and ntfy both.',
    targets: [{ channel: 'telegram', map: { title: 'FIRE {{title}}' } }, { channel: 'ntfy' }],
  })
  await ctx.routes.create({ name: 'nightly', disabled: true, targets: [] })

  const both: Record<string, string>[] = [{ authorization: `Bearer ${TOKEN}` }, { 'x-hooky-secret': TOKEN }]
  for (const headers of both) {
    for (const name of ['hooky-send', 'hooky-manage']) {
      const answer = await skill(name, headers)
      assert.match(answer.text, /\| `wake-me` \| telegram \(mapped\), ntfy \| on \| own \|/, name)
      assert.match(answer.text, /\| `nightly` \| none, so a call goes nowhere \| off \|/, name)
    }
  }
  // A description is free text and a table row is one line.
  assert.ok((await skill('hooky-send', both[0]!)).text.includes('Wakes me up. Telegram and ntfy both.'))
})

test('a wrong token, and no configured secret, are both nobody', async (t) => {
  const { ctx, skill } = await stack(t)
  await ctx.routes.create({ name: 'wake-me', targets: [] })
  assert.doesNotMatch((await skill('hooky-send', { authorization: 'Bearer nope' })).text, /wake-me/)

  const open = await stack(t, { secret: '' })
  await open.ctx.routes.create({ name: 'wake-me', targets: [] })
  // The trap this guards: an empty secret must not match an empty header.
  assert.doesNotMatch((await open.skill('hooky-send')).text, /wake-me/)
  assert.doesNotMatch((await open.skill('hooky-send', { authorization: 'Bearer ' })).text, /wake-me/)
})

test('only the names it knows are served', async (t) => {
  const { get } = await stack(t)

  assert.equal((await get('/skills/hooky-nonsense/SKILL.md')).status, 404)
  assert.equal((await get('/skills/hooky-send/../../etc/passwd')).status, 404)
  assert.equal((await get('/skills/hooky-send')).status, 404, 'the document is the SKILL.md itself')
})

test('a proxy header decides the origin, junk does not', async (t) => {
  const { base, skill } = await stack(t)

  const proxied = await skill('hooky-send', {
    'x-forwarded-host': 'hooky.example.com',
    'x-forwarded-proto': 'https',
  })
  assert.ok(proxied.text.includes('https://hooky.example.com/hooks/<hook>'))

  const junk = await skill('hooky-send', { host: 'not a host name at all' })
  assert.ok(junk.text.includes(`${base}/hooks/<hook>`), 'it falls back to the bound address')
  assert.doesNotMatch(junk.text, /not a host name/)
})

test('the prefixes come from the config', async (t) => {
  const { get } = await stack(t, { prefix: '/agent-skills', hooksPrefix: '/webhooks', apiPrefix: '/admin' })

  const answer = await get('/agent-skills/hooky-manage/SKILL.md')
  assert.equal(answer.status, 200)
  assert.ok(answer.text.includes('/admin/hooks'))
  assert.ok(answer.text.includes('/agent-skills/hooky-send/SKILL.md'), 'the cross-links move too')
  assert.doesNotMatch(answer.text, /\/api\/hooks/)

  const send = await get('/agent-skills/hooky-send/SKILL.md')
  assert.ok(send.text.includes('/webhooks/<hook>'))
  assert.equal((await get('/skills/hooky-send/SKILL.md')).status, 404)
})
