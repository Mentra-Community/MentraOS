#!/usr/bin/env node
// Stamps a scaffolder's template/package.json dependency pins to the exact
// versions of the monorepo packages being published in this run, so a project
// scaffolded from the *published* tarball installs cleanly on any channel.
//
// Why: create-mentra-miniapp's template pins @mentra/miniapp + @mentra/miniapp-cli
// with caret ranges (^0.3.0) for source readability, but a caret excludes
// prereleases — so a project scaffolded off a dev-channel build (only 0.3.0-dev.0
// on npm, no stable 0.3.0) can't `bun install`. Stamping the concrete published
// version fixes it for every channel at once.
//
// Runs at publish time on the packed checkout only and is NEVER committed — same
// contract as rewrite-file-deps.mjs. The repo keeps the caret pins. No-op for any
// package without a template/package.json.
//
// Pin style: a prerelease is pinned *exact* (0.3.0-dev.0) — a caret over a
// prerelease is surprising, and an exact prerelease installs regardless of which
// dist-tag it sits on. A stable version keeps a caret (^0.3.2) so patches float.
//
// Usage: node stamp-template-versions.mjs <packageDir>
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {resolve} from 'node:path';

// Template dependency name -> source package.json (repo-root-relative) whose
// `version` is the source of truth for the stamp.
const SOURCES = {
  '@mentra/miniapp': 'mobile/modules/miniapp/package.json',
  '@mentra/miniapp-cli': 'sdk/miniapp-cli/package.json',
};

const pkgDir = process.argv[2];
if (!pkgDir) {
  console.error('usage: stamp-template-versions.mjs <packageDir>');
  process.exit(1);
}

const templatePath = resolve(pkgDir, 'template/package.json');
if (!existsSync(templatePath)) {
  console.log(`${pkgDir}: no template/package.json — nothing to stamp`);
  process.exit(0);
}

function pinFor(name) {
  const src = SOURCES[name];
  if (!src) return null;
  const version = JSON.parse(readFileSync(resolve(src), 'utf8')).version;
  if (!version) throw new Error(`${src} has no version`);
  return version.includes('-') ? version : `^${version}`;
}

const tpl = JSON.parse(readFileSync(templatePath, 'utf8'));
const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
let changed = 0;

for (const field of FIELDS) {
  const deps = tpl[field];
  if (!deps) continue;
  for (const name of Object.keys(deps)) {
    const pin = pinFor(name);
    if (!pin || deps[name] === pin) continue;
    console.log(`template ${field}.${name}  ${deps[name]} -> ${pin}`);
    deps[name] = pin;
    changed++;
  }
}

if (changed === 0) {
  console.log(`${templatePath}: no @mentra pins to stamp`);
} else {
  writeFileSync(templatePath, JSON.stringify(tpl, null, 2) + '\n');
  console.log(`stamped ${changed} template pin(s)`);
}
