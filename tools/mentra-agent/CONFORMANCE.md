# SDK / cloud-runtime conformance run — example miniapp on Mentra Live

Setup: `sdk/example-miniapp` dev-served on :3130, installed in the Android
emulator app, glasses = real Mentra Live (DA08) attached through the
Remote Glasses bridge (RemoteHarness -> harness daemon -> BLE). Cloud =
AWS us-west-2 dev. Driven via CDP (tools/mentra-agent/cdp.ts).

| iface | status | notes |
|---|---|---|
| session.display | ✅ correctly gated | `showTextWall` returns ok to the miniapp (fire-and-forget); the island's capability arbitration silently drops the event because Mentra Live has `hasDisplay:false`. Graceful: no error, no crash. Root finding: an UNKNOWN deviceModel falls back to NONE capabilities and gates *everything* silently — the RemoteHarness driver now impersonates the underlying family (live/g2/g1) so capabilities resolve to the real hardware. |
| session.speaker | pending | TTS / play URL — cloud audio service |
| session.mic | pending | Live mic streaming is an open question |
| session.transcription | pending | known-good on G2; checking via Live path |
| session.translation | pending | |
| session.camera | ✅ pipeline proven / ❌ dev-backend storage | Full loop ran: miniapp → host → V1 mint (devapi) → DeviceManager → RemoteHarness (chunked K900) → daemon → REAL Live camera captured → upload attempt → structured error back to the miniapp in ~14s: `{"code":"upload_failed","message":"The specified bucket does not exist."}` — devapi's S3 bucket is missing (cloud-infra bug, report to team). Every hop including error propagation works. (Older notes: | Permission gate works (clean PERMISSION_NOT_DECLARED until CAMERA added to miniapp.json — the example shipped without it despite having a camera tester page). **Major finding:** the local-SDK photo path mints its upload URL from the V1 backend (`POST {backend_url}/api/v2/client/photo/request`); on prod `api.mentra.glass` that endpoint is **HTTP 404** (not deployed) — miniapp photos are broken against prod. It EXISTS on `devapi.mentra.glass` (401 unauth = present); with `backend_url=devapi.mentra.glass` the mint succeeds and the pipeline reaches the SGC driver. Also: cloud-v2's managed-photo service presigns but has no device trigger; the phone coordinator has the trigger but mints from V1 — the two halves of managed photo live in different stacks. |
| session.stream | pending | managed/unmanaged RTMP |
| session.input | pending | touchpad/buttons (needs human tap; user AFK) |
| session.location | pending | emulator GPS |
| session.storage | pending | host-local |
| session.system | pending | |

## Infrastructure findings (count as conformance results too)

- **K900 chunking is mandatory for large commands**: the glasses silently drop
  frames whose C-wrapped JSON exceeds ~200 bytes. A `take_photo` carrying a
  presigned webhookUrl (~500+ chars) vanished without any error — the earlier
  photo tests passed only because the local media-receiver URL was short.
  Ported MessageChunker ({t:"ck",id,c,n,d} envelopes, packed ≤253B, ~50ms gaps)
  into live.mjs `packCommands`; verified lossless round-trip in selftest.

- **manager stale-protocol bug (fixed)**: reconnecting a different glasses
  family on the same daemon kept the previous family's protocol
  (`device = device || detected`); a Live was driven as a G2. Fixed: reset on
  every `start()`.
- **RemoteHarness stale-socket bug (fixed)**: after a daemon restart the app's
  reader hung forever and sends failed silently; send-failure now closes the
  socket so the reconnect loop engages.
- **app<->daemon TCP churn (root-caused + fixed)**: the app's glasses-mic
  watchdog (`checkAndReinitGlassesMic`, fires when no glasses audio for 5s —
  always true on a Live, whose mic doesn't stream) calls `setMicEnabled(true)`
  on the MAIN thread; the driver did socket I/O inline there, so Android threw
  `NetworkOnMainThreadException` (message: null) and the failure handler killed
  a healthy socket — reconnect, repeat every ~7s. The G2 masked it because its
  mic streams, keeping the watchdog quiet. Fix: all RemoteHarness socket writes
  go through a dedicated writer thread fed by a queue; callers never touch the
  socket. (Lesson for any SGC driver: SGCManager methods are invoked from the
  main thread; drivers must not do blocking I/O inline.)
- **Live mic silence (open product question)**: with no audio frames, the mic
  watchdog fires every 5s forever — re-sending mic-enable. Harmless once sends
  are queued, but the watchdog churn is itself a finding: a mic-less/mic-silent
  device keeps the reinit loop hot.
