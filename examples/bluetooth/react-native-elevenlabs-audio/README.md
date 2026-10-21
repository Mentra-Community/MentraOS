# React Native ElevenLabs Audio Repro

Minimal Expo development-build app for reproducing Mentra Live microphone audio issues when streaming glasses PCM into an ElevenLabs Conversational AI agent over WebSocket.

The ElevenLabs API key stays on your Mac. The app asks a local signing server for a signed WebSocket URL and only receives the signed URL.

## Run On Android

In MentraOS this example is a member of the `sdk/` Bun workspace, which links
`@mentra/bluetooth-sdk` to the SDK source in `mobile/modules/bluetooth-sdk`.
From the MentraOS root, install the workspace and build the SDK's config plugin:

```bash
cd sdk && bun install && cd ..
(cd mobile/modules/bluetooth-sdk && bun run build:plugin)
cd examples/bluetooth/react-native-elevenlabs-audio
cp .env.example .env.local
```

`metro.config.js` watches `mobile/modules`, `cloud-v2/packages`, and the `sdk/`
workspace store so Metro can serve the SDK source.

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
- `BluetoothSdk.setMicState(true, true)` for continuous Mentra Live glasses PCM
- `BluetoothSdk.setVoiceActivityDetectionEnabled(false)` while streaming so the glasses do not VAD-gate PCM before ElevenLabs receives it
- Base64 encoded `pcm_s16le`, 16 kHz, 16-bit, mono audio chunks
- ElevenLabs WebSocket messages shaped as `{ "user_audio_chunk": "..." }`

The screen shows scan/connect state, WebSocket state, PCM metadata, frame counts, sent chunks, dropped chunks, transcripts, and agent responses.
