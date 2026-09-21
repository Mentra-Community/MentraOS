import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {checkPaths} from './check-private-docs.mjs';

test('rejects retired locations, attachments, and newly named planning files', () => {
  const paths = [
    'notes/superpowers/specs/new-feature.md',
    'agents/screenshot.png',
    'mobile/agents/ignored-but-tracked.md',
    'cloud-v2/docs/issues/099-feature/README.md',
    'asg_client/docs/mentra-live-spec.md',
    'docs/plans/new-feature.md',
    'miniapps/example/ARCHITECTURE_PLAN.md',
    'docs/new-feature-design.md',
  ];
  assert.deepEqual(checkPaths(paths), paths);
});

test('keeps public references, source files, contributor guidance, and skills', () => {
  assert.deepEqual(checkPaths([
    'mintlify-docs/glasses-oems/firmware-spec.mdx',
    'mobile/modules/bluetooth-sdk/ios/Packages/CoreObjC/spec.h',
    'scripts/pr-agent/src/plan.ts',
    'mobile/modules/miniapp/README.md',
    'AGENTS.md',
    '.agents/skills/codex-pr-review/SKILL.md',
    '.github/PULL_REQUEST_TEMPLATE.md',
    'cloud-v2/deploy/deployment-manifest-reference.md',
  ]), []);
});

test('CLI checks tracked ignored files and succeeds after their staged deletion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mentra-private-docs-'));
  const script = fileURLToPath(new URL('./check-private-docs.mjs', import.meta.url));
  try {
    execFileSync('git', ['init', '-q'], {cwd: dir});
    mkdirSync(join(dir, 'mobile/agents'), {recursive: true});
    writeFileSync(join(dir, '.gitignore'), 'mobile/agents/\n');
    writeFileSync(join(dir, 'mobile/agents/hidden.md'), '# Internal plan\n');
    execFileSync('git', ['add', '-f', 'mobile/agents/hidden.md'], {cwd: dir});
    const failed = spawnSync(process.execPath, [script], {cwd: dir, encoding: 'utf8'});
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /mobile\/agents\/hidden\.md/);
    execFileSync('git', ['rm', '-f', '--cached', 'mobile/agents/hidden.md'], {cwd: dir});
    const passed = spawnSync(process.execPath, [script], {cwd: dir, encoding: 'utf8'});
    assert.equal(passed.status, 0);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
