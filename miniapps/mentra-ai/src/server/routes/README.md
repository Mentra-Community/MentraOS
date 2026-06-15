# routes/

Maps HTTP methods and paths to handler functions from `api/`.

`routes.ts` is the single file that defines all API routes. It imports handler functions and wires them to Hono — no logic lives here, just the routing table.

```
GET  /health                 → getHealth
GET  /photo-stream           → photoStream (SSE)
GET  /transcription-stream   → transcriptionStream (SSE)
POST /speak                  → speak
POST /stop-audio             → stopAudio
GET  /theme-preference       → getThemePreference
POST /theme-preference       → setThemePreference
GET  /latest-photo           → getLatestPhoto
GET  /photo/:requestId       → getPhotoData
GET  /photo-base64/:requestId → getPhotoBase64
```
