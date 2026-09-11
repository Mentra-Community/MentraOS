#!/usr/bin/env node
// Rewrites workspace `file:` dependencies in a package's package.json to the
// referenced package's exact version, so the tarball npm publishes is installable
// by end users. npm does not resolve `file:` specifiers for consumers — it ships
// the literal `file:../..` string, which breaks `npm install` of the tarball — so
// the wrapper must point at a real published version instead.
//
// Runs on every package in the release matrix and is a no-op for packages with no
// `file:` deps (miniapp, miniapp-cli, create, auth). Today only @mentra/cli hits
// it, for its `@mentra/miniapp-cli` link.
//
// The pin is the referenced package's *exact* version. A wrapper and its base
// publish together in the same run, and an exact pin is dist-tag-agnostic: it
// resolves regardless of which tag (latest/beta/dev/alpha) the base was shipped
// under. The tradeoff is that a base bump requires republishing the wrapper to
// pick it up — acceptable while these are pre-1.0/alpha.
//
// Usage: node rewrite-file-deps.mjs <packageDir>
import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const pkgDir = process.argv[2];
if (!pkgDir) {
  console.error('usage: rewrite-file-deps.mjs <packageDir>');
  process.exit(1);
}

const pkgPath = resolve(pkgDir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const label = pkg.name || pkgDir;

const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
let changed = 0;

for (const field of DEP_FIELDS) {
  const deps = pkg[field];
  if (!deps) continue;
  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== 'string' || !spec.startsWith('file:')) continue;
    const targetPath = resolve(pkgDir, spec.slice('file:'.length), 'package.json');
    let target;
    try {
      target = JSON.parse(readFileSync(targetPath, 'utf8'));
    } catch (err) {
      throw new Error(`${label}: cannot resolve file: dep ${name} -> ${spec} (${targetPath}): ${err.message}`);
    }
    if (!target.version) throw new Error(`${label}: referenced package ${targetPath} has no version`);
    const pinned = target.version;
    console.log(`${label}: ${field}.${name}  ${spec} -> ${pinned}`);
    deps[name] = pinned;
    changed++;
  }
}

if (changed === 0) {
  console.log(`${label}: no file: deps to rewrite`);
} else {
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`${label}: rewrote ${changed} file: dep(s)`);
}
