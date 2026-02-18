# livekit-speaker-2 (Bun)

A Bun/TypeScript port of the Go `livekit-speaker-2` tool. It connects to a LiveKit room and plays PCM16 audio sent via data packets. It mirrors the Go tool's flags and env vars as closely as practical.

Key features:

- Connect via LIVEKIT_URL + token (or mint a token using LIVEKIT_API_KEY/SECRET + LIVEKIT_ROOM_NAME)
- Subscribe to data packets only (no media tracks).
- Expect payload as Uint8Array[seq?, ...pcm16@16k] — if odd length, first byte is seq, rest is PCM16.
- Jitter buffer with optional old-frame dropping based on target/max latency.
- Beep test tone and pipe-beep injection.
- Optional periodic throughput/status logs.
- Auto-rejoin on stall.

## Usage

Environment variables:

- LIVEKIT_URL: wss://<your-livekit>
- LIVEKIT_TOKEN: optional; if missing, LIVEKIT_API_KEY/SECRET + LIVEKIT_ROOM_NAME must be set to mint a token.
- LIVEKIT_API_KEY / LIVEKIT_API_SECRET: used only when minting a token
- LIVEKIT_ROOM_NAME: room to join
- LIVEKIT_IDENTITY: identity when minting

Run (Dev):

```sh
bun run start -- --frames-only
```

Flags (subset mirrors Go):

- --url
- --token
- --room
- --identity
- --target
- --frames-only
- --beep
- --beep-dur
- --pipe-beep
- --expected-sr
- --max-latency-ms
- --target-latency-ms
- --drop-old
- --auto-rejoin-on-stall
- --stall-ms
- --inspect
- --watch

## Notes

- Audio output uses Web Audio via `node-webaudio-api` when running on Bun. On macOS this should work out of the box; if not, it falls back to file output `out.raw`.
- If you only need logs, pass `--frames-only` to suppress audio playback.
