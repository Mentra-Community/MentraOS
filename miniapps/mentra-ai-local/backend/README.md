# Mentra AI (local) backend

Backend for the Mentra AI local miniapp. It holds the AI secrets (OpenRouter +
Jina) so they never ship inside the miniapp bundle. The miniapp background
calls three authenticated routes and this service runs the AI server-side.

Every model — Gemini, Claude, or GPT — runs through **OpenRouter**'s
OpenAI-compatible API behind a single key. The user picks the model in the
miniapp settings; the client sends the chosen OpenRouter slug with each
`/api/agent` request. Valid models live in `src/services/models.ts` (all are
vision-capable, so Mentra Live photo analysis works regardless of the pick).

- `POST /api/classify` — does this query need the camera photo? (fast OpenRouter call)
- `POST /api/agent` — run the full tool-loop on the selected model, return the answer
- `POST /api/search` — Jina web search (also called in-process by the agent loop)
- `GET  /healthz` — liveness + default model

Secrets live in Doppler (project `mentra-ai`, config `dev`). The dev scripts use
it automatically:

```bash
cd miniapps/mentra-ai-local
bun run backend:dev   # backend only, secrets from Doppler
bun run dev           # backend + miniapp dev server together
```

First-time Doppler connect (once per machine):

```bash
doppler setup --project mentra-ai --config dev
```

Without Doppler, copy the env file and use the `:local` scripts:

```bash
cp .env.example .env
bun run backend:dev:local
bun run dev:local
```

The miniapp dev sidecar uses `3123`, so the backend uses `3131` in dev.

`bun run dev` also starts **ngrok** on the reserved domain
`general.dev.tpa.ngrok.app`, forwarding the public HTTPS URL to the local
backend on `3131`. The miniapp bundle is built pointing at that ngrok URL, so it
works from a real phone over the network (no USB bridge needed). Override the
domain with `NGROK_DOMAIN`, or skip ngrok entirely with `bun run dev:localhost`
(+ `adb reverse tcp:3131 tcp:3131` for Android USB).

## Auth

The three `/api/*` routes require a Mentra miniapp token. The mobile host mints
it via `cloudClient.auth.getMiniappToken(...)` and the miniapp background sends
it with `session.auth.fetch(...)`. The backend verifies the token against Cloud
Core's JWKS and enforces `aud = PACKAGE_NAME`. The production JWKS is the
default, so only override it when testing against local/staging Core:

```bash
MENTRA_AUTH_JWKS_URL=http://localhost:3000/.well-known/jwks.json
MENTRA_AUTH_ISSUERS=cloud-core,mentra
PACKAGE_NAME=com.mentra.ai.local
```

## Secrets

Backend-only secrets (never prefixed `MENTRA_PUBLIC_`, never inlined into the
bundle):

- `OPENROUTER_API_KEY` — agent + classifier (serves all models)
- `JINA_API_KEY` — web search
- `LLM_MODEL` — default OpenRouter slug when the client sends none (the settings
  picker normally overrides this per request; must be a slug from `models.ts`)
- `OPENROUTER_SITE_URL`, `OPENROUTER_APP_TITLE` — *optional* ranking headers
- `OPENROUTER_BASE_URL` — *optional* override (proxies / testing)

The only value baked into the miniapp bundle is the public backend URL
(`MENTRA_PUBLIC_MENTRA_AI_BACKEND_URL`).
