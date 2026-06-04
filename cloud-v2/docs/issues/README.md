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
| [auth](./001-cloud-core/auth/) | Mixed | the auth system. The contract (`auth/spec.md`) and the e2e implementation design (`auth/design.md`) are written; oem-auth Implemented; identity + auto-auth Spiked |
| [auth / spec + design](./001-cloud-core/auth/spec.md) | Specced | [spec.md](./001-cloud-core/auth/spec.md) (endpoints + tokens) and [design.md](./001-cloud-core/auth/design.md) (e2e code changes across cloud-core, cloud-client, on-device, dev SDK): exchange, refresh, miniapp-token mint, JWKS |
| [auth / oem-auth](./001-cloud-core/auth/oem-auth/) | Implemented | the OEM-JWT exchange mechanics, built in v2, e2e verified with `test-oem`. Left: finalize doc review |
| [auth / identity](./001-cloud-core/auth/identity/) | Spiked | Mentra-direct identity (app + console + store) unifies on the access token, plus the core-token migration bridge |
| [auth / auto-auth](./001-cloud-core/auth/auto-auth/) | Spiked + proposal | end-to-end miniapp dev-backend flow; mint + JWKS in `auth/spec.md`; [injection.md](./001-cloud-core/auth/auto-auth/injection.md) proposal. Open: API key role |
| [oem-service](./001-cloud-core/oem-service/) | Stub | needs spec |
| [miniapp-service](./001-cloud-core/miniapp-service/) | Stub | needs spec (stores bundles via storage-service) |
| [dev-console-service](./001-cloud-core/dev-console-service/) | Stub | needs spec |
| [storage-service](./001-cloud-core/storage-service/) | Stub | needs spec (wrapper around swappable blob providers; used by miniapp-service, dev-console-service) |
| **[002-cloud-runtime](./002-cloud-runtime/)** | | self-hostable runtime product |
| [protocol (transport)](./002-cloud-runtime/protocol.md) | Locked | contract locked (`/api` paths, envelope with `timestamp`, REST subscriptions 2a with `sessionId`+`version`, UDP encryption). Left: write the zod types in `@mentra/cloud-runtime/protocol` |
| [audio](./002-cloud-runtime/audio/) | Specced / partial | spec + design (proposal, under review); pipeline partially built (UDP + Redis + Soniox, phone WS). Subscription transport decided (2a: REST + stream entry); UDP encryption documented |
| [camera (managed photo + stream)](./002-cloud-runtime/camera/) | Specced | [spec.md](./002-cloud-runtime/camera/spec.md): presigned-upload photo (cloud out of the byte path, storage-event completion, `photo.ready` push) + client-controlled managed stream |
| **[003-cloud-proxy](./003-cloud-proxy/)** | Stub | needs spike (non-blocking; cloud-client is proxy-aware via endpoint config) |
| **[004-cloud-client](./004-cloud-client/)** | Specced | [spec.md](./004-cloud-client/spec.md): concrete `@mentra/cloud-client` API (auth / runtime / core, per-event methods, injected transports). Plus [island-adapter.md](./004-cloud-client/island-adapter.md) proposal |
| **[005-websites](./005-websites/)** | | web frontends |
| [console](./005-websites/console/) | Stub | needs spec |
| [miniapp-store](./005-websites/miniapp-store/) | Stub | needs spec |
| [oem-portal](./005-websites/oem-portal/) | Spiked | spike in progress. Left: spec + design |
| **[006-dev-toolkit](./006-dev-toolkit/)** | | developer toolkit |
| [local-sdk](./006-dev-toolkit/local-sdk/) | Spiked | findings + open questions, not yet a proposal. Left: spec + design |
| [cli](./006-dev-toolkit/cli/) | Stub | needs spec |

## Open decisions

- None blocking right now. Recently decided: audio subscription transport
  (Option 2a, REST + stream control entry, see
  [`002-cloud-runtime/audio/subscription-transport.md`](./002-cloud-runtime/audio/subscription-transport.md));
  `mentraUserId` = `users._id`; the Mentra-as-OEM core-token migration bridge.

## What to spec next (rough order)

1. Review and lock `002-cloud-runtime/protocol.md` (now includes REST
   subscriptions, UDP encryption, the corrected frame), then add the shared zod
   types in `@mentra/cloud-runtime/protocol`.
2. Spec the `004-cloud-client` runtime module (the client end of the protocol).
3. Spec the rest of `001-cloud-core` (storage-service first, then miniapp-service
   and dev-console-service that depend on it) since the websites depend on them.
4. Promote `oem-portal` and `local-sdk` from spike to spec.
