# SDK / cloud-runtime conformance run — example miniapp on Mentra Live

Setup: `sdk/example-miniapp` dev-served on :3130, installed in the Android
emulator app, glasses = real Mentra Live (DA08) attached through the
Remote Glasses bridge (RemoteHarness -> harness daemon -> BLE). Cloud =
AWS us-west-2 dev. Driven via CDP (tools/mentra-agent/cdp.ts).

| iface | status | notes |
|---|---|---|
| session.display | ✅ correctly gated | `showTextWall` returns ok to the miniapp (fire-and-forget); the island's capability arbitration silently drops the event because Mentra Live has `hasDisplay:false`. Graceful: no error, no crash. Root finding: an UNKNOWN deviceModel falls back to NONE capabilities and gates *everything* silently — the RemoteHarness driver now impersonates the underlying family (live/g2/g1) so capabilities resolve to the real hardware. |
| session.speaker | ✅ | `speak` returned `{"completed":true,"duration":2062}` — TTS synthesized and played (volume kept at 20% for the office). |
| session.mic | 🚫 device | Mentra Live mic never streams LC3 (0 frames in all sessions; likely needs a record/VAD trigger in firmware) — the mic watchdog refires every 5s forever as a side effect. G2 mic fully proven earlier. Open product question. |
| session.transcription | ✅ local + AWS | LOCAL cloud runtime: PASS ("quick brown fox" via injected audio over WS transport; UDP after stack refresh). Real-G2-mic path proven earlier on AWS. First local attempt returned noise only — cold provider warm-up; retry passed. |
| session.translation | ✅ AWS / 🚫 local (quota) | EN→ES proven on AWS earlier ("Hola, ¿dónde está la estación de tren?"). LOCAL: the runtime correctly provisions an `en>es` Soniox session but the SHARED org concurrency quota is exhausted (429 limit_exceeded ×18) — dev/local/AWS all burn the same org key. Also: the provider self-heal retries a 429 every 500ms — needs stronger backoff on limit_exceeded (same family as the language-hint spin). |
| **managed photo (cloud-v2, local)** | ✅ service proven | Full local e2e via curl standing in for the device: supabase→core token exchange (`/api/client/auth/exchange`, OAuth token-exchange grant, EdDSA access token) → `POST /api/camera/photo` presigns local upload+read URLs → simulated device PUT (204) → read-back 200 with exact bytes. Confirms the only missing piece is the device-capture trigger. |
| session.camera | ✅ pipeline proven / ❌ dev-backend storage | Full loop ran: miniapp → host → V1 mint (devapi) → DeviceManager → RemoteHarness (chunked K900) → daemon → REAL Live camera captured → upload attempt → structured error back to the miniapp in ~14s: `{"code":"upload_failed","message":"The specified bucket does not exist."}` — devapi's S3 bucket is missing (cloud-infra bug, report to team). Every hop including error propagation works. (Older notes: | Permission gate works (clean PERMISSION_NOT_DECLARED until CAMERA added to miniapp.json — the example shipped without it despite having a camera tester page). **Major finding:** the local-SDK photo path mints its upload URL from the V1 backend (`POST {backend_url}/api/v2/client/photo/request`); on prod `api.mentra.glass` that endpoint is **HTTP 404** (not deployed) — miniapp photos are broken against prod. It EXISTS on `devapi.mentra.glass` (401 unauth = present); with `backend_url=devapi.mentra.glass` the mint succeeds and the pipeline reaches the SGC driver. Also: cloud-v2's managed-photo service presigns but has no device trigger; the phone coordinator has the trigger but mints from V1 — the two halves of managed photo live in different stacks. |
| session.stream | ✅ runtime service proven (local) | `POST /api/camera/stream` on the LOCAL runtime provisions real Cloudflare Stream coordinates (rtmps ingest + HLS playback); `DELETE` tears down (200). Unmanaged RTMP to a local listener already proven at the daemon level (15s h264 recording). |
| session.input | ⏸ needs human | Decode path proven at daemon level earlier (`sr_tpevt` → tap/swipe); end-to-end needs a physical tap — user AFK overnight. |
| session.location | ✅ | `getOnce` → `{lat:37.4219983, lng:-122.084, accuracy:100}` (emulator mock GPS through the host location service). |
| session.storage | ✅ | `set`/`get` round-trip exact ("overnight_value_42"). |
| session.system | ✅ | `copyToClipboard` ok. |
| session.imu | ✅ full loop on real hardware | Added `setImuEnabled` proxying to RemoteHarness + Live `imu_stream_start` support in the daemon. miniapp subscribe → host → driver → daemon → REAL Live 9-axis IMU → back up the chain: the host derived `{kind:"head", position:"down"}` (the glasses are lying flat on the desk). |

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
