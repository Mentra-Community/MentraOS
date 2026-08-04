#!/bin/bash
# docker/dev-start.sh — container startup for local dev
#
# Always builds workspace packages (types → display-utils+utils → sdk).
# With parallel builds this takes ~3-4 seconds — fast enough to just always do it.
# No timestamp magic, no stale dist/ footguns. Just works.

set -e
cd /app

# ─── Install dependencies ─────────────────────────────────────────────────────
# Skip if nothing changed (marker file tracks last successful install).
# Checks all workspace package.json files, not just root.

MARKER="node_modules/.cache/.install-done"

needs_install=false
if [ ! -f "$MARKER" ]; then
  needs_install=true
else
  for pjson in package.json packages/*/package.json; do
    if [ -f "$pjson" ] && [ "$pjson" -nt "$MARKER" ]; then
      needs_install=true
      break
    fi
  done
fi

if [ "$needs_install" = true ]; then
  echo "📦 Installing dependencies..."
  # Clear stale per-package symlinks first. --no-link installs leave behind
  # symlinks like packages/cloud/node_modules/axios -> .bun/axios@<OLD>/... and
  # when a dependency version bumps, those links dangle (the old .bun/<pkg>@ver
  # dir is gone) so `bun --watch` dies with ENOENT. Wiping them forces the
  # install below to regenerate links against the current versions.
  echo "🧹 Clearing stale package node_modules..."
  rm -rf packages/*/node_modules
  bun install --no-link --ignore-scripts
  # The `bun` npm package ships a postinstall that `--ignore-scripts` skips;
  # without it `bun x tsc` aborts with "Bun's postinstall script was not run."
  # Run it manually (the fix the error message itself recommends). Guarded so a
  # missing path or non-zero exit can't break startup.
  if [ -f node_modules/bun/install.js ]; then
    echo "🔧 Running bun postinstall..."
    (cd node_modules/bun && node install.js) || echo "⚠️  bun postinstall skipped"
  fi

  # --no-link hoists all deps to the root /app/node_modules but does NOT create
  # the per-package node_modules symlinks the cloud package needs at runtime.
  # `bun --watch src/index.ts` then dies with ENOENT for hoisted deps
  # (mongoose, axios, ...). Symlink every dep the cloud package declares from
  # the root install into packages/cloud/node_modules so resolution succeeds.
  echo "🔗 Linking hoisted deps into packages/cloud/node_modules..."
  mkdir -p packages/cloud/node_modules
  node -e '
    const fs = require("fs"), path = require("path");
    const pkg = JSON.parse(fs.readFileSync("packages/cloud/package.json", "utf8"));
    const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies, pkg.peerDependencies);
    const root = "node_modules", local = "packages/cloud/node_modules";
    let linked = 0;
    for (const name of Object.keys(deps)) {
      const src = path.join(process.cwd(), root, name);
      const dst = path.join(local, name);
      if (!fs.existsSync(src)) continue;          // not hoisted to root, skip
      if (fs.existsSync(dst)) continue;           // already present/linked
      const scope = path.dirname(dst);
      if (scope !== local) fs.mkdirSync(scope, { recursive: true });
      try { fs.symlinkSync(src, dst, "dir"); linked++; } catch (e) {}
    }
    console.log("  linked " + linked + " deps");
  ' || echo "⚠️  dep-link step failed (continuing)"

  mkdir -p node_modules/.cache
  touch "$MARKER"
else
  echo "📦 Dependencies up to date"
fi

# ─── Build workspace packages ─────────────────────────────────────────────────
# Always build. Order matters: types first, then display-utils + utils in
# parallel, then sdk last. Total ~3-4s.

echo "🔨 Building workspace packages..."

# 1. types (everything depends on this)
(cd packages/types && bun run build)

# 2. display-utils + utils in parallel (both depend only on types)
(cd packages/display-utils && bun run build) &
(cd packages/utils && bun run build) &
wait

# 3. sdk (depends on types + display-utils)
(cd packages/sdk && bun run build)

echo "✅ Ready"

# ─── Start the cloud server ──────────────────────────────────────────────────

echo "🚀 Starting cloud server..."
cd packages/cloud
exec bun run dev
