import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as agentsPlugin from '../src/plugins/agents-txt.ts'
import * as serverPlugin from '../src/plugins/server-node.ts'
import * as skillPlugin from '../src/plugins/skill.ts'

const SKILLS = ['hooky-send', 'hooky-manage', 'hooky-history', 'hooky-plugin']

async function stack(t: TestContext, config: Partial<agentsPlugin.Config> = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(serverPlugin, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(agentsPlugin, config)

  const base = `http://127.0.0.1:${ctx.server.address.port}`
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, { headers })
    return { status: response.status, headers: response.headers, text: await response.text() }
  }
  const txt = (headers: Record<string, string> = {}) => get('/agents.txt', headers)
  const json = async (headers: Record<string, string> = {}) =>
    JSON.parse((await get('/agents.json', headers)).text) as Record<string, any>

  return { ctx, base, get, txt, json }
}

/**
 * The parsing rules from the spec, so the assertions read the file the way an
 * agent would: `#` is a comment, blank lines are ignored, the key is what sits
 * before the first colon, and values are comma separated and trimmed.
 */
function parse(text: string): Record<string, string[]> {
  const found: Record<string, string[]> = {}
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue
    const at = line.indexOf(':')
    assert.ok(at > 0, `not a directive: ${line}`)
    const key = line.slice(0, at)
    const values = line
      .slice(at + 1)
      .split(',')
      .map((value) => value.trim())
    found[key] = [...(found[key] ?? []), ...values]
  }
  return found
}

test('agents.txt is served with the headers the spec asks for', async (t) => {
  const { base, txt } = await stack(t)
  const answer = await txt()

  assert.equal(answer.status, 200)
  assert.equal(answer.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.equal(answer.headers.get('access-control-allow-origin'), '*')
  assert.equal(answer.headers.get('cache-control'), 'public, max-age=3600')

  const lines = answer.text.split('\n')
  assert.equal(lines[0], '# agents.txt')
  assert.equal(lines[1], '# Standard: https://agents-txt.com')
  assert.equal(lines[2], `# JSON: ${base}/agents.json`)
  assert.ok(answer.text.endsWith('\n'), 'the file ends with a newline')
})

test('agents.json carries what the schema requires and nothing empty', async (t) => {
  const { base, get, json } = await stack(t)
  const raw = await get('/agents.json')

  // Exactly application/json, so a reader that compares the header literally is
  // satisfied too.
  assert.equal(raw.headers.get('content-type'), 'application/json')
  assert.equal(raw.headers.get('access-control-allow-origin'), '*')

  const document = await json()
  assert.equal(document['$schema'], 'https://agents-txt.com/schema/agents-json/v1.0.json')
  assert.equal(document['version'], '1.0')
  assert.equal(document['standard'], 'https://agents-txt.com')
  assert.deepEqual(document['site'], {
    name: 'Hooky',
    url: base,
    description: 'Webhook receiver that turns a call into a notification.',
  })
  // An empty capability is not a declaration, so it is left out entirely.
  assert.deepEqual(Object.keys(document), ['$schema', 'version', 'standard', 'site'])
})

test('the skill plugin declares its own documents in both files', async (t) => {
  const { ctx, base, txt, json } = await stack(t)
  await ctx.plugin(skillPlugin, {})

  const parsed = parse((await txt()).text)
  assert.deepEqual(
    parsed['Skills'],
    SKILLS.map((skill) => `${base}/skills/${skill}/SKILL.md`),
  )

  const listed = (await json())['skills'] as { url: string; description: string }[]
  assert.equal(listed.length, SKILLS.length)
  for (const entry of listed) {
    assert.ok(entry.description.length > 80, `${entry.url} says when to use it`)
    // The url is not a guess: it is the one the skill plugin actually serves.
    assert.equal((await fetch(entry.url)).status, 200, entry.url)
  }
})

test('unloading the skill plugin takes the Skills lines with it', async (t) => {
  const { ctx, txt, json } = await stack(t)
  const fiber = await ctx.plugin(skillPlugin, {})
  assert.ok((await txt()).text.includes('Skills: '))

  await fiber.dispose()
  assert.ok(!(await txt()).text.includes('Skills: '))
  assert.equal((await json())['skills'], undefined)
})

test('a moved skill prefix moves the urls, without a second place to edit', async (t) => {
  const { ctx, base, txt } = await stack(t)
  await ctx.plugin(skillPlugin, { prefix: '/agent-skills' })

  const parsed = parse((await txt()).text)
  assert.equal(parsed['Skills']?.[0], `${base}/agent-skills/hooky-send/SKILL.md`)
})

test('what the operator declares lands in both files', async (t) => {
  const { txt, json } = await stack(t, {
    mcp: [{ url: 'https://example.test/mcp', description: 'The tools' }],
    a2a: [{ url: 'https://example.test/.well-known/agent-card.json' }],
    ucp: [{ url: 'https://example.test/.well-known/ucp' }],
    webmcp: [{ url: 'https://example.test/webmcp' }],
    authProtocols: ['oauth2', 'x-hooky-secret'],
    authIdentity: true,
    authDiscovery: 'https://example.test/skills/hooky-send/SKILL.md',
  })

  const parsed = parse((await txt()).text)
  assert.deepEqual(parsed['MCP'], ['https://example.test/mcp'])
  assert.deepEqual(parsed['A2A'], ['https://example.test/.well-known/agent-card.json'])
  assert.deepEqual(parsed['UCP'], ['https://example.test/.well-known/ucp'])
  assert.deepEqual(parsed['WebMCP'], ['https://example.test/webmcp'])
  assert.deepEqual(parsed['Authorization'], ['oauth2', 'x-hooky-secret'])
  assert.deepEqual(parsed['Identity'], ['required'])

  const document = await json()
  assert.deepEqual(document['mcp'], [
    { url: 'https://example.test/mcp', description: 'The tools', type: 'streamable-http' },
  ])
  assert.deepEqual(document['authorization'], {
    protocols: ['oauth2', 'x-hooky-secret'],
    identity: 'required',
    discovery: 'https://example.test/skills/hooky-send/SKILL.md',
  })
})

test('a protocol without a discovery url is not a declaration', async (t) => {
  const { txt, json } = await stack(t, { authProtocols: ['oauth2'], authIdentity: true })

  assert.ok(!(await txt()).text.includes('Authorization'))
  assert.ok(!(await txt()).text.includes('Identity'))
  assert.equal((await json())['authorization'], undefined)
})

test('every line parses by the rules in the spec, blocks kept apart', async (t) => {
  const { ctx, txt } = await stack(t, {
    mcp: [{ url: 'https://example.test/mcp' }],
    authProtocols: ['agent-auth'],
    authDiscovery: 'https://example.test/.well-known/agent-configuration',
  })
  await ctx.plugin(skillPlugin, {})
  const text = (await txt()).text

  // parse() asserts the shape of every line it reads.
  const parsed = parse(text)
  assert.deepEqual(Object.keys(parsed), ['Authorization', 'MCP', 'Skills'])
  assert.ok(text.includes('\n\n'), 'capability blocks are separated by a blank line')
  assert.ok(!text.includes('\n\n\n'), 'and by one blank line, not two')
  for (const line of text.split('\n')) assert.equal(line, line.trim(), `no stray whitespace: ${line}`)
})

test('the origin is the one the caller reached', async (t) => {
  const { ctx, base, txt, json } = await stack(t)
  await ctx.plugin(skillPlugin, {})

  const proxied = { 'x-forwarded-host': 'hooky.example.com', 'x-forwarded-proto': 'https' }
  const text = (await txt(proxied)).text
  assert.ok(text.includes('# JSON: https://hooky.example.com/agents.json'))
  assert.ok(text.includes('Skills: https://hooky.example.com/skills/hooky-send/SKILL.md'))
  assert.equal((await json(proxied))['site'].url, 'https://hooky.example.com')

  const junk = await txt({ host: 'not a host name at all' })
  assert.ok(junk.text.includes(`# JSON: ${base}/agents.json`), 'junk falls back to the bound address')
  assert.ok(!junk.text.includes('not a host name'))
})

test('a configured site url wins, and the endpoint urls stay reachable', async (t) => {
  const { ctx, base, json } = await stack(t, { siteUrl: 'https://hooky.example.com', siteDescription: '' })
  await ctx.plugin(skillPlugin, {})

  const document = await json()
  assert.deepEqual(document['site'], { name: 'Hooky', url: 'https://hooky.example.com' })
  assert.equal((document['skills'] as { url: string }[])[0]?.url, `${base}/skills/hooky-send/SKILL.md`)
})

test('robots.txt is off until it is asked for', async (t) => {
  const plain = await stack(t)
  assert.equal((await plain.get('/robots.txt')).status, 404)

  const serving = await stack(t, { robots: true })
  const answer = await serving.get('/robots.txt')
  assert.equal(answer.status, 200)
  assert.equal(answer.headers.get('content-type'), 'text/plain; charset=utf-8')
  assert.ok(answer.text.includes('User-agent: *'))
  assert.ok(answer.text.includes('Allow: /agents.txt'))
  assert.ok(answer.text.includes('Disallow: /'), 'the rest of a Hooky instance is nobody else business')
})

test('no cache means no-store, which is what a dev instance wants', async (t) => {
  const { get } = await stack(t, { cacheSeconds: 0 })
  assert.equal((await get('/agents.txt')).headers.get('cache-control'), 'no-store')
  assert.equal((await get('/agents.json')).headers.get('cache-control'), 'no-store')
})

test('any plugin can declare an endpoint, and it leaves with that plugin', async (t) => {
  const { ctx, txt, json } = await stack(t)
  const fiber = await ctx.plugin({
    name: 'ucp-profile',
    apply(child: Context) {
      child.on('agents/declare', async (_document, origin, next) => {
        const base = await next()
        return { ...base, ucp: [...base.ucp, { url: `${origin}/profiles/b2b.json` }] }
      })
    },
  })

  assert.deepEqual(parse((await txt()).text)['UCP']?.length, 1)
  assert.equal(((await json())['ucp'] as { url: string }[])[0]?.url.endsWith('/profiles/b2b.json'), true)

  await fiber.dispose()
  assert.equal((await json())['ucp'], undefined)
})
