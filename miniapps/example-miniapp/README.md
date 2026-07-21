# Mentra Example Miniapp

Reference MentraOS miniapp for the `@mentra/miniapp` SDK — captions demo plus the full per-iface SDK Tester surface.

## Dev

```bash
cd miniapps/example-miniapp
bun install
bun run dev
```

## ElevenLabs ConvAI tester

Ports the React Native [`react-native-elevenlabs-audio`](../../Mentra-Bluetooth-SDK-Starter-Kit/examples/react-native-elevenlabs-audio) repro into **Tester → ElevenLabs**.

Same logic and variables:

| Variable | Default |
|----------|---------|
| Agent ID | `agent_0301ks3wg64pf9evgxqa6dw34t1f` |
| Signed URL endpoint | auto: `http://<this-Mac-LAN-IP>:8788/signed-url` at build time |
| Signing server port | `8788` |

Flow: local signing server (holds `ELEVENLABS_API_KEY`) → background fetches signed URL → WebSocket → `session.mic.onAudioChunk` as `{ user_audio_chunk }`. Agent audio events are logged only (no glasses playback).

### Setup

```bash
cp .env.example .env.local
# put ELEVENLABS_API_KEY in .env.local
bun run dev      # auto-starts the signing server on :8788 if needed, then mentra-miniapp dev
```

Open the miniapp → **ElevenLabs** → **Start**.

`bun run build` / `dev` bakes the signed-URL endpoint to this Mac’s LAN IP. Override with `MENTRA_PUBLIC_ELEVENLABS_SIGNED_URL_ENDPOINT` if needed. Keep the API key in `.env.local` only — never bake it into the miniapp.

Manual signer only: `bun run signer`. Miniapp-only (no signer): `bun run dev:miniapp`.

### Notes

- Glasses must already be connected via MentraOS (no scan/pair UI).
- Do not run the `session.mic` tester and ElevenLabs at the same time (both own the mic).
- Glasses VAD disable (`setVoiceActivityDetectionEnabled(false)`) is not exposed on the miniapp mic API; this stream uses whatever PCM the host delivers after LC3 decode (~16 kHz mono).
