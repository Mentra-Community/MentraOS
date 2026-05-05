# MentraOS — Local Setup & Run Commands

End-to-end command reference to bring up the MentraOS stack (cloud backend, mobile app, repo root, and the Camera Example App + smoke test) including Docker and zrok tunnels.

---

## 0. One-time Prerequisites

Install these before any of the steps below.

```bash
# Package manager / runtime
brew install bun                    # https://bun.sh/docs/installation
brew install --cask docker          # Docker Desktop (must be running)

# Tunnel
brew install zrok                   # https://docs.zrok.io/

# Mobile toolchains
brew install --cask android-studio
xcode-select --install              # iOS toolchain (Xcode + CLI tools)

# Python (for the smoke-test only)
curl -LsSf https://astral.sh/uv/install.sh | sh

# Node version (use nvm to pin Node 20.x)
nvm install 20 && nvm use 20
```

One-time zrok account setup (skip if you've already enabled your env):

```bash
zrok invite                         # if you don't have an account
zrok enable <your-zrok-token>
```

---

## 0b. Supabase (External Dependency)

The mobile app reads `EXPO_PUBLIC_SUPABASE_URL=http://192.168.0.189:8000` — the Kong gateway of a self-hosted Supabase stack that lives **outside this repo** at `/Volumes/black/black_sites/trulyprivate/supabase-project`. It must be running before the mobile app can authenticate.

```bash
cd /Volumes/black/black_sites/trulyprivate/supabase-project

# Bring up the full stack (creates any missing containers, idempotent for healthy ones)
docker compose up -d

# Check status
docker compose ps
```

Expected services (13): `db`, `kong`, `auth`, `rest`, `realtime`, `storage`, `imgproxy`, `meta`, `studio`, `edge-functions`, `analytics`, `vector`, `pooler`. Eleven report healthy; `rest` and `edge-functions` have no healthcheck (status `Up` is normal).

Endpoints:

- Kong API gateway: `http://localhost:8000`
- Analytics (Logflare): `http://localhost:4000`
- Studio: `http://localhost:8000` via Kong (or `:3000` if exposed)

**Gotcha — `could not find analytics: not found`:** `docker compose start` only restarts already-created containers. If `supabase-analytics` was never created (e.g., a prior `up` failed), `start` errors out. Always use `docker compose up -d` to (re)create missing services. Required env in that project's `.env`: `LOGFLARE_PUBLIC_ACCESS_TOKEN` and `LOGFLARE_PRIVATE_ACCESS_TOKEN`.

---

## 1. Repo Root — [/Users/hiyabuddy/sites/brendancopley/MentraOS](.)

The root only owns lint/format tooling and license generation; there is no `bun run dev` here. Use it for repo-wide tasks.

```bash
cd /Users/hiyabuddy/sites/brendancopley/MentraOS

# Install root devDependencies (husky, eslint, prettier)
bun install

# Optional housekeeping
bun run prepare                      # husky hooks
bun run generate-licenses            # docs/generate-licenses.ts
```

---

## 2. Cloud Backend — [/Users/hiyabuddy/sites/brendancopley/MentraOS/cloud](cloud/)

The cloud stack runs in Docker via `docker-compose.dev.yml` (cloud service exposed on **:8002**, UDP **:8000**).

### 2a. First-time setup

```bash
cd /Users/hiyabuddy/sites/brendancopley/MentraOS/cloud

# Copy env template (file is gitignored — fill in secrets)
cp .env.example .env

# Install dependencies (no-link avoids workspace link errors)
bun install --no-link
# or
bun run setup-deps

# Build workspace packages (types → display-utils+utils → sdk)
bun run build
```

### 2b. Run the dev stack (Docker)

```bash
cd /Users/hiyabuddy/sites/brendancopley/MentraOS/cloud

# Foreground — stops any prior stack, rebuilds, then `up`
bun run dev

# Detached
bun run dev:detached

# Rebuild containers (use after dependency / Dockerfile changes)
bun run dev:rebuild

# Stop the stack
bun run dev:stop

# Nuke volumes + prune (full reset)
bun run dev:clean
```

### 2c. Raw Docker equivalents

```bash
cd /Users/hiyabuddy/sites/brendancopley/MentraOS/cloud

# Up
docker compose -f docker-compose.dev.yml -p dev up
docker compose -f docker-compose.dev.yml -p dev up -d --build --remove-orphans

# Down
docker compose -f docker-compose.dev.yml -p dev down --timeout 5

# Logs
docker compose -f docker-compose.dev.yml -p dev logs -f --tail=50
docker compose -f docker-compose.dev.yml -p dev logs -f --tail=100 cloud

# LiveKit variant
docker compose -f docker-compose.dev.livekit.yml -p dev up -d --build --remove-orphans
```

Convenience wrappers (same as above):

```bash
bun run logs                         # all services
bun run logs:cloud                   # cloud service only
bun run dev:livekit                  # LiveKit-enabled compose
```

### 2d. Sub-apps inside cloud

```bash
cd /Users/hiyabuddy/sites/brendancopley/MentraOS/cloud

bun run console                      # websites/console dev server
bun run store                        # websites/store dev server
bun run captions                     # packages/apps/captions
```

### 2e. Tests / lint

```bash
cd /Users/hiyabuddy/sites/brendancopley/MentraOS/cloud
bun run test
bun run test:bun
cd packages/cloud && bun run lint
```

### 2f. Expose cloud via zrok

The cloud HTTP/WS port is **8002**. Pick a stable share name (used by mobile + smoke-test).

```bash
# Reserved (recommended) — gives you a stable subdomain
zrok reserve public 8002 --unique-name mentracloud
zrok share reserved mentracloud

# Or ephemeral (random URL each time)
zrok share public http://localhost:8002
```

Resulting URL is typically `https://mentracloud.share.zrok.io` (HTTP) and `wss://mentracloud.share.zrok.io/app-ws` (WebSocket).

---

## 3. Mobile App — [/Users/hiyabuddy/sites/brendancopley/MentraOS/mobile](mobile/)

React Native + Expo app. The cloud stack must be reachable (locally or via zrok) before the app will be useful.

### 3a. First-time setup

```bash
cd /Users/hiyabuddy/sites/brendancopley/MentraOS/mobile

# Install JS deps (also runs preinstall + postinstall zx scripts)
bun install

# iOS native deps
cd ios && pod install && cd ..
```

### 3b. Run

```bash
cd /Users/hiyabuddy/sites/brendancopley/MentraOS/mobile

# Metro / Expo dev server
bun start

# Build + launch on platform
bun ios
bun android

# Release builds
bun run ios:release
bun run android:release
bun run build:android:release
bun run build:google:play
bun run upload:google:play

# Android emulator: forward ports for cloud + Metro
bun adb            # tcp:9090, tcp:3000, tcp:9001, tcp:8081
```

### 3c. Logs / tests / lint

```bash
cd /Users/hiyabuddy/sites/brendancopley/MentraOS/mobile

bun run dev:logs                     # start.mjs piped through log viewer
bun run dev:logs-dashboard
bun run dev:logs-filter <pattern>

bun test
bun test:watch
bun test:maestro                     # Maestro E2E

bun run lint
bun run compile                      # tsc --noEmit
```

### 3d. Mobile + zrok

The mobile app talks to the cloud over HTTP + WebSocket. Point its config (`mobile/app.config.ts` or whatever URL the app reads) to the zrok URL from §2f, e.g. `https://mentracloud.share.zrok.io`. No separate zrok process is needed for the mobile app itself — it consumes the cloud share.

---

## 4. Camera Example App — [/Users/hiyabuddy/sites/brendancopley/MentraOS-Camera-Example-App](../MentraOS-Camera-Example-App/)

Standalone Bun/Hono server (default port **:3000**) that registers with MentraOS Cloud as a third-party app.

### 4a. First-time setup

```bash
cd /Users/hiyabuddy/sites/brendancopley/MentraOS-Camera-Example-App

# Create env file
cp .env.example .env
# Edit .env to set:
#   PORT=3000
#   PACKAGE_NAME=com.yourName.foodScanner
#   MENTRAOS_API_KEY=<from console.mentra.glass>
#   (optional) YOLO_MODEL_URL=...
#   (optional) YOLO_INCLUDE_TABLEWARE=true

bun install
```

### 4b. Run

```bash
cd /Users/hiyabuddy/sites/brendancopley/MentraOS-Camera-Example-App

bun run dev                          # NODE_ENV=development bun --watch src/index.ts
# or
bun run start                        # bun src/index.ts
```

### 4c. Expose via zrok

The app must be reachable from MentraOS Cloud, so register it with a public URL:

```bash
# Reserved
zrok reserve public 3000 --unique-name mentrayolo
zrok share reserved mentrayolo

# Or ephemeral
zrok share public http://localhost:3000
```

Then in [console.mentra.glass](https://console.mentra.glass/) set the app's **Public URL** to e.g. `https://mentrayolo.share.zrok.io`.

---

## 5. Smoke Test — [/Users/hiyabuddy/sites/brendancopley/MentraOS-Camera-Example-App/smoke-test](../MentraOS-Camera-Example-App/smoke-test/)

Streamlit app for verifying WebSocket connectivity to MentraOS.

### 5a. Setup + run

```bash
cd /Users/hiyabuddy/sites/brendancopley/MentraOS-Camera-Example-App/smoke-test

# Configure .env (see smoke-test/README.md):
#   MENTRAOS_WEBSOCKET_URL=wss://mentracloud.share.zrok.io/app-ws
#   CAMERA_APP_URL=https://mentrayolo.share.zrok.io
#   PACKAGE_NAME=com.mentra.okbeanieyolo
#   MENTRAOS_API_KEY=<your key>

# Easiest path
chmod +x run.sh
./run.sh

# Or manual
uv sync
uv run streamlit run app.py
```

Streamlit UI opens at `http://localhost:8501`.

---

## 5b. One-shot via `scripts/dev-*.sh` (tmux split-screen)

If you'd rather not babysit 6 terminals, the repo ships three helpers:

```bash
# Start cloud (Docker) + zrok shares + camera app + Metro inside a single tmux session
/Users/hiyabuddy/sites/brendancopley/MentraOS/scripts/dev-up.sh

# Attach to see the split-screen view
tmux attach -t mentraos        # detach with Ctrl-b d

# Health check (cloud, camera, metro, supabase, zrok URLs, docker, zrok procs, tmux session)
/Users/hiyabuddy/sites/brendancopley/MentraOS/scripts/dev-status.sh

# Tear everything (tmux session, zrok shares, camera, metro, cloud Docker) back down
/Users/hiyabuddy/sites/brendancopley/MentraOS/scripts/dev-down.sh
```

`dev-up.sh` skips Supabase (you start that with your own script). It creates the `mentraos` tmux session with one window, 5 tiled panes:

```
┌──────────────────┬──────────────────────┐
│ cloud logs       │ zrok mentracloud     │
├──────────────────┼──────────────────────┤
│ camera app :3300 │ zrok mentrayolo      │
├──────────────────┴──────────────────────┤
│ metro / expo :8082                      │
└─────────────────────────────────────────┘
```

---

## 6. Recommended Boot Order

To bring everything up in one go, run these in **separate terminals** (each command is long-running):

```bash
# Terminal 0 — Supabase stack (external, but required by the mobile app)
cd /Volumes/black/black_sites/trulyprivate/supabase-project && docker compose up -d

# Terminal 1 — Cloud backend (Docker)
cd /Users/hiyabuddy/sites/brendancopley/MentraOS/cloud && bun run dev

# Terminal 2 — Cloud zrok tunnel
zrok share reserved mentracloud

# Terminal 3 — Camera Example App
cd /Users/hiyabuddy/sites/brendancopley/MentraOS-Camera-Example-App && bun run dev

# Terminal 4 — Camera App zrok tunnel
zrok share reserved mentrayolo

# Terminal 5 — Mobile (Metro / Expo)
cd /Users/hiyabuddy/sites/brendancopley/MentraOS/mobile && bun start

# Terminal 6 (optional) — Smoke test
cd /Users/hiyabuddy/sites/brendancopley/MentraOS-Camera-Example-App/smoke-test && ./run.sh
```

Then `bun ios` or `bun android` from `mobile/` to install on a device/sim.

---

## 7. Common Troubleshooting Quick Refs

```bash
# Cloud network missing? Re-create it
cd /Users/hiyabuddy/sites/brendancopley/MentraOS/cloud
bun run dev:setup-network             # (if defined in package.json scripts)

# Stale containers / volumes
bun run dev:clean

# Mobile: iOS build cache issues
cd mobile && bun expo prebuild        # NEVER use --clean / --clear

# Mobile: Android port forwarding
cd mobile && bun adb

# zrok: list shares + reservations
zrok overview
zrok status
```
