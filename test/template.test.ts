import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shape } from '../src/core/render.ts'
import { interpolate } from '../src/core/template.ts'
import { event } from './helpers.ts'

const sample = event({
  hook: 'deploy',
  level: 'warning',
  title: 'Release failed',
  body: 'Stage 2 of 5',
  tags: ['deploy', 'ota'],
  payload: { buildId: 88213, stages: [{ step: 'restore', status: 'ok' }, { step: 'deploy', status: 'failed' }] },
})

test('interpolate reads the event and the payload', () => {
  assert.equal(interpolate('{{title}} on {{hook}}', sample), 'Release failed on deploy')
  assert.equal(interpolate('build {{payload.buildId}}', sample), 'build 88213')
  assert.equal(interpolate('{{payload.stages.1.step}}', sample), 'deploy')
  assert.equal(interpolate('{{message}}', sample), 'Stage 2 of 5', 'message is an alias for the body')
  assert.equal(interpolate('{{ level }}', sample), 'warning', 'spaces inside the braces are fine')
})

test('a path that resolves to nothing becomes empty', () => {
  assert.equal(interpolate('[{{payload.nope}}]', sample), '[]')
  assert.equal(interpolate('[{{payload.stages.9.step}}]', sample), '[]')
  assert.equal(interpolate('[{{title.deeper}}]', sample), '[]')
  assert.equal(interpolate('[{{}}]', sample), '[{{}}]', 'an empty placeholder is not a placeholder')
})

test('a list joins and an object becomes JSON', () => {
  assert.equal(interpolate('{{tags}}', sample), 'deploy, ota')
  assert.equal(interpolate('{{payload.stages.0}}', sample), '{"step":"restore","status":"ok"}')
})

test('shape overrides only the fields the map names', () => {
  const message = {
    title: 'Release failed',
    body: 'Stage 2 of 5',
    level: 'warning' as const,
    url: 'https://build.example/88213',
    tags: ['deploy'],
    event: sample,
  }

  const shaped = shape(message, {
    title: 'fire: {{title}}',
    level: 'critical',
    tags: ['prod', '{{hook}}'],
  })

  assert.equal(shaped.title, 'fire: Release failed')
  assert.equal(shaped.level, 'critical')
  assert.deepEqual(shaped.tags, ['prod', 'deploy'])
  assert.equal(shaped.body, 'Stage 2 of 5', 'a field the map leaves out keeps its value')
  assert.equal(shaped.url, 'https://build.example/88213')
  assert.equal(shaped.event, sample, 'the event travels along untouched')
})

test('shape without a map is the identity', () => {
  const message = { title: 't', body: 'b', level: 'info' as const, tags: [], event: sample }
  assert.equal(shape(message, undefined), message)
})

test('a url template that resolves to nothing drops the url', () => {
  const message = { title: 't', body: 'b', level: 'info' as const, url: 'https://x.test', tags: [], event: sample }
  assert.equal(shape(message, { url: '{{payload.missing}}' }).url, undefined)
})
