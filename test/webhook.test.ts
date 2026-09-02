import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { render } from '../src/core/render.ts'
import type { HookTarget } from '../src/core/routes.ts'
import type { DeliveryResult, Message, MessageAction } from '../src/core/types.ts'
import { frameOf } from '../src/plugins/channel-sse.ts'
import * as webhookChannel from '../src/plugins/channel-webhook.ts'
import * as hooksPlugin from '../src/plugins/hooks.ts'
import { captureFetch, event } from './helpers.ts'

/** The channel on its own, plus a way to deliver one target through it. */
async function stack(config: Partial<webhookChannel.Config> = {}) {
  const ctx = new Context()
  await ctx.plugin(hooksPlugin)
  await ctx.plugin(webhookChannel, config)
  const deliver = (message: Message, target: Partial<HookTarget> = {}): Promise<DeliveryResult> =>
    ctx.notify.deliverTo(message, { channel: 'webhook', ...target })
  return { ctx, deliver }
}

const headersOf = (init: RequestInit) => init.headers as Record<string, string>

test('the default body is the event as one json envelope, the shape sse streams', async () => {
  const { calls, restore } = captureFetch()
  try {
    const { ctx } = await stack({ url: 'https://flows.test/hook' })
    const results = await ctx.hooks.dispatch(
      event({ title: 'api is down', body: '3 checks failed', level: 'error', tags: ['prod'], payload: { buildId: 991 } }),
    )
    assert.equal(results[0]!.status, 'sent')
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url, 'https://flows.test/hook')
    assert.equal(calls[0]!.init.method, 'POST')

    const headers = headersOf(calls[0]!.init)
    assert.equal(headers['content-type'], 'application/json')
    assert.equal(headers['user-agent'], 'hooky')
    assert.equal(headers['x-hooky-hook'], 'test')

    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    assert.equal(body['title'], 'api is down')
    assert.equal(body['body'], '3 checks failed')
    assert.equal(body['level'], 'error')
    assert.deepEqual(body['tags'], ['prod'])
    assert.deepEqual(body['payload'], { buildId: 991 })
    assert.equal(headers['x-hooky-event'], body['id'], 'the header names the event in the body')
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('sse and webhook send the same envelope for the same message', async () => {
  const { calls, restore } = captureFetch()
  try {
    const { ctx, deliver } = await stack({ url: 'https://flows.test/hook' })
    const message = render(event({ title: 'one shape', body: 'for both', payload: { a: 1 } }))
    await deliver(message)
    const posted = JSON.parse(String(calls[0]!.init.body)) as unknown
    const streamed = JSON.parse(frameOf(message).split('data: ')[1]!.trim()) as unknown
    assert.deepEqual(posted, streamed)
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('a body template composes with the map of its target', async () => {
  const { calls, restore } = captureFetch()
  try {
    const { ctx, deliver } = await stack()
    await deliver(render(event({ title: 'api is down', payload: { buildId: 991 } })), {
      map: { title: 'FIRE {{title}}' },
      settings: {
        url: 'https://flows.test/hook',
        body: '{"text": "{{title}}", "build": "{{payload.buildId}}", "hook": "{{hook}}"}',
      },
    })
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
      text: 'FIRE api is down',
      build: '991',
      hook: 'test',
    })
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('a quote or a newline in a title cannot break a json body', async () => {
  const { calls, restore } = captureFetch()
  try {
    const { ctx, deliver } = await stack()
    const title = 'he said "no"\nand left\\'
    await deliver(render(event({ title })), {
      settings: { url: 'https://flows.test/hook', body: '{"text": "{{title}}"}' },
    })
    // Valid JSON, and the value survived intact.
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { text: title })
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('a form body is percent-encoded instead', async () => {
  const { calls, restore } = captureFetch()
  try {
    const { ctx, deliver } = await stack()
    await deliver(render(event({ title: 'a & b' })), {
      settings: {
        url: 'https://flows.test/hook',
        headers: 'content-type: application/x-www-form-urlencoded',
        body: 'title={{title}}&hook={{hook}}',
      },
    })
    assert.equal(String(calls[0]!.init.body), 'title=a%20%26%20b&hook=test')
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('a plain text body goes in as it stands', async () => {
  const { calls, restore } = captureFetch()
  try {
    const { ctx, deliver } = await stack()
    await deliver(render(event({ title: 'a & b "quoted"' })), {
      settings: {
        url: 'https://flows.test/hook',
        headers: 'content-type: text/plain',
        body: '{{title}}',
      },
    })
    assert.equal(String(calls[0]!.init.body), 'a & b "quoted"')
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('headers merge, the target overrides the row, and a comment is not a header', async () => {
  const { calls, restore } = captureFetch()
  try {
    const { ctx, deliver } = await stack({
      url: 'https://flows.test/hook',
      headers: 'x-from-row: yes\nx-both: row',
    })
    await deliver(render(event({ hook: 'deploys' })), {
      settings: { headers: '# which flow this is for\nx-both: target\nx-hook: {{hook}}' },
    })
    const headers = headersOf(calls[0]!.init)
    assert.equal(headers['x-from-row'], 'yes')
    assert.equal(headers['x-both'], 'target', 'the target has the last word')
    assert.equal(headers['x-hook'], 'deploys', 'and a template in the value resolves')
    assert.equal('# which flow this is for' in headers, false)
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('a newline out of a template cannot write a header of its own', async () => {
  const { calls, restore } = captureFetch()
  try {
    const { ctx, deliver } = await stack()
    await deliver(render(event({ title: 'first\nx-injected: yes' })), {
      settings: { url: 'https://flows.test/hook', headers: 'x-title: {{title}}' },
    })
    const headers = headersOf(calls[0]!.init)
    assert.equal(headers['x-title'], 'first x-injected: yes')
    assert.equal('x-injected' in headers, false)
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('a get carries no body, and a lower case method is still a method', async () => {
  const { calls, restore } = captureFetch()
  try {
    const { ctx, deliver } = await stack()
    await deliver(render(event({ title: 'ping' })), {
      settings: { url: 'https://flows.test/ping?title={{title}}', method: 'get' },
    })
    assert.equal(calls[0]!.init.method, 'GET')
    assert.equal(calls[0]!.init.body, undefined)
    assert.equal('content-type' in headersOf(calls[0]!.init), false)
    assert.equal(calls[0]!.url, 'https://flows.test/ping?title=ping', 'the url is a template too')

    await deliver(render(event()), { settings: { url: 'https://flows.test/hook', method: ' put ' } })
    assert.equal(calls[1]!.init.method, 'PUT')
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('a url out of the payload is a destination the caller chose', async () => {
  const { calls, restore } = captureFetch()
  try {
    const { ctx, deliver } = await stack()
    await deliver(render(event({ payload: { callbackUrl: 'https://agent.test/done' } })), {
      settings: { url: '{{payload.callbackUrl}}' },
    })
    assert.equal(calls[0]!.url, 'https://agent.test/done')
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('a misconfigured target is skipped, with the reason, and never retried', async () => {
  const { calls, restore } = captureFetch()
  try {
    const { ctx, deliver } = await stack()
    let retried = 0
    ctx.on('notify/retry', async () => {
      retried += 1
      return false
    })

    const cases: [Partial<HookTarget>, RegExp][] = [
      [{}, /no url: set one on this target, or a default on the webhook row/],
      [{ settings: { url: 'not-a-url' } }, /is not a url/],
      [{ settings: { url: 'file:///etc/passwd' } }, /is not http or https/],
      [{ settings: { url: 'https://flows.test/hook', method: 'PUTT' } }, /is not one of POST, PUT, PATCH, DELETE, GET/],
      [{ settings: { url: 'https://flows.test/hook', headers: 'authorization Bearer x' } }, /is not a header/],
    ]
    for (const [target, reason] of cases) {
      const result = await deliver(render(event()), target)
      assert.equal(result.status, 'skipped', JSON.stringify(result))
      assert.match(result.status === 'skipped' ? result.reason : '', reason)
    }
    assert.equal(calls.length, 0, 'nothing left the building')
    assert.equal(retried, 0, 'a skip never asks the retry policy')
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('a non-2xx is a failure that quotes what the other side said', async () => {
  const { restore } = captureFetch(() => new Response('flow disabled', { status: 503 }))
  try {
    const { ctx, deliver } = await stack()
    const result = await deliver(render(event()), { settings: { url: 'https://flows.test/hook' } })
    assert.equal(result.status, 'failed')
    assert.match(result.status === 'failed' ? result.error : '', /webhook responded 503: flow disabled/)
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('a question goes out as structured answers, with the body left alone', async () => {
  const { calls, restore } = captureFetch()
  try {
    const { ctx, deliver } = await stack()
    const actions: MessageAction[] = [
      { value: 'yes', title: 'yes', url: 'https://h.test/ask/reply/a1/yes', reply: true },
      { value: 'no', title: 'no', url: 'https://h.test/ask/reply/a1/no', reply: true },
    ]
    const message: Message = { ...render(event({ body: 'to prod' })), actions }
    await deliver(message, { settings: { url: 'https://flows.test/hook' } })

    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>
    assert.equal(body['body'], 'to prod', 'no urls glued under the body')
    assert.deepEqual(body['actions'], actions)
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})

test('the channel name is configuration, so two rows are two destinations', async () => {
  const { calls, restore } = captureFetch()
  try {
    const ctx = new Context()
    await ctx.plugin(hooksPlugin)
    await ctx.plugin(webhookChannel, { channel: 'webhook-n8n', url: 'https://n8n.test/a' })
    await ctx.plugin(webhookChannel, { channel: 'webhook-ha', url: 'https://ha.test/b' })

    const results = await ctx.hooks.dispatch(event({ title: 'both' }))
    assert.deepEqual(results.map((result) => result.status).sort(), ['sent', 'sent'])
    assert.deepEqual(
      calls.map((call) => call.url).sort(),
      ['https://ha.test/b', 'https://n8n.test/a'],
    )
    await ctx.fiber.dispose()
  } finally {
    restore()
  }
})
