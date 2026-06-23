# Cloud-v2 image: builds the whole monorepo, no entrypoint.
#
# Each Porter service in porter.yaml overrides `run:` to launch a different
# process from this same image (core / audio / proxy). Workspace symlinks
# mean we copy the whole tree and `bun install` resolves everything in one
# pass.

# Bun 1.3.x — earlier versions had a node:tls polyfill bug that broke
# MongoDB Atlas's SNI handshake (`TypeError: Right side of assignment
# cannot be destructured at checkServerIdentity`). 1.3.x fixed it.
FROM oven/bun:1.3.14

# ca-certificates for TLS to Mongo Atlas, Soniox, Sentry, BetterStack, etc.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy lockfile + workspace manifests first to maximize layer reuse on
# dependency-only changes (Docker layer cache).
COPY bun.lock package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/auth/package.json ./packages/auth/
COPY packages/core/package.json ./packages/core/
COPY packages/runtime/package.json ./packages/runtime/
COPY packages/proxy/package.json ./packages/proxy/
COPY packages/cloud-client/package.json ./packages/cloud-client/
COPY test/test-oem/package.json ./test/test-oem/
COPY test/test-client/package.json ./test/test-client/

# Install (frozen lockfile so reproducible deploys).
RUN bun install --frozen-lockfile

# Now the source. Comes after install so dependency changes don't invalidate
# the install layer.
COPY . .

# Typecheck as a build-time gate so we don't deploy broken type code.
RUN bun run typecheck

# All three service ports (HTTP/WS) + audio UDP. Porter's port mapping picks
# the right one per-service from porter.yaml.
EXPOSE 3000 3001 3002 8000

# No CMD — porter.yaml services set their own `run:`.
