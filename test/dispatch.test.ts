import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Message } from '../src/core/types.ts'
import { event, harness } from './helpers.ts'

test('een event bereikt elk kanaal dat matcht', async () => {
  const { ctx, seen } = await harness()
  const urgent: Message[] = []

  await ctx.inject(['notify'], (child) => {
    child.notify.register({
      name: 'alles',
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

  const first = await ctx.hooks.dispatch(event({ title: 'rustig' }))
  assert.deepEqual(
    first.map((result) => [result.channel, result.status]),
    [['alles', 'sent']],
  )
  assert.equal(seen.length, 1)
  assert.equal(urgent.length, 0)

  const second = await ctx.hooks.dispatch(event({ level: 'critical', title: 'brand' }))
  assert.equal(second.length, 2)
  assert.equal(urgent.length, 1)
  assert.equal(urgent[0]!.title, 'brand')

  await ctx.fiber.dispose()
})

test('skipChannels laat een kanaal dat al geleverd heeft met rust', async () => {
  const { ctx, seen } = await harness()
  await ctx.inject(['notify'], (child) => {
    child.notify.register({
      name: 'een',
      async send(message) {
        seen.push(message)
      },
    })
    child.notify.register({ name: 'twee', async send() {} })
  })

  const results = await ctx.hooks.dispatch(event(), { skipChannels: ['een'] })
  assert.deepEqual(
    results.map((result) => result.channel),
    ['twee'],
  )
  assert.equal(seen.length, 0)
  await ctx.fiber.dispose()
})

test('een kapot kanaal sleept de rest niet mee', async () => {
  const { ctx } = await harness()
  await ctx.inject(['notify'], (child) => {
    child.notify.register({
      name: 'stuk',
      async send() {
        throw new Error('kanaal ligt plat')
      },
    })
    child.notify.register({ name: 'goed', async send() {} })
  })

  const results = await ctx.hooks.dispatch(event())
  const broken = results.find((result) => result.channel === 'stuk')!
  const fine = results.find((result) => result.channel === 'goed')!
  assert.equal(broken.status, 'failed')
  assert.equal(broken.status === 'failed' && broken.error, 'kanaal ligt plat')
  assert.equal(fine.status, 'sent')
  await ctx.fiber.dispose()
})

test('een tweede kanaal met dezelfde naam wordt geweigerd', async () => {
  const { ctx } = await harness()
  await ctx.inject(['notify'], (child) => {
    child.notify.register({ name: 'dubbel', async send() {} })
  })
  await assert.rejects(
    // A Fiber is thenable but not a Promise, so assert.rejects needs a function.
    async () =>
      ctx.inject(['notify'], (child) => {
        child.notify.register({ name: 'dubbel', async send() {} })
      }),
    /already registered/,
  )
  await ctx.fiber.dispose()
})
