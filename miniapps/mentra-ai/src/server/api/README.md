# api/

Handler functions for each API endpoint. Each file exports pure functions that take a Hono `Context` and return a `Response`.

These are **not** routed directly — they're wired up in `routes/routes.ts`.

| File         | Handlers                                    |
| ------------ | ------------------------------------------- |
| `health.ts`  | `getHealth`                                 |
| `stream.ts`  | `photoStream`, `transcriptionStream`        |
| `audio.ts`   | `speak`, `stopAudio`                        |
| `storage.ts` | `getThemePreference`, `setThemePreference`  |
| `photo.ts`   | `getLatestPhoto`, `getPhotoData`, `getPhotoBase64` |
