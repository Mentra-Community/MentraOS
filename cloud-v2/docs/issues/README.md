# Cloud V2 issues: spec status

Index and status tracker for the things we own, organized by product (matching
the [overhaul plan](../mentra-overhaul-plan.md) taxonomy and diagram). Use this
to see at a glance what is properly specced and what still needs speccing.

Keep the status column in sync with each doc's own `**Status:**` line as work
lands.

## Legend

- **Implemented**: specced and built in v2 (may still be under doc review).
- **Specced**: spec and design exist and are review-ready; buildable.
- **Spiked**: research/spike only, surfaces open questions; needs a real spec.
- **Draft**: an early draft exists, not yet reviewed.
- **Stub**: placeholder folder only; not started.
- **Blocked**: waiting on an open decision (see "Open decisions").

## Status

| Issue / service | Status | What exists / what is left |
| --- | --- | --- |
| **[001-cloud-core](./001-cloud-core/)** | | proprietary cloud product |
| [auth](./001-cloud-core/auth/) | Mixed | the auth system. oem-auth Implemented; identity + miniapp auto-auth Spiked; console/store auth not started |
| [auth / oem-auth](./001-cloud-core/auth/oem-auth/) | Implemented | spec + design (under review), built in v2, e2e verified with `test-oem`. Left: finalize doc review |
| [auth / identity](./001-cloud-core/auth/identity/) | Spiked | Mentra-direct identity (app + console + store) unifies on the access token. Left: resolve open questions, then spec |
| [auth / auto-auth](./001-cloud-core/auth/auto-auth/) | Spiked | the Phase 2 dev-backend mechanism (miniapp-scoped JWT, JWKS). Left: resolve open questions, then spec |
| [oem-service](./001-cloud-core/oem-service/) | Stub | needs spec |
| [miniapp-service](./001-cloud-core/miniapp-service/) | Stub | needs spec (stores bundles via storage-service) |
| [dev-console-service](./001-cloud-core/dev-console-service/) | Stub | needs spec |
| [storage-service](./001-cloud-core/storage-service/) | Stub | needs spec (wrapper around swappable blob providers; used by miniapp-service, dev-console-service) |
| **[002-cloud-runtime](./002-cloud-runtime/)** | | self-hostable runtime product |
| [protocol (transport)](./002-cloud-runtime/protocol.md) | Draft | transport contract drafted. Left: team review, then zod types in `@mentra/cloud-runtime/protocol` |
| [audio](./002-cloud-runtime/audio/) | Specced / partial | spec + design (proposal, under review); pipeline partially built (UDP + Redis + Soniox, phone WS). Blocked on subscription transport |
| [camera (managed photo + stream)](./002-cloud-runtime/camera/) | Stub | needs spec |
| **[003-cloud-proxy](./003-cloud-proxy/)** | Stub | needs spec (hosted connector vs config model) |
| **[004-cloud-client](./004-cloud-client/)** | Spiked | headless `@mentra/cloud-client`; design in [spike.md](./004-cloud-client/spike.md) (auth / runtime / core modules). Left: subscription decision, lock protocol, then spec |
| [runtime](./004-cloud-client/runtime/) | Stub | the live-session transport. Depends on 002 protocol + the subscription decision |
| **[005-websites](./005-websites/)** | | web frontends |
| [console](./005-websites/console/) | Stub | needs spec |
| [miniapp-store](./005-websites/miniapp-store/) | Stub | needs spec |
| [oem-portal](./005-websites/oem-portal/) | Spiked | spike in progress. Left: spec + design |
| **[006-dev-toolkit](./006-dev-toolkit/)** | | developer toolkit |
| [local-sdk](./006-dev-toolkit/local-sdk/) | Spiked | findings + open questions, not yet a proposal. Left: spec + design |
| [cli](./006-dev-toolkit/cli/) | Stub | needs spec |

## Open decisions (blocking)

- **Audio subscription transport** (WS vs REST vs REST + pub/sub).
  [`002-cloud-runtime/audio/subscription-transport.md`](./002-cloud-runtime/audio/subscription-transport.md).
  Blocks finalizing 002 audio and designing the 004 cloud-client runtime module.

## What to spec next (rough order)

1. Resolve the audio subscription transport decision (unblocks two issues).
2. Review and lock `002-cloud-runtime/protocol.md`, then add the shared zod types.
3. Spec the `004-cloud-client` runtime module (the client end of the protocol).
4. Spec the rest of `001-cloud-core` (storage-service first, then miniapp-service
   and dev-console-service that depend on it) since the websites depend on them.
5. Promote `oem-portal` and `local-sdk` from spike to spec.
