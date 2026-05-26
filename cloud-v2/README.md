# Cloud V2

The MentraOS cloud rewrite for the local JS miniapp SDK.

## Goals

- Horizontally scalable from day one (multi-pod, workers within each pod using all cores)
- Three deployable packages so OEMs can self-host parts if needed
- Discard v1's deprecated cloud-side app session machinery

## Layout

```
cloud-v2/
├── packages/
│   ├── core/      Mentra Services (OEM auth, portal backend, REST, miniapp store)
│   ├── audio/     Audio Stack (UDP ingress, workers, transcription/translation)
│   ├── proxy/     Forwarder / reverse proxy (OEM-deployable)
│   └── shared/    Types, config, observability primitives
├── docs/
│   ├── issues/    Spec + design per work item (see cloud-v2/docs/issues/)
│   └── ...        runbooks, architecture, protocols, deployment (TBD)
├── test/          Cross-package integration, TEST OEM, e2e suite (TBD)
├── deploy/        K8s, Helm, Porter, Docker (TBD)
├── scripts/       bun-based dev tooling (setup, etc.)
└── docker-compose.dev.yml
```

## Quick start

Prerequisites:
- Bun >= 1.2.0 (`curl -fsSL https://bun.sh/install | bash`)
- Docker (for local Redis)
- Doppler CLI (for secrets; once configured)

```sh
bun install            # install dependencies (workspace-aware)
bun run setup          # one-time pre-flight (Redis container, schema migrations)
bun run dev:core       # run core in watch mode
bun run dev:audio      # run audio in watch mode (in another terminal)
```

Iteration: save a file, Bun restarts the affected package in well under a second.

## Tech stack

- **Runtime:** Bun (pinned via `engines.bun` and `.tool-versions`)
- **Language:** TypeScript strict
- **HTTP:** Hono
- **WebSocket:** Bun's native WS
- **Mongo driver:** Mongoose 8.x
- **Redis driver:** ioredis
- **JWT:** jose
- **Logger:** pino (shipped to BetterStack via Vector)
- **Validation:** zod
- **Tests:** `bun test`

## Where to read more

- [`docs/issues/`](./docs/issues/) — spec + design per work item
  - [001-oem-auth](./docs/issues/001-oem-auth/) — runtime OEM auth (JWT exchange)
  - [002-oem-portal](./docs/issues/002-oem-portal/) — OEM admin portal (planning)
  - [003-audio](./docs/issues/003-audio/) — audio path architecture
- Linear project: [Cloud V2](https://linear.app/mentralabs/project/cloud-v2-3bd87f2acfdc)
- Tracking PR: [#2766](https://github.com/Mentra-Community/MentraOS/pull/2766)
