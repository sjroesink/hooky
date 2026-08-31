import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import * as consoleChannel from '../src/plugins/channel-console.ts'
import * as hooksPlugin from '../src/plugins/hooks.ts'
import * as serverPlugin from '../src/plugins/server-node.ts'
import { event } from './helpers.ts'

/**
 * The property the paper calls temporal composability: unloading a plugin undoes
 * everything it registered, without the core keeping a list of who did what.
 */

test('een kanaal verdwijnt met zijn plugin', async () => {
  const ctx = new Context()
  await ctx.plugin(hooksPlugin)

  const fiber = await ctx.plugin(consoleChannel, { channel: 'console' })
  assert.deepEqual(ctx.notify.names, ['console'])

  await fiber.dispose()
  assert.deepEqual(ctx.notify.names, [])

  // And nothing is delivered any more, without the pipeline erroring.
  assert.deepEqual(await ctx.hooks.dispatch(event()), [])
  await ctx.fiber.dispose()
})

test('de poort is vrij na unload, en de route is weg', async () => {
  const ctx = new Context()
  const fiber = await ctx.plugin(serverPlugin, { host: '127.0.0.1', port: 0 })
  const { port } = ctx.server.address
  assert.ok(port > 0)

  const disposeRoute = ctx.server.route('GET', '/ping', () => ({ status: 200, body: 'pong' }))
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/ping`)).text(), 'pong')

  await disposeRoute()
  assert.equal((await fetch(`http://127.0.0.1:${port}/ping`)).status, 404)

  await fiber.dispose()
  await assert.rejects(async () => reachable(port), /ECONNREFUSED|ECONNRESET/)
  await ctx.fiber.dispose()
})

test('twee fibers van hetzelfde plugin zijn twee kanalen', async () => {
  const ctx = new Context()
  await ctx.plugin(hooksPlugin)
  await ctx.plugin(consoleChannel, { channel: 'alles' })
  await ctx.plugin(consoleChannel, { channel: 'kritiek', match: { minLevel: 'critical' } })

  assert.deepEqual(ctx.notify.names, ['alles', 'kritiek'])
  const results = await ctx.hooks.dispatch(event({ level: 'info' }))
  assert.deepEqual(
    results.map((result) => result.channel),
    ['alles'],
  )
  await ctx.fiber.dispose()
})

function reachable(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.on('connect', () => {
      socket.destroy()
      resolve()
    })
    socket.on('error', reject)
  })
}
