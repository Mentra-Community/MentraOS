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
| session.input | ✅ human-verified (daemon level) | Wearer swiped the Live touchpad: `swipe_back` decoded from `sr_tpevt` and relayed cross-device onto the G2 lens in real time. (The SDK-iface variant through the emulator app remains optional follow-up.) |
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

## Long-session stability (overnight observation)

The local runtime held ONE continuous Soniox transcription session across 4+
hours of hourly probes (21:54 → 02:02) — every hourly phrase accumulated into a
single live transcript with no session churn, wedge, or reconnect. This is the
post-keepalive-fix behavior working over a realistic overnight span. (One probe
"failed" only because its 30s expect-window closed before the final word
finalized; the next probe passed.)

## Display refresh ceiling (human-verified, G2 on-face)

Paced text-wall updates at 20/10/5/2 Hz, 4s each: the wearer confirmed **20 Hz
renders smoothly** on the G2 (sequential UPDATE_TEXT_DATA, single-packet frames).
The laptop->daemon->BLE queue accepts ~1,300 updates/sec but that is queueing,
not rendering — frames beyond the air/firmware rate coalesce. Practical
implication: caption updates, spinners, and even character-grid animations
(Matrix rain at 20fps, 7x26 glyphs) are comfortably within budget.

## G2 display characterization (measured on hardware, 2026-06-11)

- Text-update throughput: ~140 small updates/sec sustained over the raw BLE
  link (300-update run, no backpressure); visual ceiling is the firmware's
  repaint, which coalesces (last-write-wins). The in-app miniapp path is
  deliberately throttled to ~3-5/sec by the display manager.
- Line layout: the firmware AUTO-WRAPS at the text-container edge (newline-free
  60-digit ruler wrapped after exactly 50 digits); explicit \n is honored.
  Exact model (island/src/utils/display/profiles/g1.ts, inherited by
  G2_PROFILE): usable width 576px, 5 lines, rendered glyph width =
  (glyphWidth+1)*2 -> digits 12px ('1' 8px), M 16px, space 6px, hyphen 10px,
  default 16px. Hardware validation: model predicts 49 digits/line, lens shows
  50 (utils ~4px conservative over a full line, <1 char error); M capacity
  576/16 = 36/line, consistent with the observed overflow. The app path wraps
  pixel-accurately via TextWrapper BEFORE sending; firmware wrap is the
  fallback for raw/bypass senders.

## G2 glyph metrics: hardware validation of display utils (predict-then-verify)

Sent uniform character rows at predicted-capacity+3 and counted line-2 spill on
a worn G2. Measured capacities per line: M=35, W=35, e=56, a>=51, '1'=81,
i in [100,146], mixed digit ruler=50; prose WORD-WRAPPED ("forever" moved to
its own line intact).

Best fit reconciling all observations against profiles/g1.ts (inherited by
G2_PROFILE):
- Effective drawable width is ~568-570px, NOT the profile's 576px.
- Two glyph-table errors: '1' renders ~7px (table: 8px) and 'a' ~11px
  (table: 12px). M/W/e/digits match the table within measurement error.
- G2 firmware word-wraps natively; G1-era utils assume char-wrap. App-side
  TextWrapper on G2 therefore wraps slightly early on a/1-heavy text and can
  rely on firmware word-wrap as a safe fallback.

Action for display-utils owner: shrink displayWidthPx to ~568 for G2, fix the
'a' and '1' entries, and consider a G2-specific profile instead of inheriting
G1 verbatim.

## G2 bitmap display: protocol cracked (human-verified on-lens, 2026-06-11)

Earlier "image ✅" notes were wrong — they verified fragment ACCEPTANCE, not
pixels. No bitmap had ever rendered on the G2. Root causes (proven on fw
2.2.4.34 by exhaustive on-hardware experiments + community RE cross-reference):

- Multi-fragment UPDATE_IMAGE_RAW_DATA is broken in firmware: fragment 0 acks
  success (ImgRes code 4), every continuation is rejected (code 5) no matter
  what. Only single-fragment images (whole 4-bit BMP <= 4096 B) render.
  Workaround: tile into <= 4 single-fragment strip containers declared in ONE
  image-only REBUILD_PAGE (manager.mjs displayImageTiled; photo = 224x140 as
  4 strips of 224x35).
- A CREATE_STARTUP_PAGE over a live page is silently ignored — SHUTDOWN first,
  and after a BLE reconnect a page must be re-owned (shutdown+create) or
  rebuilds time out.
- Image containers register only via REBUILD_PAGE; G2.kt's repeat-create with
  ID pool 10-13 never registers them (that's why the app's displayBitmap has
  never worked on G2 — filed as a follow-up task). Image ID 1 collides with
  the default text container's ID 1 on shared pages; use image-only rebuilds.
- Firmware replies echo the request magic (field 2) with result codes
  (ImgRes f6/sub-f8: 4 ok, 5 fail; RebuildRes f8/sub-f1: 6 ok, 7 fail) — sends
  must be ack-gated; blind-timer streaming (the app's approach) can't even
  see the failures. Hammering bad fragments can crash the BLE link entirely.
- Limits: containers 20-288 x 20-144, name <= 14 chars, BMP 4bpp colorsUsed=16,
  dims == container dims.

End result: a real Mentra Live camera photo rendered on the worn G2 lens
(Live -> WiFi webhook -> ffmpeg gray + gamma -> 4-strip tile -> EvenHub),
human-confirmed. Cross-device camera->display pipeline complete.

## Dual-device control (verified)

Two daemon instances (per-port pidfiles/logs) held BOTH glasses families
simultaneously: daemon A :8799 -> Even G2 (worn), daemon B :8899 -> Mentra Live.
Demo: the Live's camera captured a 179KB JPEG to the laptop while the G2 lens
narrated the countdown and result live; then a touchpad swipe on the Live was
relayed onto the G2 lens. Target a daemon with GLASSES_PORT=<port>.

## Physical-device findings (Pixel 8, preview build, real Mentra Live)

- The example miniapp shipped `DISPLAY: REQUIRED`, which blocks LAUNCH entirely
  when display-less glasses (Mentra Live) are connected — on a tester app whose
  camera pages exist specifically FOR camera glasses. Changed DISPLAY and
  MICROPHONE to OPTIONAL; a tester should adapt to present hardware, not gate.
- App bug (preview build): after installing a dev miniapp via QR scan, the new
  miniapp does NOT appear on the home grid or app drawer — only findable via
  drawer search. The registration succeeds but the home/drawer list doesn't
  refresh. (Same family as the emulator finding that the background JSContext
  keeps a stale manifest until app restart — dev-app registration changes
  don't propagate to consumers.)
