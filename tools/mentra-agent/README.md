# mentra-agent

Programmatic control of the MentraOS app for agents, tests, and humans who are
tired of tapping. Replaces screen-driving (uiautomator dumps, coordinate taps,
screenshot reading — 30-90s per interaction, flaky) with sub-second API calls
against the app's real internal surfaces.

## How it works

```
app (dev build) ──ws──▶ :8787/bridge ─┐
                                      ├─ harness server (this folder)
agent / CLI / CI ──http──▶ :8787 ─────┘
```

- **In-app bridge** (`mobile/src/dev/agentBridge.ts`): a `__DEV__`-only module
  that dials OUT to this server (reverse connection — nothing on the device
  ever listens) and exposes navigation, settings, the cloud client, and
  miniapp launch over a tiny JSON protocol. It also streams events
  (transcripts, cloud status, connection transitions) so "did the caption
  arrive, via which transport?" is a query, not a screenshot.
- **Harness server** (`server.ts`): accepts the app's WebSocket, relays RPCs
  from the HTTP control plane, ring-buffers events.
- **CLI** (`cli.ts`): shell-friendly face for the same control plane.

The app finds the server the same way it found its JS bundle (see
`mobile/src/utils/cloudClient/devHost.ts`): the machine serving the bundle is
the machine running the harness. Emulator: `adb reverse tcp:8787 tcp:8787`.

## Quick start

```bash
# 1. serve (leave running)
bun tools/mentra-agent/server.ts

# 2. emulator plumbing (once per boot)
adb -s emulator-5554 reverse tcp:8081 tcp:8082   # app's default Metro port -> your Metro
adb -s emulator-5554 reverse tcp:8787 tcp:8787   # bridge

# 3. launch the dev-build app; the bridge connects automatically. Then:
bun tools/mentra-agent/cli.ts devices
bun tools/mentra-agent/cli.ts login                  # sign in as the QA user, no human
bun tools/mentra-agent/cli.ts state
bun tools/mentra-agent/cli.ts nav /miniapps/settings/developer
bun tools/mentra-agent/cli.ts set cloud_core_url '"https://core.us-west-2.dev.mentraglass.com"'
bun tools/mentra-agent/cli.ts reconnect
bun tools/mentra-agent/cli.ts launch com.mentra.local-captions
bun tools/mentra-agent/cli.ts watch transcript
```

## Autonomous auth (no human login)

The harness logs the app in by itself, so e2e runs need no person at the
keyboard:

- The QA test account lives in **Doppler `cloud-v2/dev`** as `QA_TEST_EMAIL` /
  `QA_TEST_PASSWORD`. `cli.ts login` reads them (or env vars of the same name)
  and drives the app's real Supabase password sign-in over the bridge — the
  credentials only ever travel the loopback connection.
- The account was minted via the Supabase **admin API** (service-role key in
  Doppler `mentraos-cloud/dev`, `email_confirm: true`), so no email step. To
  recreate / rotate:

  ```bash
  SVC=$(doppler secrets get SUPABASE_SERVICE_ROLE_KEY --project mentraos-cloud --config dev --plain)
  SUPA=$(grep EXPO_PUBLIC_SUPABASE_URL mobile/.env | cut -d= -f2)
  curl -s -X POST "$SUPA/auth/v1/admin/users" -H "apikey: $SVC" -H "Authorization: Bearer $SVC" \
    -H "Content-Type: application/json" \
    -d '{"email":"mentra-agent-qa@mentra.glass","password":"...","email_confirm":true}'
  ```

The session persists across restarts (Supabase `persistSession`), so once
logged in the emulator stays logged in — ideal for a golden snapshot.

## RPC surface

| method | params | does |
| --- | --- | --- |
| `ping` | — | liveness + bundle build time (kills stale-bundle confusion) |
| `getState` | — | cloud status, audio transport, resolved endpoints |
| `login` / `logout` / `isLoggedIn` | `{email, password}` for login | drive the app's real Supabase auth |
| `navigate` | `{path, params?}` | expo-router push |
| `goBack` / `goHome` | — | navigation |
| `getSetting` / `setSetting` | `{key, value?}` | settings store |
| `cloudReconnect` | — | bounce the cloud client |
| `launchMiniapp` | `{packageName}` | open a local island miniapp |

Events streamed: `hello`, `transcript`, `translation`, `cloudConnection`,
`cloudStatus`.

## Security

Dev builds only: the bridge module no-ops unless `__DEV__`, so it does not
exist in release binaries. The connection is outbound from the device; the
server is meant for a dev machine. Don't run the harness server on a box you
share with strangers.

## Roadmap

- audio injection into the mic-capture path (deterministic "speak this WAV,
  assert this transcript" — no speakers)
- scenario runner for the audio fault-regression matrix (pod roll, network
  drop, UDP block, token expiry) asserting on both app + cloud sides
- MCP server face so agents get typed tools instead of shelling the CLI
- emulator golden-snapshot management (logged-in known state in ~2s)
