import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {fileURLToPath} from 'node:url'

function check(t, failures) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'example-download-'))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const count = fs.existsSync('count') ? Number(fs.readFileSync('count', 'utf8')) : 0;
fs.writeFileSync('count', String(count + 1));
if (fs.existsSync('validated-artifacts/partial.zip')) process.exit(99);
fs.mkdirSync('validated-artifacts', {recursive: true});
if (count < Number(process.env.MOCK_FAILURES)) {
  fs.writeFileSync('validated-artifacts/partial.zip', 'incomplete');
  console.error('connection reset by peer');
  process.exit(1);
}
fs.writeFileSync('validated-artifacts/example.apk', 'complete');
`, {mode: 0o755})
  writeFileSync(path.join(dir, 'sleep'), '#!/bin/sh\nexit 0\n', {mode: 0o755})
  const result = spawnSync('bash', [fileURLToPath(new URL('./download-example-artifacts.sh', import.meta.url)), '123'], {
    cwd: dir,
    encoding: 'utf8',
    env: {...process.env, PATH: `${dir}:${process.env.PATH}`, MOCK_FAILURES: String(failures), STARTER_KIT_REPOSITORY: 'example/repo'},
  })
  return {
    ...result,
    calls: Number(readFileSync(path.join(dir, 'count'), 'utf8')),
    complete: existsSync(path.join(dir, 'validated-artifacts/example.apk')),
    partial: existsSync(path.join(dir, 'validated-artifacts/partial.zip')),
  }
}

test('accepts a successful download without retrying', t => {
  const result = check(t, 0)
  assert.equal(result.status, 0)
  assert.equal(result.calls, 1)
  assert.equal(result.complete, true)
})

test('removes partial files before retrying a failed download', t => {
  const result = check(t, 2)
  assert.equal(result.status, 0)
  assert.equal(result.calls, 3)
  assert.equal(result.complete, true)
  assert.equal(result.partial, false)
})

test('fails after three unsuccessful downloads', t => {
  const result = check(t, 3)
  assert.equal(result.status, 1)
  assert.equal(result.calls, 3)
  assert.equal(result.complete, false)
  assert.match(result.stderr, /3\/3 attempts/)
})
