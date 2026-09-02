import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import timer from '@deepseek-ai/cordis-plugin-timer'
import type { DeliveryResult } from '../src/core/types.ts'
import * as askPlugin from '../src/plugins/ask.ts'
import * as sseChannel from '../src/plugins/channel-sse.ts'
import * as hooksPlugin from '../src/plugins/hooks.ts'
import * as routesPlugin from '../src/plugins/hook-routes.ts'
import * as ingestPlugin from '../src/plugins/ingest-http.ts'
import * as serverPlugin from '../src/plugins/server-node.ts'
import * as storePlugin from '../src/plugins/store-sqlite.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** One frame, parsed the way a client reads it. */
interface Frame {
  id?: string
  event?: string
  data?: Record<string, unknown>
  comment?: string
}

/**
 * A stream, read as it arrives. `frames` fills up in the background, which is
 * the only way to assert that a subscriber heard something while it happened.
 */
async function listen(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init)
  const frames: Frame[] = []
  if (!response.body) return { response, frames, stop: () => {} }
  const controller = new AbortController()
  void (async () => {
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    controller.signal.addEventListener('abort', () => void reader.cancel().catch(() => {}))
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let cut = buffer.indexOf('\n\n')
        while (cut !== -1) {
          frames.push(parse(buffer.slice(0, cut)))
          buffer = buffer.slice(cut + 2)
          cut = buffer.indexOf('\n\n')
        }
      }
    } catch {
      // The stream was cancelled or the server went away, which the test drives.
    }
  })()
  return { response, frames, stop: () => controller.abort() }
}

function parse(block: string): Frame {
  const frame: Frame = {}
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) frame.comment = line.slice(1).trim()
    else if (line.startsWith('id: ')) frame.id = line.slice(4)
    else if (line.startsWith('event: ')) frame.event = line.slice(7)
    else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6)) as Record<string, unknown>
  }
  return frame
}

/** Wait until the background reader has collected `count` frames. */
async function until(frames: Frame[], count: number, tries = 100): Promise<Frame[]> {
  for (let attempt = 0; attempt < tries; attempt++) {
    if (frames.length >= count) return frames
    await sleep(25)
  }
  throw new Error(`only ${frames.length} of ${count} frames arrived`)
}

async function stack(t: TestContext, options: Partial<sseChannel.Config> = {}) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(timer)
  await ctx.plugin(serverPlugin, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(hooksPlugin)
  await ctx.plugin(ingestPlugin, {})
  await ctx.plugin(storePlugin, { path: ':memory:', retentionDays: 0 })
  const sseFiber = await ctx.plugin(sseChannel, { secret: 'admin-token', heartbeatMs: 0, ...options })
  // Mounted because one test asks a question over a stream. It answers at once,
  // so nothing here waits for a reply that is never coming.
  await ctx.plugin(askPlugin, { waitMs: 0 })
  await ctx.plugin(routesPlugin, { always: [] })

  const watched = await ctx.routes.create({ name: 'watched', targets: [{ channel: 'sse' }] })
  const quiet = await ctx.routes.create({ name: 'quiet', targets: [{ channel: 'console' }] })

  const base = `http://127.0.0.1:${ctx.server.address.port}`
  const post = async (hook: string, secret: string, payload: unknown) => {
    const response = await fetch(`${base}/hooks/${hook}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hooky-secret': secret },
      body: JSON.stringify(payload),
    })
    return { status: response.status, body: (await response.json()) as { results: DeliveryResult[] } }
  }

  return {
    ctx,
    sseFiber,
    base,
    post,
    watched: { name: 'watched', secret: watched.secret! },
    quiet: { name: 'quiet', secret: quiet.secret! },
  }
}

test('a subscriber gets the event as one frame', async (t) => {
  const { base, post, watched } = await stack(t)
  const { response, frames, stop } = await listen(`${base}/sse/watched?secret=${watched.secret}`)
  t.after(stop)

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform')
  assert.equal(response.headers.get('content-length'), null, 'a stream has no length')
  assert.equal(response.headers.get('x-accel-buffering'), 'no')

  const hello = (await until(frames, 1))[0]!
  assert.match(hello.comment ?? '', /listening on watched/)

  const answer = await post('watched', watched.secret, {
    title: 'deployed 4471',
    level: 'warning',
    tags: ['deploy'],
    buildId: 991,
  })
  assert.deepEqual(answer.body.results, [{ channel: 'sse', status: 'sent', attempts: 1 }])

  const frame = (await until(frames, 2))[1]!
  assert.equal(frame.event, 'message')
  assert.equal(frame.data!['title'], 'deployed 4471')
  assert.equal(frame.data!['hook'], 'watched')
  assert.equal(frame.data!['level'], 'warning')
  assert.deepEqual(frame.data!['tags'], ['deploy'])
  assert.deepEqual(frame.data!['payload'], { title: 'deployed 4471', level: 'warning', tags: ['deploy'], buildId: 991 })
  assert.equal(frame.id, frame.data!['id'], 'the sse id is the event id')
})

test('a question arrives as a list of answers, not as lines', async (t) => {
  const { base, post, watched } = await stack(t)
  const { frames, stop } = await listen(`${base}/sse/watched?secret=${watched.secret}`)
  t.after(stop)
  await until(frames, 1)

  await post('watched', watched.secret, {
    title: 'Deploy 4471?',
    message: 'to prod',
    ask: { actions: [{ title: 'yes' }] },
  })

  const frame = (await until(frames, 2))[1]!
  assert.equal(frame.data!['body'], 'to prod', 'no urls glued under the body')
  const actions = frame.data!['actions'] as { value: string; url: string }[]
  assert.equal(actions.length, 1)
  assert.equal(actions[0]!.value, 'yes')
  assert.match(actions[0]!.url, /\/ask\/reply\//)
})

test('a subscriber on another hook hears nothing', async (t) => {
  const { base, post, watched, quiet } = await stack(t)
  const { frames, stop } = await listen(`${base}/sse/watched?secret=${watched.secret}`)
  t.after(stop)
  await until(frames, 1)

  await post('quiet', quiet.secret, { title: 'not for you' })
  await sleep(200)
  assert.equal(frames.length, 1, 'only the hello frame')
})

test('nobody listening is a skip, and the retry policy is never asked', async (t) => {
  const { ctx, post, watched } = await stack(t)
  let asked = 0
  ctx.on('notify/retry', async () => {
    asked += 1
    return false
  })

  const answer = await post('watched', watched.secret, { title: 'into the void' })
  assert.deepEqual(answer.body.results, [
    { channel: 'sse', status: 'skipped', reason: 'nobody is listening on this hook' },
  ])
  assert.equal(asked, 0)
})

test('the hook secret and the admin token both open a stream', async (t) => {
  const { base, watched } = await stack(t)

  const withHook = await listen(`${base}/sse/watched`, { headers: { 'x-hooky-secret': watched.secret } })
  t.after(withHook.stop)
  assert.equal(withHook.response.status, 200)

  const withAdmin = await listen(`${base}/sse/watched`, { headers: { authorization: 'Bearer admin-token' } })
  t.after(withAdmin.stop)
  assert.equal(withAdmin.response.status, 200)

  const wrong = await fetch(`${base}/sse/watched?secret=nope`)
  assert.equal(wrong.status, 401)
  const none = await fetch(`${base}/sse/watched`)
  assert.equal(none.status, 401)

  // The secret of another hook does not open this one.
  const other = await fetch(`${base}/sse/watched`, { headers: { 'x-hooky-secret': 'hk_something_else' } })
  assert.equal(other.status, 401)
})

test('a hook that does not target sse says so instead of going silent', async (t) => {
  const { base, quiet } = await stack(t)
  const refused = await fetch(`${base}/sse/quiet?secret=${quiet.secret}`)
  assert.equal(refused.status, 409)
  assert.match(((await refused.json()) as { error: string }).error, /no 'sse' target/)

  const missing = await fetch(`${base}/sse/nosuchhook`, { headers: { authorization: 'Bearer admin-token' } })
  assert.equal(missing.status, 404)
})

test('the limit is a limit', async (t) => {
  const { base, watched } = await stack(t, { maxClients: 1 })
  const first = await listen(`${base}/sse/watched?secret=${watched.secret}`)
  t.after(first.stop)
  await until(first.frames, 1)

  const second = await fetch(`${base}/sse/watched?secret=${watched.secret}`)
  assert.equal(second.status, 503)
  await second.text()
})

test('a subscriber that walks away frees its slot', async (t) => {
  const { base, post, watched } = await stack(t, { maxClients: 1 })
  const first = await listen(`${base}/sse/watched?secret=${watched.secret}`)
  await until(first.frames, 1)
  first.stop()
  await sleep(300)

  // The slot is free, so this one gets in and hears the next event.
  const second = await listen(`${base}/sse/watched?secret=${watched.secret}`)
  t.after(second.stop)
  assert.equal(second.response.status, 200)
  await until(second.frames, 1)

  await post('watched', watched.secret, { title: 'for the second one' })
  const frame = (await until(second.frames, 2))[1]!
  assert.equal(frame.data!['title'], 'for the second one')
  assert.equal(first.frames.length, 1, 'and the one that left heard nothing more')
})

test('the heartbeat keeps an idle stream warm', async (t) => {
  const { base, watched } = await stack(t, { heartbeatMs: 60 })
  const { frames, stop } = await listen(`${base}/sse/watched?secret=${watched.secret}`)
  t.after(stop)

  const beats = await until(frames, 3)
  assert.equal(beats.filter((frame) => frame.comment === 'keepalive').length >= 2, true, JSON.stringify(beats))
})

test('unloading the plugin closes the stream', async (t) => {
  const { base, sseFiber, watched } = await stack(t)
  const { frames, stop } = await listen(`${base}/sse/watched?secret=${watched.secret}`)
  t.after(stop)
  await until(frames, 1)

  await sseFiber.dispose()
  await sleep(200)

  // The route is gone with the plugin, and so is the channel.
  const gone = await fetch(`${base}/sse/watched?secret=${watched.secret}`)
  assert.equal(gone.status, 404)
  await gone.text()
})
