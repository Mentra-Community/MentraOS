# SDK Test

MentraOS mini app for testing SDK features end-to-end. Cloned from `hono-example-app` — same fullstack structure (Hono backend + React webview), repurposed as an SDK test harness.

## Setup

```bash
cp .env.example .env
# Fill in PACKAGE_NAME and MENTRAOS_API_KEY

bun install
bun run dev
```

## What this tests

- Session lifecycle (connect, disconnect, reconnect)
- Transcription streaming
- Audio playback (TTS, file URLs)
- Photo capture
- Settings / Simple Storage
- Touch + button input
- Error classes (`MentraAuthError`, `MentraConnectionError`, etc.)
- Clean logger output (`MentraOS ✓/⚠/✗`)
- Version check (dist-tag aware, hits npm directly)

## Structure

```
src/
  index.ts                      ← entry point (SdkTestApp + Bun.serve)
  backend/
    MiniApp.ts                  ← SdkTestApp extends AppServer
    UserSession.ts              ← per-user state + static session store
    api/
      index.ts                  ← mounts feature sub-apps
      audio.api.ts              ← POST /api/audio/speak, /api/audio/stop
      photo.api.ts              ← GET  /api/photo/latest, /api/photo/:id, /api/photo/:id/base64
      storage.api.ts            ← GET+POST /api/storage/theme
      stream.api.ts             ← GET  /api/stream/photo, /api/stream/transcription (SSE)
    managers/
      AudioManager.ts
      InputManager.ts
      PhotoManager.ts
      StorageManager.ts
      TranscriptionManager.ts
  frontend/
    index.html                  ← React webview entry
    App.tsx
    pages/home/
      HomePage.tsx
      components/
        AudioControls.tsx
        PhotoStream.tsx
        TranscriptionFeed.tsx
        SystemLogs.tsx
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PACKAGE_NAME` | ✅ | App package name (must match console.mentra.glass) |
| `MENTRAOS_API_KEY` | ✅ | API key from developer console |
| `PORT` | | Server port (default: 3000) |
| `COOKIE_SECRET` | | Cookie signing secret (defaults to API key) |
| `MENTRA_VERBOSE` | | Set to `true` for full structured log output |
| `MENTRA_LOG_LEVEL` | | `none`, `error`, `warn`, `info`, `debug` |