# v3 Smoke Test

Minimal mini app used to validate the SDK v3 runtime and Hono webview developer flow.

This app intentionally keeps the product surface area tiny while exercising the parts that matter for v3:

- `MiniAppServer`
- `MentraSession`
- transcription subscription
- basic display output
- reconnect callback
- Bun fullstack `/webview` route
- `@mentra/react` auth initialization
- `createMentraAuthRoutes()` token exchange
- authenticated Hono API routes
- Bun HMR for the frontend

It exists to prove the new v3 API and developer experience without the unrelated complexity of the larger example apps.
