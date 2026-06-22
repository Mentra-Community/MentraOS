# Everything backend

Backend for the **Everything** miniapp. The miniapp sends the chat history to
this service, and this service runs an agentic Claude tool-calling loop
(`@anthropic-ai/sdk`, model `claude-opus-4-8` by default) with the
`code_execution` and `web_search` server tools. When a request benefits from a
visual — e.g. "show me a 7-day weather chart" — Claude searches for the data and
renders a chart PNG in the code-execution sandbox; the backend returns the answer
text plus the chart as base64, which the miniapp displays in the chatbox and on
the glasses via `session.canvas.showBitmap`. All AI secrets stay off-device.

```bash
cd miniapps/everything
cp .env.example .env   # set ANTHROPIC_API_KEY
bun run backend:dev:local
```

Health check:

```bash
curl localhost:3131/healthz   # -> {"status":"ok","service":"everything-backend","model":"claude-opus-4-8"}
```

Shared secrets can live in Doppler project `local-everything`:

```bash
cd miniapps/everything
doppler run --project local-everything --config dev -- bun run backend:dev:local
```

To run the backend and local miniapp dev server together:

```bash
cd miniapps/everything
bun run dev          # via Doppler
bun run dev:local    # via local .env, no Doppler
```

For USB testing on Android, reverse the backend port:

```bash
adb reverse tcp:3131 tcp:3131
```

The miniapp dev sidecar uses `3124`, so the backend uses `3131` in dev.

The `/api/chat` route requires a Mentra miniapp token. In local development the
backend verifies that token against Cloud Core's JWKS. The production JWKS is the
default, so only override it when testing against local/staging Core:

```bash
MENTRA_AUTH_JWKS_URL=http://localhost:3000/.well-known/jwks.json
EVERYTHING_PACKAGE_NAME=com.mentra.everything
```

The mobile host mints the token via `cloudClient.auth.getMiniappToken(...)` and
the miniapp sends it with `session.auth.fetch(...)`. Core/runtime tokens are not
exposed to the miniapp.

## Environment

- `ANTHROPIC_API_KEY` — required; the Claude API key (backend-only secret).
- `EVERYTHING_MODEL` — model id, defaults to `claude-opus-4-8`.
- `PORT` — defaults to `3131`.
- `EVERYTHING_PACKAGE_NAME` — token audience, defaults to `com.mentra.everything`.
