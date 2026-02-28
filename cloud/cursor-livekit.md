# LiveKit Audio Debug Context (Maintained)

Updated: 2025-08-23

## Current Findings

- Client publishes audio via Go bridge; chunks logged with energy:
  - Example: meanAbs≈2040, rms≈2322 on some chunks; later chunks ~60–90 rms (non-silent)
- LiveKit subscriber sanity test (rtc-node) receives frames at 48kHz, Channels=1, but energy is near-silence (RMS≈0.5–0.7)
- Cloud LiveKit subscriber (server) logs pre/post resample energy per frame:
  - Subscriber sanity now receives frames but energy remains near-silent (rms≈0.6) with sampleType=int16.
  - This suggests publisher path (Go bridge/PCMLocalTrack) may be scaling/muting despite non-zero client-side chunk energy.
  - Float32-vs-Int16 fix is in; problem appears earlier (publish path) or amplitude normalization.
- Go bridge logs show room join + track published, but previously didn’t show per-chunk logs; we added always-on chunk energy logs now.

## What Works

- Client → Go bridge WebSocket connect
- Track publish in bridge (16kHz mono, LK auto-resample to 48kHz)
- Cloud receives LiveKit frames; TranscriptionManager streams can initialize

## What Fails

- Energy across LK frames is near-zero; Soniox produces no transcripts
- Subscriber sanity test also sees near-silence → implies published media is near-silent by the time it reaches LiveKit

## Hypotheses

1. PCM sample interpretation issue before WriteSample in bridge (endianness OK; int16 LE used). 2) LiveKit PCMLocalTrack expecting float or different amplitude scaling? 3) Bridge receiving PCM but with amplitude extremely low due to upstream scaling/muting. 4) WS chunks sent are mostly small-energy except first chunk; need continuous non-silent content.

## Instrumentation Added

- Client: `LiveKitGoBridgeManager.publishAudio` logs per 10th chunk energy stats
- Bridge: `handleAudioData` logs every chunk received and energy stats (meanAbs/rms/min/max) then WriteSample
- Cloud: `LiveKitManager` logs per-frame energy pre/post resample, including `sampleType` (int16|float32)

## Changes Made

- Server (`packages/cloud/src/services/session/LiveKitManager.ts`): robust frame handling
  - Detects sample type (Int16Array vs Float32Array) from `AudioStream`
  - Converts to mono Int16 safely (averaging channels; Float32 scaled by 32767)
  - Resamples to 16kHz; logs energy with `sampleType`
  - Prevents treating Float32 as Int16 which produced near-zero energy readings

## Repro Commands

- E2E (publisher):
  - `cd cloud/cloud-client && SERVER_URL=http://localhost:8002 TEST_EMAIL=user@example.com bun run src/examples/livekit-e2e-test.ts`
- Subscriber sanity:
  - `cd cloud/cloud-client && SERVER_URL=http://localhost:8002 TEST_EMAIL=user@example.com bun run src/examples/livekit-subscriber-test.ts`
- Bridge direct send (440Hz):
  - `cd cloud/cloud-client && SERVER_URL=http://localhost:8002 TEST_EMAIL=user@example.com bun run src/examples/bridge-send-chunk.ts`

## Relevant Files

- `cloud/livekit-client/main.go`: Go WebSocket → LiveKit bridge. Joins room, creates `PCMLocalTrack` at 16kHz mono, logs per-chunk energy, writes samples via `WriteSample`. Also resample helpers in `audio.go`.
- `cloud-client/src/managers/LiveKitGoBridgeManager.ts`: Client-side WS manager for Go bridge; connects, joins room, sends PCM16 chunks, logs 10th-chunk energy.
- `cloud-client/src/managers/LiveKitManager.ts`: Client-side LiveKit manager. For our flow, uses Go bridge; also supports rtc-node publisher path and chunk pacing/resampling.
- `packages/cloud/src/services/session/LiveKitManager.ts`: Server-side LiveKit subscriber. Subscribes via `AudioStream`, converts sample types (Int16/Float32) to mono Int16, resamples to 16kHz, forwards to `audioManager`. Emits detailed energy logs.
- `packages/cloud/src/routes/livekit.routes.ts`: HTTP endpoints to fetch LiveKit info and mint tokens for testing.
- `packages/cloud/src/services/session/LiveKitTokenService.ts`: Service to mint LiveKit JWTs and expose server URL.
- `cloud-client/src/examples/livekit-connection-ack-test.ts`: Verifies `CONNECTION_ACK` carries LiveKit info and auto-connect behavior.
- `cloud-client/src/examples/livekit-handshake-test.ts`: End-to-end handshake with LiveKit audio enabled; listens for transcriptions.
- `cloud-client/src/examples/livekit-subscriber-test.ts`: Standalone subscriber that measures audio energy; now detects sampleType.
- `cloud-client/src/examples/livekit-e2e-test.ts`: Full e2e flow using Go bridge publisher, installs Live Captions app, expects transcription events.
- `cloud-client/src/examples/livekit-simple-test.ts`: Minimal LiveKit connect and test-chunk send via Go bridge.

## Insights

- Near-silent frames most likely due to treating Float32 samples as Int16 on server subscriber. Fix implemented to branch on sample type and scale/mono-mix properly.
- Go bridge path logs indicate non-zero chunk energy before LiveKit, suggesting issue was downstream in subscriber handling rather than publisher scaling.
- New: With subscriber receiving frames still near-silent from Go bridge, the issue appears in the Go publish path or LiveKit PCMLocalTrack pipeline (scaling/muting). rtc-node publisher connection timed out locally, so isolation via rtc-node publisher is pending.

## Next Steps

- Re-run subscriber sanity after fix; confirm `sampleType=float32` or `int16` shows reasonable RMS (>50 for test tone/speech)
- If energy now normal: validate end-to-end STT output (Soniox) via e2e test
- If still near-zero: focus on Go bridge publish path (PCMLocalTrack.WriteSample) for scaling/muting issues
- As control, publish via rtc-node `AudioSource` in client (bypassing Go) and compare energy
  - Note: current rtc-node publisher test times out connecting; may require TURN or correct LiveKit project settings locally.

## Test Status

- Subscriber sanity test connected but received 0 frames (no publisher present). This is expected until a publisher joins the room.
- Bridge direct send successfully joined room and sent 10×100ms 440Hz tone chunks via Go bridge. Awaiting subscriber to observe frames.
- After re-run with subscriber up, frames were received but energy remained near-silent (meanAbs≈0.3, rms≈0.6, sampleType=int16) → indicates publisher path likely producing very low amplitude.
- Attempted rtc-node publisher path (bypassing Go bridge) but the client code still favored Go bridge; need a clean path to force rtc-node to isolate.
- Added bridge-side `publish_tone` and pacing; tried with PUBLISH_GAIN=4. Single-script diagnose (subscriber+bridge) still saw 0 frames → suggests bridge may not be publishing audio despite join, or publication timing mismatch.
- Docker logs (bridge): earlier showed DUPLICATE_IDENTITY kick when using same identity; fixed by using distinct identities. Now shows "Connecting to LiveKit: url=… tokenLen=… room=…" with no success/error afterward → likely WebRTC/ICE from container to LiveKit blocked or stalling.

## Networking Hypothesis

- The Go bridge container may not be able to complete WebRTC ICE/TURN to LiveKit Cloud (UDP/443/TCP constraints).
- Subscriber on host works, indicating host networking is fine; containerized bridge likely hitting firewall/NAT path.

## Next Actions

- Align LiveKit URL across cloud and bridge (done).
- Run unified diagnose with distinct identities (done) and observe bridge logs (done).
- If still hanging: run bridge outside Docker or configure LiveKit/ICE for TCP-only fallback; ensure outbound UDP/TCP 443 permitted from container.
