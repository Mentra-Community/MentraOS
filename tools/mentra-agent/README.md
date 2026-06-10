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

## The captions e2e in one command

```bash
bun tools/mentra-agent/cli.ts set cloud_audio_codec '"pcm"'   # once per rig
bun tools/mentra-agent/cli.ts reconnect
bun tools/mentra-agent/cli.ts speak "The emerald falcon glides over the harbor" --expect "emerald falcon"
# interim The Emerald Falcon ...
# PASS: transcript contained "emerald falcon"
```

`speak` synthesizes the phrase on the dev machine (`say` + `afconvert` → 16 kHz
mono s16 PCM), injects it into the app's real audio entry point in 20 ms
frames at ~2x real time, and asserts on the transcripts streaming back.
Non-zero exit on miss → drop it straight into CI. `cloud_audio_codec=pcm` is
the dev/QA codec override (the harness needs no LC3 encoder); unset it for the
production LC3 path.

## MCP face (typed tools for agents)

`mcp.ts` exposes the same control plane as MCP tools (`app_state`,
`app_login`, `app_navigate`, `app_setting`, `app_cloud_reconnect`,
`app_launch_miniapp`, `app_speak`, `app_events`):

```json
{"mcpServers": {"mentra-agent": {"command": "bun", "args": ["tools/mentra-agent/mcp.ts"]}}}
```

`app_speak` is the whole e2e as one tool call — subscribe, synthesize, inject,
and return the interim + final transcripts.

## Emulator golden snapshot

A known-good state (QA user logged in, cloud on AWS us-west-2, codec=pcm) is
frozen as the `qa-golden` snapshot:

```bash
adb -s emulator-5554 emu avd snapshot save qa-golden   # freeze current state
adb -s emulator-5554 emu avd snapshot load qa-golden   # back to known state in ~2s
```

## App-health sweep (quantified whole-app QA)

```bash
bun tools/mentra-agent/sweep.ts            # human scorecard
bun tools/mentra-agent/sweep.ts --json     # machine-readable (CI / trend)
bun tools/mentra-agent/sweep.ts --selftest # prove the error channel works, exit
bun tools/mentra-agent/sweep.ts --filter settings
```

Enumerates every expo-router route from `mobile/src/app` (only files that
`export default` a component; skips layouts, dynamic-param routes, tests),
navigates to each through the bridge, and asks the app's **error channel**
(`agentBridge` hooks `ErrorUtils` + `console.error`) whether the screen threw.
Turns a screen-by-screen manual click-through into one quantified pass:

```
SCORECARD  health 100%  (68 clean, 3 guarded/redirected, 0 broken of 71)
           nav p50 73ms  p95 148ms  max 228ms
           slowest: /ota/progress-legacy 228ms, /applet/local 195ms, ...
```

Three verdicts so the number is meaningful, not just green:
- **clean** — landed on the route, no real render error.
- **redirected** — landed on a different VALID route (auth/onboarding/param
  guards, e.g. `/` -> `/home`). Working as designed; not a failure.
- **broken** — threw a render error, or bounced to `+not-found`. Non-zero
  exit. This is the bucket that was 7+ before the Metro dedupe fix.

**Trust gate:** every run first navigates a known-crashing self-test route
(`/test/agent-selftest?crash=1`) and aborts unless the error channel catches
it — a green scorecard is only believable if a broken screen would turn it
red. `baseline-scorecard.json` is the committed reference to diff against.

## Scenario runner (fault-injection suite)

```bash
bun tools/mentra-agent/scenarios.ts list
bun tools/mentra-agent/scenarios.ts all          # CI-ready: non-zero exit on failure
```

- `captions` — baseline pipeline (subscribe -> inject -> transcript), ~3s.
- `reconnect` — cuts the emulator's network mid-session (adb survives on the
  emulator transport; the bridge stays alive over adb-reverse localhost),
  asserts the app reports disconnected, restores the network, asserts the
  cloud self-heals WITHOUT app interaction and transcription resumes, ~10s.
  This single test covers the connection retry loop, initialSubscriptions on
  the recovery handshake, and server-side STT re-attach.
- `endpoint-switch` — bogus endpoint disconnects, switching back recovers and
  transcribes.

## Roadmap

- more fault scenarios: pod roll (server-side), UDP-block -> WS fallback,
  token expiry
- `installMiniapp` RPC (serve local-miniapps bundles from the harness server,
  install via appRegistry) for UI-level captions tests
- iOS simulator lane (the bridge is pure JS; only the boot tooling differs)

## Findings the harness has already produced

Fixed on this branch (cherry-pick to cloud-v2 — the other checkout has the
same landmines):

- **Duplicate react-native/expo in the Metro bundle** (bun nests copies under
  local expo-modules; Metro resolved crust's imports to the nested copy ->
  TurboModule registry mismatch -> expo-router silently dropped every route
  whose import chain touched it: cold boots on "Unmatched Route", /home render
  crash). Fixed with the metro.config.js singleton dedupe.
- **Subscriptions silently dead for fresh clients** (server version high-water
  mark outlives the app; reinstall -> client restarts at version 1 -> PUTs
  rejected as stale -> transcription never starts). Fixed in cloud-client:
  fast-forward to the server's returned version and replay.

Open (cloud-v2 runtime follow-ups — found by the scenario suite):

- **Soniox auto-pause wedge.** After repeated silence -> auto-pause ->
  resume cycles (every `speak` separated by >2s triggers one), the soniox
  provider reaches a state where it stays `connected`, audio still appends to
  the stream, subscriptions still apply — but it emits NO transcripts. A
  client reconnect does not clear it (the provider is keyed by mentraUserId
  and survives the client's new session). Repro: `scenarios.ts all` — the
  first `captions` passes from clean state, then later utterances time out
  with `cloud=connected/udp` and `[soniox] auto-paused`/`resumed` churning in
  the server logs but no `result`. The auto-pause feature (Fix 044-3 port)
  almost certainly needs the resume to verify the Soniox session actually
  accepts audio again after `finalize()`, or to rebuild the session instead of
  resuming a finalized one. Run scenarios individually until fixed.
- Soniox rejects BCP-47 region codes as language hints ("Invalid language
  hint." for `en-US`); the runtime's soniox provider should normalize, and a
  non-retryable invalid-config error currently spins the self-heal reconnect
  loop forever instead of giving up.
