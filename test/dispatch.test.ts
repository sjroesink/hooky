import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Message } from '../src/core/types.ts'
import { event, harness } from './helpers.ts'

test('an event reaches every channel whose matcher accepts it', async () => {
  const { ctx, seen } = await harness()
  const urgent: Message[] = []

  await ctx.inject(['notify'], (child) => {
    child.notify.register({
      name: 'all',
      async send(message) {
        seen.push(message)
      },
    })
    child.notify.register({
      name: 'urgent',
      match: { minLevel: 'error' },
      async send(message) {
        urgent.push(message)
      },
    })
  })

  const first = await ctx.hooks.dispatch(event({ title: 'quiet' }))
  assert.deepEqual(
    first.map((result) => [result.channel, result.status]),
    [['all', 'sent']],
  )
  assert.equal(seen.length, 1)
  assert.equal(urgent.length, 0)

  const second = await ctx.hooks.dispatch(event({ level: 'critical', title: 'fire' }))
  assert.equal(second.length, 2)
  assert.equal(urgent.length, 1)
  assert.equal(urgent[0]!.title, 'fire')

  await ctx.fiber.dispose()
})

test('skipChannels leaves a channel that already delivered alone', async () => {
  const { ctx, seen } = await harness()
  await ctx.inject(['notify'], (child) => {
    child.notify.register({
      name: 'one',
      async send(message) {
        seen.push(message)
      },
    })
    child.notify.register({ name: 'two', async send() {} })
  })

  const results = await ctx.hooks.dispatch(event(), { skipChannels: ['one'] })
  assert.deepEqual(
    results.map((result) => result.channel),
    ['two'],
  )
  assert.equal(seen.length, 0)
  await ctx.fiber.dispose()
})

test('a broken channel does not take the others down', async () => {
  const { ctx } = await harness()
  await ctx.inject(['notify'], (child) => {
    child.notify.register({
      name: 'broken',
      async send() {
        throw new Error('channel is down')
      },
    })
    child.notify.register({ name: 'good', async send() {} })
  })

  const results = await ctx.hooks.dispatch(event())
  const broken = results.find((result) => result.channel === 'broken')!
  const fine = results.find((result) => result.channel === 'good')!
  assert.equal(broken.status, 'failed')
  assert.equal(broken.status === 'failed' && broken.error, 'channel is down')
  assert.equal(fine.status, 'sent')
  await ctx.fiber.dispose()
})

test('a second channel with the same name is refused', async () => {
  const { ctx } = await harness()
  await ctx.inject(['notify'], (child) => {
    child.notify.register({ name: 'duplicate', async send() {} })
  })
  await assert.rejects(
    // A Fiber is thenable but not a Promise, so assert.rejects needs a function.
    async () =>
      ctx.inject(['notify'], (child) => {
        child.notify.register({ name: 'duplicate', async send() {} })
      }),
    /already registered/,
  )
  await ctx.fiber.dispose()
})
