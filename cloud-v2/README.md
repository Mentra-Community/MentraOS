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
├── test/          Cross-package integration, TEST OEM, e2e suite (TBD)
├── deploy/        K8s, Helm, Porter, Docker (TBD)
├── scripts/       bun-based dev tooling (setup, etc.)
└── docker-compose.dev.yml
```

## Quick start

Prerequisites:

- Bun >= 1.3.0 (`curl -fsSL https://bun.sh/install | bash`) — 1.2.x has a node:tls bug that breaks MongoDB Atlas's SNI handshake (the production image pins 1.3.x for the same reason)
- Docker (for local Mongo + Redis)
- Doppler CLI with access to the `cloud-v2` project / `dev` config

```sh
cd cloud-v2
bun install            # install dependencies (workspace-aware)
bun run dev            # preflight, local Mongo/Redis, Core + Runtime + Test OEM
```

If `bun run dev` cannot start, it prints the next command or access request
needed. The direct package commands (`dev:core`, `dev:runtime`, `dev:proxy`) are
for package-level debugging after you know which service you are isolating.

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

- [Mentra Private Deployment contract](./deploy/private-deployment.md) —
  portable OCI image, configuration, manifest, health, and verification contract
- [Internal specs and designs](https://github.com/Mentra-Community/Mentra-Specs/blob/main/INDEX.md#cloud) and [cloud operations](https://github.com/Mentra-Community/Mentra-Specs/blob/main/operations/cloud/README.md) (private)
- [Shared spec workflow](https://github.com/Mentra-Community/Mentra-Specs/blob/main/AGENTS.md) — read before creating or implementing internal specs
- Linear project: [Cloud V2](https://linear.app/mentralabs/project/cloud-v2-3bd87f2acfdc)
- Tracking PR: [#2766](https://github.com/Mentra-Community/MentraOS/pull/2766)
