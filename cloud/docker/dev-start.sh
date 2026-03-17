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
  bun install --no-link --ignore-scripts
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
