# mentra-agent BLE bridge — drive real Even glasses from your Mac

Connect directly to **Even Realities glasses (G1 + G2)** over Bluetooth from a
laptop — **no phone, no emulator**. Display text and images on the lens, read the
mic, stream live captions/translation through the real MentraOS cloud, query
battery/firmware, and receive taps + IMU. Both protocols are ported 1:1 from the
app's own drivers (`.../sgcs/G2.kt` and `G1.java`), so this speaks exactly what
the glasses expect. The protocol is **auto-detected** on connect (G2 = EvenHub
protobuf, G1 = Nordic-UART) and the same commands work on both.

| capability | G2 | G1 |
|---|---|---|
| text on lens | ✅ tested | ✅ ported |
| image/bitmap | ✅ tested | ✅ ported (g1.mjs) |
| mic → captions / translation | ✅ tested | ✅ ported (20-byte LC3) |
| brightness / head-up | ✅ tested | ✅ ported |
| battery + firmware | ✅ tested | ✅ ported |
| taps / gestures | ✅ tested | ✅ ported |
| IMU head-orientation | ✅ wired | n/a (head up/down only) |

(G1 paths are byte-for-byte verified against the spec via `node g1.mjs`, but not
hardware-tested — the author only has a G2.)

```
 glasses  ⇄  Mac BLE (noble)  ⇄  daemon (:8799)  ⇄  glasses.mjs / cap.sh
   │                                    │
   │  mic LC3 ───────► audio WS (:8800) ─┴─► glasses-captions.ts ─► cloud ─► Soniox ─► captions ─► back to lens
```

## Why the `.app` wrapper (the macOS gotcha)

macOS kills any CLI that touches CoreBluetooth unless it (1) carries
`NSBluetoothAlwaysUsageDescription` in a bundle Info.plist **and** (2) is
launched via LaunchServices (`open`), so it becomes its own "responsible
process". So every BLE script runs inside **`MentraBLE.app`** (built by
`make-app.sh`, which copies your `node` binary in and ad-hoc-signs it).
`run.sh` and `gd.sh` handle the `open` dance for you. First run pops a one-time
"Mentra BLE Bridge wants to use Bluetooth" prompt — click Allow.

## Quickstart

```bash
./make-app.sh                       # one-time: build the permission wrapper
npm install                         # one-time: noble + ws + tweetnacl

# one-shot text on the lens (connects, draws, disconnects):
./run.sh text.mjs <serialSuffix> "Hello from the harness" 20

# OR a persistent session (recommended):
./gd.sh start                       # launch the daemon (stays alive)
bun glasses.mjs connect <serialSuffix>
bun glasses.mjs text "anything"     # live updates on the held link
bun glasses.mjs brightness 200
./cap.sh                            # live captions (mic -> cloud -> lens)
```

`<serialSuffix>` is part of your glasses' factory serial (e.g. `3248`). Find it
with `./run.sh scan.mjs`. **Match the serial, not the name** — an office can have
several G2s in the same name group; the serial is unique and both arms share it.

## Commands (`bun glasses.mjs …`, talks to the daemon)

| command | what |
|---|---|
| `connect <serial> [waitSec]` | scan + connect both arms, bond, auth, hold the link (auto-detects G1/G2) |
| `text <words…>` | draw text on the lens |
| `image [w] [h]` | draw an image (built-in demo pattern; G2) |
| `clear` | blank the lens |
| `mic on` / `mic off` | enable/disable the glasses mic (auto-creates a page first) |
| `imu on` / `imu off` | enable IMU head-orientation reporting (G2; samples in `status.imu`) |
| `brightness <0-255> [auto]` | set display brightness |
| `headup <angle>` | set heads-up display angle |
| `info` | battery %, charging, firmware version |
| `status` | connection state, device type, arms, audio frames, last text, IMU sample |
| `logs` | recent daemon logs (gestures + device events show here) |
| `disconnect` | drop the BLE link (daemon stays up) |
| `shutdown` | stop the daemon |

## Captions (`./cap.sh`)

Streams the glasses mic to the **real** MentraOS cloud and mirrors transcripts
back onto the lens. Implemented in `../../../cloud-v2/scripts/glasses-captions.ts`
using the production `@mentra/cloud-client/node` (so the handshake, encrypted-UDP
audio, subscriptions, and transcript decode are the real thing — the cloud
decodes LC3 server-side, no client decoder needed). Auth is a Supabase password
login with the QA creds from Doppler (`cloud-v2/dev`).

Self-test without a human: play TTS through the speakers near the glasses —
`say "the quick brown fox"` — and watch it transcribe.

**Live translation** onto the lens (flagship demo): set a target language and the
lens shows the translation instead of the transcript:

```bash
TRANSLATE_TO=es ./cap.sh        # speak English -> Spanish appears on the lens
```

## Files

| file | role |
|---|---|
| `g2.mjs` | G2 protocol: CRC16, protobuf, EvenBLE framing, builders (text/image/imu/brightness), notify decoder (imu/battery/firmware/gestures). `node g2.mjs` self-tests. |
| `g1.mjs` | G1 protocol: Nordic-UART byte opcodes (text/bitmap/brightness/mic/battery/heartbeat) + decoder. `node g1.mjs` self-tests. |
| `bmp.mjs` | 4-bit grayscale BMP encoder + raster primitives for G2 images. `node bmp.mjs` self-tests. |
| `manager.mjs` | `G2Manager` — the SGC port: scan/connect/auth/heartbeat/auto-reconnect, **auto-detects G1 vs G2** and dispatches, command + event surface |
| `daemon.mjs` | long-running HTTP control plane (`:8799`) + binary audio WS (`:8800`) |
| `glasses.mjs` | bun CLI client for the daemon |
| `scan.mjs` / `connect.mjs` | one-shot serial-decoding scan / read-only GATT prober |
| `text.mjs` | one-shot connect → draw text → disconnect |
| `make-app.sh` / `run.sh` / `gd.sh` / `cap.sh` | the `.app` wrapper, one-shot launcher, daemon control, captions launcher |

## Other Mentra glasses (recognized; ports staged)

`scan.mjs` identifies every Mentra/Even family by name. G1/G2 are fully driven;
the rest have complete protocol maps ready to port (the blocker is hardware to
verify against — don't write to colleagues' devices):

**Mentra Nex / Display** (`Nex1-*`, `MENTRA_DISPLAY_*`) — protobuf-over-BLE
*display* glasses, single device (no L/R). The most aligned with this toolkit.
- Service `00004860-…`, write `000071FF-…` (no-response), notify `000070FF-…`, MTU 517.
- Framing: first byte = packet type (`0x02` protobuf, `0xA0` LC3 audio, `0xB0` image),
  then `[seq][totalChunks][chunkIndex]` + payload. maxFragment = MTU-10-4.
- Commands = `PhoneToGlasses` protobuf oneof: `display_text{color,text,size,x,y}`,
  `clear_display{}`, `display_image{stream_id,total_chunks,x,y,w,h,encoding}` + `0xB0`
  chunks, `mic_state{enabled}`, `battery_state{}`, `brightness{value 0-63}`,
  `head_up_angle{angle}`. Responses = `GlassesToPhone` (battery/device_info/imu/button/gesture).
  Mic = LC3 on `0xA0` packets. **To finish:** extract the proto field numbers from
  `MentraosBle.java` and hand-encode like g2.mjs (or use protobufjs).

**Mentra Live** (`Mentra_Live_*`) — *camera* glasses, **no display**. ✅ **DRIVEN**
(`live.mjs`, hardware-tested on a real DA08): connect, init handshake, **battery
(92%, charging)**, event decode (`glasses_ready`/`version`/`wifi`/`hotspot`),
**photo capture** (`glasses photo`). JSON-over-BLE.
- Service `00004860-…`, write `000071FF-…`, notify `000070FF-…`, file `0x72FF/0x73FF`,
  LC3 mic on `6E400002` (`0xF1`+seq, 40-byte frames). Single device (no L/R).
- K900 frame: `[0x23 0x23][type][len][ {"C":"<json>","W":1} ][0x24 0x24]`. **Length is
  little-endian when the phone sends, BIG-endian when the glasses send** (the two K900
  packers differ — verified against real bytes). Chunked >200B.
- Commands = JSON `{type: phone_ready|ping|request_version|request_battery_state|take_photo|…}`.
  Responses = `battery_status|sr_hrt|button_press|photo_response|wifi_status|pong|…`.
- Known firmware bug surfaced: `take_photo` returns `success:false` with
  `…asg_client.camera: open failed: EISDIR` — the glasses try to save to a directory.
  (asg_client-side; the protocol/command path works end-to-end.)
- Mic (LC3 on `6E400002`) is wired into the same audio fan-out as G2, so the captions
  bridge can in principle run on Live too (untested; Live mic may need a call/record trigger).

### Live media paths (photo + stream back to the laptop) — all hardware-verified

All three proven e2e on a real Mentra Live: WiFi photo (212KB 1280x960 JPEG),
BLE photo (2831B 400x300 AVIF, 8 packs in 177ms), RTMP stream (15s h264 854x480).
Gotchas encoded below: the K900 file-pack `fileSize` header overstates the real
payload, so completion counts packets (like the phone), and port 1935 is often
taken (Docker) — the e2e uses 19355.

The daemon runs a **media receiver** on `0.0.0.0:<port+2>` (default `8801`) that
accepts the glasses' photo uploads, saving JPEGs into `ble/photos/`:

- **WiFi photo** (`glasses photo wifi`): the unmanaged `take_photo` path — the
  daemon auto-sets `webhookUrl=http://<lanIp>:8801/photo-upload` and the glasses
  POST the JPEG as `multipart/form-data` (parts: `photo`, `requestId`, `type`,
  `success`, optional `Authorization: Bearer`). Needs glasses + laptop on the
  same LAN without client isolation (or `adb reverse tcp:8801 tcp:8801` over USB
  and `webhookUrl=http://127.0.0.1:8801/photo-upload`).
- **BLE photo** (`glasses photo ble`): no WiFi needed — the glasses send the
  image as K900 file packets on char `72FF` (`## type packSize packIndex fileSize
  fileName[16] flags data verify $$`, big-endian, verify = sum(data)&0xFF; image
  may be `.avif` or `.jpg`). The manager reassembles, confirms with
  `transfer_complete`, and saves. `glasses photos` lists what's arrived.
- **RTMP stream** (`glasses stream start [url]` / `glasses stream stop`): sends
  `start_stream {streamUrl}` (RTMP/SRT/WHIP per asg `StreamCommandHandler`);
  default URL is `rtmp://<lanIp>:1935/live/harness` — run a local listener with
  `ffmpeg -listen 1 -i rtmp://0.0.0.0:1935/live/harness -c copy out.flv`. Send
  `keep_stream_alive` periodically during long streams.
- **`live-e2e.sh <serial>`**: unattended end-to-end test of all three (waits for
  the glasses to advertise, runs WiFi photo, BLE photo, RTMP, reports).

**Mach1** — camera glasses, BLE, no WiFi.

## Remote Glasses: the emulator app drives real glasses

The daemon also runs a **remote-SGC bridge** on `0.0.0.0:<port+3>` (default
`8802`): a plain-TCP, newline-delimited-JSON endpoint the app's dev-only
`RemoteHarness` driver (in `mobile/modules/bluetooth-sdk`) connects to from the
Android emulator (`10.0.2.2`). The app then behaves as if physically paired:
its display/brightness/mic/battery calls land on the real glasses, and the real
glasses microphone streams back into the app's normal audio pipeline (cloud
transcription runs on real mic audio).

```bash
./gd.sh start && bun glasses.mjs connect <serial>   # daemon holds the glasses
bun ../cli.ts rpc connectRemoteGlasses              # emulator app pairs to them
bun ../cli.ts rpc glassesText '{"text":"hi"}'       # app -> real lens
```

Verified e2e: app text on a physical G2 lens, and speech at the G2 mic coming
back as a final cloud transcript inside the emulator app. Gotcha: the dev
setting `cloud_audio_codec=pcm` (for injected audio) corrupts the glasses-mic
path — set it back to `lc3` and reconnect.

## Gotchas (learned the hard way)

- **Glasses must be awake and OFF your phone** to be reachable — a BLE peripheral
  only talks to one central. Turn the phone's Bluetooth off; unfold the arms.
- **The mic only streams when a display page exists** — `mic on` creates one
  first; if you call `AUDIO_CONTROL` with no page, `audioFrames` stays 0.
- **AWS edge sometimes drops the first WS upgrade** (`1002 / Expected 101`) — the
  captions bridge retries the connect.
- **Transcription language is bare ISO** (`en`, not `en-US`) — Soniox rejects
  BCP-47 region codes.

## G2 images: the protocol that actually works (fw 2.2.4.34, 2026-06-11)

The repo's G2.kt displayBitmap path never rendered on real firmware. Rules
discovered by hardware experiment + community RE (see CONFORMANCE.md):

1. Only SINGLE-fragment image streams render (whole 4-bit BMP <= 4096 bytes,
   118-byte header included). Multi-fragment always fails frag 1+ (ack code 5).
   Big images tile into <= 4 single-fragment strip containers.
2. Image containers register only via REBUILD_PAGE on a page this BLE session
   owns (shutdown -> create first). Repeat CREATEs are silently ignored.
3. Text container id 1 is reserved; image ids 2+ coexist with text. IMU/touch
   events require an event-capture (text) container on the page.
4. Ack-gate everything: replies echo your magic; ImgRes code 4 ok / 5 fail,
   RebuildRes 6 ok / 7 fail. Use 8ms BLE packet gaps for image streams.

Daemon API:
  POST /image        {bmpBase64|, width, height, x, y, label, imageOnly}  one image (+page)
  POST /image        {tiled:true, grayBase64, width, height}              tiled photo (4 strips)
  POST /imagePage    {text, tiles:[{id,x,y,width,height}]}                declare game/UI page
  POST /imageUpdate  {id, grayBase64, width, height, gapMs:8}             partial update (fast)

Rates (ack-gated): 32px 11fps, 48px 8.4, 64px 4.4, 88px 2.5 (fps ~= 9500/bytes).
Dithers in bmp.mjs: ditherTo16 (Floyd-Steinberg), ditherAtkinson, ditherBayer
(Bayer for animation: stable pattern, no shimmer). Demos: lens-clock.mjs,
lens-balance.mjs (head-tilt ball game), button-to-lens.mjs (Live button ->
photo on G2 lens, IMU auto-orientation, inverted+dithered).
