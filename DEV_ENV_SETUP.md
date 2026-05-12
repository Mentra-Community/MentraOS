# Local Dev Environment Setup — `dev-up.sh` + `.env` wiring

This doc explains how the four ports the dev stack uses (3300, 8000, 8001, 8002) flow through the four `.env` files this project touches, and how to point them at the right place when [`scripts/dev-up.sh`](scripts/dev-up.sh) brings everything up.

> **TL;DR**: Use the **zrok mode** below. It's the only mode where everything works end-to-end (mobile auth, WebSockets, physical device off your LAN). `dev-up.sh` auto-reserves the zrok shares the first time you run it.

---

## What `dev-up.sh` starts

| Service                   | Local port | Reserved zrok share | Public URL                             |
| ------------------------- | ---------- | ------------------- | -------------------------------------- |
| MentraOS cloud            | `:8002`    | `mentracloud`       | `https://mentracloud.share.zrok.io`    |
| Camera example app        | `:3300`    | `mentrayolo`        | `https://mentrayolo.share.zrok.io`     |
| Metro / Expo              | `:8081`    | `mentrametro`       | `https://mentrametro.share.zrok.io`    |
| Self-hosted Supabase Kong | `:8000`    | `mentrasupabase`    | `https://mentrasupabase.share.zrok.io` |

(Supabase is a separate stack you start outside this repo — see [SETUP_COMMANDS.md](SETUP_COMMANDS.md). `dev-up.sh` does **not** start Supabase, only the cloud + camera + metro + zrok shares.)

---

## The four `.env` files

```
mobile/.env                                       — React Native runtime config
cloud/.env                                        — MentraOS cloud server config
../MentraOS-Camera-Example-App/.env               — camera app config
ios/.xcode.env.local                              — Xcode build phase config (auto-derived from mobile/.env by `bun ios`)
```

Each consumes specific keys. Below: which key in which file points at which port.

| Key                                | File                                       | Consumed by                                                                                                                                                                                      | Default                            | Maps to port                                                                    |
| ---------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------- |
| `EXPO_PUBLIC_BACKEND_URL_OVERRIDE` | `mobile/.env`                              | [`src/stores/settings.ts:97`](mobile/src/stores/settings.ts#L97)                                                                                                                                 | `https://api.mentra.glass` (prod)  | cloud `:8002`                                                                   |
| `EXPO_PUBLIC_SUPABASE_URL`         | `mobile/.env`                              | [`src/utils/auth/provider/supabaseClient.ts:9`](mobile/src/utils/auth/provider/supabaseClient.ts#L9)                                                                                             | `https://auth.mentra.glass` (prod) | Supabase Kong `:8000`                                                           |
| `CLOUD_PUBLIC_HOST_NAME`           | `cloud/.env`                               | [`packages/cloud/src/services/session/AppManager.ts:44`](cloud/packages/cloud/src/services/session/AppManager.ts#L44) — used to build `wss://${CLOUD_PUBLIC_HOST_NAME}/app-ws` URLs sent to apps | `localhost:8002`                   | cloud `:8002`                                                                   |
| `PORT`                             | `MentraOS-Camera-Example-App/.env`         | camera app server                                                                                                                                                                                | `3300`                             | camera `:3300`                                                                  |
| `NODE_BINARY`                      | `mobile/.env` (and `ios/.xcode.env.local`) | hermes-engine cocoapod build script                                                                                                                                                              | unset                              | Xcode build (NOT a port — but if missing, `bun ios` fails at the hermes script) |

---

## Three modes

### Mode 1 — zrok (Recommended)

**Use when**: you want everything to "just work", including a physical iPhone on cellular, WSS handshakes from third-party app servers, mobile auth via Supabase, etc.

**Why**: `CLOUD_PUBLIC_HOST_NAME` is used to build `wss://...` URLs. WSS requires TLS. zrok provides HTTPS/WSS for free; localhost and LAN-IP modes break here.

**`mobile/.env`**:

```bash
EXPO_PUBLIC_BACKEND_URL_OVERRIDE=https://mentracloud.share.zrok.io
EXPO_PUBLIC_SUPABASE_URL=https://mentrasupabase.share.zrok.io
NODE_BINARY=/Users/hiyabuddy/.nvm/versions/node/v22.14.0/bin/node
```

**`cloud/.env`**:

```bash
CLOUD_PUBLIC_HOST_NAME=mentracloud.share.zrok.io
```

**`MentraOS-Camera-Example-App/.env`**:

```bash
PORT=3300
```

(The camera's `PORT` doesn't change between modes — it's the local listener; zrok exposes it externally.)

---

### Mode 2 — LAN IP

**Use when**: physical iPhone on the same WiFi as your Mac and you want lower latency than zrok adds.

**Caveat**: WSS handshakes will fail (no TLS on a LAN IP). The mobile app may still partially work for non-WSS endpoints, but anything that depends on the cloud's public WS URL (`AppManager.ts` builds `wss://${CLOUD_PUBLIC_HOST_NAME}/app-ws`) will break. Use Mode 3 if you need that path.

Find your Mac's LAN IP: `ipconfig getifaddr en0` (e.g., `192.168.0.189`).

**`mobile/.env`**:

```bash
EXPO_PUBLIC_BACKEND_URL_OVERRIDE=http://192.168.0.189:8002
EXPO_PUBLIC_SUPABASE_URL=http://192.168.0.189:8000
NODE_BINARY=/Users/hiyabuddy/.nvm/versions/node/v22.14.0/bin/node
```

**`cloud/.env`**:

```bash
CLOUD_PUBLIC_HOST_NAME=192.168.0.189:8002
```

**`MentraOS-Camera-Example-App/.env`**:

```bash
PORT=3300
```

---

### Mode 3 — localhost (simulator only)

**Use when**: iOS Simulator on the same Mac, no real device, no WSS dependencies.

**`mobile/.env`**:

```bash
EXPO_PUBLIC_BACKEND_URL_OVERRIDE=http://localhost:8002
EXPO_PUBLIC_SUPABASE_URL=http://localhost:8000
NODE_BINARY=/Users/hiyabuddy/.nvm/versions/node/v22.14.0/bin/node
```

**`cloud/.env`**:

```bash
CLOUD_PUBLIC_HOST_NAME=localhost:8002
```

**`MentraOS-Camera-Example-App/.env`**:

```bash
PORT=3300
```

---

## First-time zrok setup

If you've never enabled zrok on this machine:

```sh
# 1. Get an account: https://api.zrok.io/signup
# 2. Enable on this machine (one-time):
zrok enable <your-zrok-token-from-the-signup-email>

# 3. Verify:
zrok overview
```

After that, **`dev-up.sh` handles everything else**. On first run it detects which of the four reserved shares (`mentracloud`, `mentrayolo`, `mentrametro`, `mentrasupabase`) are missing from `zrok overview` and creates them with `zrok reserve public --backend-mode proxy --unique-name <token>`. Subsequent runs are no-ops on the reservations.

---

## Bringing it all up

```sh
# 1. Make sure your self-hosted Supabase is running on :8000 (separate stack — see SETUP_COMMANDS.md)

# 2. Bring up the MentraOS cloud + camera + metro + all 4 zrok shares in one tmux session:
./scripts/dev-up.sh

# 3. Attach to see logs (each service in its own pane):
tmux attach -t mentraos

# 4. In another shell, build/run the mobile app:
cd mobile && bun ios
```

`bun ios` reads `mobile/.env`, copies it to `ios/.xcode.env.local`, and runs `expo run:ios`. The values you set above are baked into the JS bundle and consumed at runtime.

---

## Verification

```sh
./scripts/dev-status.sh
```

Expected (zrok mode):

```
Local services
  ✓ cloud /health             http://localhost:8002/health             200
  ✓ camera /api/health        http://localhost:3300/api/health         200
  ✓ metro /status             http://localhost:8081/status             200
  ✓ supabase Kong             http://localhost:8000/                   200|401|404
  ✓ supabase logflare         http://localhost:4000/health             200

Public (zrok)
  ✓ mentracloud /health       https://mentracloud.share.zrok.io/health      200
  ✓ mentrayolo /api/health    https://mentrayolo.share.zrok.io/api/health   200
  ✓ mentrametro /status       https://mentrametro.share.zrok.io/status      200
  ✓ mentrasupabase /          https://mentrasupabase.share.zrok.io/         200|401|404

zrok shares
  ✓ mentracloud      share running
  ✓ mentrayolo       share running
  ✓ mentrametro      share running
  ✓ mentrasupabase   share running
```

If any zrok row shows `share NOT running`, the tmux pane for that share probably died. Attach with `tmux attach -t mentraos` and check that pane's output.

---

## Common pitfalls

**1. `bun ios` overwrites `ios/.xcode.env.local`.**
[`mobile/scripts/ios.mjs`](mobile/scripts/ios.mjs) does `cp .env ios/.xcode.env.local` on every run, so anything you put in `ios/.xcode.env.local` directly will be wiped. Put env vars in `mobile/.env` instead — including `NODE_BINARY` (otherwise the hermes-engine cocoapod's pre-build script fails with `: command not found`).

**2. Port 8081 conflicts with another Docker project.**
`dev-up.sh` now refuses to kill Docker-owned listeners and prints actionable instructions. Find the offender:

```sh
docker ps --format 'table {{.Names}}\t{{.Ports}}' | grep :8081
docker stop <name>   # or remap that container's host port
```

**3. Mobile app loads but auth/WS fails on LAN IP mode.**
`CLOUD_PUBLIC_HOST_NAME` is used as a `wss://` host. LAN IPs don't have TLS, so WSS rejects. Switch to zrok mode or terminate TLS in front of your cloud (caddy / nginx with a self-signed cert + trust on device).

**4. `EXPO_PUBLIC_*` change doesn't take effect.**
Expo bakes `EXPO_PUBLIC_*` into the JS bundle at build time. After editing `mobile/.env`, you need to **rebuild** (`bun ios`) — restarting Metro alone isn't enough.

**5. `zrok overview` is empty.**
You haven't enabled zrok on this machine yet. Run `zrok enable <your-token>`.

---

## Reverting / shutting down

```sh
./scripts/dev-down.sh
```

Stops the tmux session, all four zrok share processes, the MentraOS cloud Docker stack, and any lingering camera/metro processes. Leaves Supabase and other-project containers untouched.

To also stop your separate Supabase stack, do that from its own directory.
