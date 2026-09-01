import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadEnv } from '../src/core/env.ts'

test('loadEnv fills in what is missing and leaves an exported value alone', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'hooky-env-')), '.env')
  writeFileSync(path, 'HOOKY_TEST_FROM_FILE=file\nHOOKY_TEST_EXPORTED=file\n')
  process.env['HOOKY_TEST_EXPORTED'] = 'exported'

  assert.equal(loadEnv(path), true)
  assert.equal(process.env['HOOKY_TEST_FROM_FILE'], 'file')
  assert.equal(process.env['HOOKY_TEST_EXPORTED'], 'exported')

  delete process.env['HOOKY_TEST_FROM_FILE']
  delete process.env['HOOKY_TEST_EXPORTED']
})

test('a missing env file is not an error', () => {
  assert.equal(loadEnv(join(tmpdir(), 'hooky-no-such-dir', '.env')), false)
})
