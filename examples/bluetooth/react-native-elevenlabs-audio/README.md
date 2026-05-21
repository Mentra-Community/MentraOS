# React Native ElevenLabs Audio Repro

Minimal Expo development-build app for reproducing Mentra Live microphone audio issues when streaming glasses PCM into an ElevenLabs Conversational AI agent over WebSocket.

The ElevenLabs API key stays on your Mac. The app asks a local signing server for a signed WebSocket URL and only receives the signed URL.

## Run On Android

```bash
cd examples/react-native-elevenlabs-audio
bun install
cp .env.example .env.local
```

Put your ElevenLabs API key in `.env.local`, then run:

```bash
set -a
source .env.local
set +a
bun run android:dev
```

`bun run android:dev` starts the local signing server on port `8788`, starts Metro on port `8082`, forwards both ports to the connected Android device with `adb reverse`, installs the development build, and opens the app.

If multiple Android devices are connected, set `ANDROID_SERIAL`.

## What It Sends

- Glasses microphone PCM from `BluetoothSdk.addListener('mic_pcm', ...)`
- `BluetoothSdk.setMicState(true, true, true, false, false)` for continuous Mentra Live glasses PCM
- Base64 encoded `pcm_s16le`, 16 kHz, 16-bit, mono audio chunks
- ElevenLabs WebSocket messages shaped as `{ "user_audio_chunk": "..." }`

The screen shows scan/connect state, WebSocket state, PCM metadata, frame counts, sent chunks, dropped chunks, transcripts, and agent responses.
