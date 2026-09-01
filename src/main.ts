#!/usr/bin/env node
/**
 * Entry point. Same three steps as the cordis bin, with one difference: the
 * config entry gets a fixed id, so every row in cordis.yml has a stable id
 * (`config:telegram` and not a fresh random prefix on every boot). The CLI and
 * the UI address plugins by that id, so it has to survive a restart.
 */
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { loadEnv } from './core/env.ts'

// Before the loader, which evaluates the !!js expressions in cordis.yml.
loadEnv()

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  id: 'config',
  name: '@deepseek-ai/cordis-plugin-include',
  config: { path: process.env['HOOKY_CONFIG'] ?? './cordis.yml' },
} as Parameters<typeof ctx.loader.create>[0])
