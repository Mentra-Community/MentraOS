import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {fileURLToPath} from 'node:url'

function check(t, states) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'example-validation-'))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  writeFileSync(path.join(dir, 'states.json'), JSON.stringify(states))
  writeFileSync(path.join(dir, 'gh'), `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dir = process.env.MOCK_DIR;
const countPath = path.join(dir, 'count');
const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0;
fs.writeFileSync(countPath, String(count + 1));
const states = JSON.parse(fs.readFileSync(path.join(dir, 'states.json'), 'utf8'));
if (!states[count]) process.exit(9);
console.log(JSON.stringify(states[count]));
`, {mode: 0o755})
  writeFileSync(path.join(dir, 'sleep'), '#!/bin/sh\nexit 0\n', {mode: 0o755})
  const result = spawnSync('bash', [fileURLToPath(new URL('./wait-for-example-validation.sh', import.meta.url)), '123'], {
    encoding: 'utf8',
    env: {...process.env, PATH: `${dir}:${process.env.PATH}`, MOCK_DIR: dir, STARTER_KIT_REPOSITORY: 'example/repo'},
  })
  return {...result, calls: Number(readFileSync(path.join(dir, 'count'), 'utf8'))}
}

test('fails as soon as a job fails even while another job is running', t => {
  const result = check(t, [{status: 'in_progress', conclusion: '', jobs: [
    {name: 'React Native', conclusion: 'failure'}, {name: 'macOS', conclusion: ''},
  ]}])
  assert.equal(result.status, 1)
  assert.equal(result.calls, 1)
  assert.match(result.stderr, /React Native: failure/)
})

test('waits for running jobs and accepts successful validation with skipped jobs', t => {
  const result = check(t, [
    {status: 'in_progress', conclusion: '', jobs: [{name: 'build', conclusion: null}]},
    {status: 'completed', conclusion: 'success', jobs: [{name: 'build', conclusion: 'success'}, {name: 'optional', conclusion: 'skipped'}]},
  ])
  assert.equal(result.status, 0)
  assert.equal(result.calls, 2)
})

test('fails cancelled or timed-out jobs without waiting for the workflow', t => {
  for (const conclusion of ['cancelled', 'timed_out']) {
    const result = check(t, [{status: 'in_progress', conclusion: '', jobs: [{name: 'build', conclusion}]}])
    assert.equal(result.status, 1)
    assert.equal(result.calls, 1)
  }
})

test('rejects a failed workflow even when no failed job is reported', t => {
  const result = check(t, [{status: 'completed', conclusion: 'failure', jobs: []}])
  assert.equal(result.status, 1)
  assert.match(result.stderr, /concluded failure/)
})
