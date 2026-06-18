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
adb reverse tcp:3123 tcp:3123
```

Set `MERGE_ENABLE_WEB_SEARCH=true` to allow Gemini Google Search grounding for
public, current facts. Leave it off for private/project context unless that
context is explicitly provided to the backend.
