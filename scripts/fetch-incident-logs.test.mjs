import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const raw = Buffer.from(' {"observed": "raw original é bytes"} \n');
const bundle = Buffer.from(JSON.stringify({schemaVersion: 1, kind: 'setup-diagnostic-bundle', encoding: 'base64',
  files: [{id: 'command-original', path: 'setup-evidence/firmware-command-result-123.json', size: raw.length,
    sha256: hash(raw), bytesBase64: raw.toString('base64')}]}));
const script = fileURLToPath(new URL('./fetch-incident-logs.sh', import.meta.url));

test('incident download retains original bytes and verifies/unpacks referenced command diagnostics', async () => {
  for (const corrupt of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'incident-fetch-')), out = join(root, 'output'), bin = join(root, 'bin');
    try {
      await mkdir(bin);
      const body = corrupt ? Buffer.from('corrupted archive') : bundle;
      const fixture = {detail: {report: {kind: 'automatic', status: 'ready', artifacts: [{artifactId: 'art_fixture',
        type: 'state_snapshot', source: 'framework-diagnostic', contentType: 'application/json', filename: 'diagnostics.json'}]},
        assets: [{artifactId: 'art_fixture', sizeBytes: bundle.length, sha256: hash(bundle)}]}, bodyBase64: body.toString('base64')};
      const fixturePath = join(root, 'fixture.json');
      await writeFile(fixturePath, JSON.stringify(fixture));
      const curl = join(bin, 'curl');
      await writeFile(curl, `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2), data=JSON.parse(fs.readFileSync(process.env.INCIDENT_FETCH_FIXTURE));
fs.writeFileSync(args[args.indexOf('-o')+1], args.at(-1).endsWith('/art_fixture') ? Buffer.from(data.bodyBase64,'base64') : JSON.stringify(data.detail));
process.stdout.write('200');
`);
      await chmod(curl, 0o700);
      const env = {...process.env, PATH: `${bin}:${process.env.PATH}`, MENTRA_ADMIN_TOKEN: 'fixture-only', INCIDENT_FETCH_FIXTURE: fixturePath};
      if (corrupt) {
        assert.throws(() => execFileSync('bash', [script, 'rep_fixture', '--env', 'dev', '--out', out], {env, stdio: 'pipe'}),
          error => error.status === 1 && error.stderr.toString().includes('failed verification'));
        assert.equal((await readdir(out)).some(name => name.startsWith('diagnostic-bundle-')), false);
      } else {
        execFileSync('bash', [script, 'rep_fixture', '--env', 'dev', '--out', out], {env, stdio: 'pipe'});
        const downloaded = (await readdir(out)).find(name => name.startsWith('01-'));
        assert.deepEqual(await readFile(join(out, downloaded)), bundle);
        const directory = join(out, `diagnostic-bundle-${hash(bundle)}`);
        const manifest = JSON.parse(await readFile(join(directory, 'manifest.json')));
        assert.equal(manifest.files[0].path, 'setup-evidence/firmware-command-result-123.json');
        assert.deepEqual(await readFile(join(directory, manifest.files[0].filename)), raw);
      }
    } finally {await rm(root, {recursive: true, force: true});}
  }
});
