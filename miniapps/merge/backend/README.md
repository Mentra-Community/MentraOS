# Local Merge backend

Backend for the Local Merge miniapp. The miniapp sends conversation analysis
chunks to this service, and this service calls Gemini with server-side secrets.
Chunks can come from finalized utterances, interim sentence boundaries, or long
ongoing interim speech.

```bash
cd miniapps/merge
cp .env.example .env
bun run backend:dev
```

Shared secrets live in Doppler project `local-merge`:

```bash
cd miniapps/merge
doppler run --project local-merge --config dev -- bun run backend:dev
```

To run the backend and local miniapp dev server together:

```bash
cd miniapps/merge
bun run dev
```

For USB testing on Android, reverse the backend port:

```bash
adb reverse tcp:3130 tcp:3130
```

The miniapp dev sidecar uses `3123`, so the backend uses `3130` in dev.

The `/api/insights` route requires a Mentra miniapp token. In local development
the backend verifies that token against Cloud Core's JWKS:

```bash
MENTRA_CORE_URL=http://localhost:3000
MERGE_PACKAGE_NAME=com.mentra.local-merge
```

The mobile host mints the token via `cloudClient.auth.getMiniappToken(...)` and
the miniapp sends it with `session.auth.fetch(...)`. Core/runtime tokens are not
exposed to the miniapp.

Set `MERGE_ENABLE_WEB_SEARCH=true` to allow Gemini Google Search grounding for
public, current facts. Leave it off for private/project context unless that
context is explicitly provided to the backend.
