# Store integration

MentraOS provides the open miniapp runtime, SDK, installation and signature
verification, lifecycle/update protections, Core identity and incident APIs.
The official Store implementation lives in
[miniapp-store](https://github.com/Mentra-Community/miniapp-store): backend,
miniapp, Developer Console and staff moderation. Public builds do not clone it.

## Runtime boundaries

- The Store miniapp owns its backend URL and supplies its own scoped credential.
  The host does not route credentials by recognizing a Store hostname.
- Core issues miniapp JWTs with `kid=mentra-miniapp-1`, `iss=cloud-core`,
  `aud=<miniapp package>`, `sub=<Mentra user ID>` and `tenantId`. The Store
  verifies the configured Store package audience against Core's public JWKS.
- Core calls `POST /api/internal/dev-attestations/verify` at
  `MENTRA_STORE_INTERNAL_URL` only when a development attestation is supplied.
  Body: `{packageName, attestation}`; success: `{valid: true}`. Its service
  signature is HMAC-SHA256 over `<timestamp>\n<exact JSON request body>`.
- Store calls Core's `POST /api/internal/identity/resolve-email` with `{email}`.
  Its service signature is HMAC-SHA256 over
  `<timestamp>\n<trimmed lowercase email>`. Success returns `{mentraUserId}`;
  an unknown email returns 404.
- Both service requests use `x-mentra-service-timestamp` (Unix milliseconds)
  and `x-mentra-service-signature` (base64url), allowing 60 seconds of clock
  skew. Configure the same `MENTRA_SERVICE_AUTH_SECRET` on both services.
  Existing installations retain the `WORKOS_API_KEY` fallback during cutover.
- Public SDK/CLI contracts remain in this repo. Publish signed Store releases;
  local and bundled unsigned archives remain supported. Once a publisher is
  pinned, the host enforces continuity. Automatic updates defer while a miniapp
  runs; the host displays progress and blocks opens during an accepted update.

## Local development

`bun run dev` starts Core, Runtime and the test OEM without Store source.
For Store work, start the private backend separately on port 3003 and Console
on 5173. Configure `MENTRA_STORE_INTERNAL_URL=http://127.0.0.1:3003` in Core,
`MENTRA_CORE_INTERNAL_URL=http://127.0.0.1:3000` and
`MENTRA_STORE_CORE_JWKS_URL=http://127.0.0.1:3000/.well-known/jwks.json` in Store,
and the same service secret. Core admin remains on 5174 and uses `CORE_URL`.

## Bundled Store artifact

The Store ZIP is checked into `mobile/assets/miniapps`; public CI needs neither
private source nor credentials. With a private checkout available, run
`bun scripts/sync-miniapp.mjs --repo /path/to/miniapp-store --bump patch`.
Review and commit the private source/version and the public ZIP/catalog together.
The private repository pins its public SDK dependencies to immutable package
snapshots with a source SHA and checksums, until suitable npm releases exist.

## Deployment ownership

Core and Runtime remain in the coordinated Cloud V2 release. Store deploys
separately, retaining the existing Store domains, API routes, Mongo collections
and storage keys. Core's Porter definitions explicitly configure Store's URL;
they do not rely on the old same-app `http://store:3003` DNS alias.

Before deploying this extraction, complete the private repository's
`docs/cutover.md`: create its environment groups/secrets, validate the private
Store on temporary domains, transfer the existing Store domains, then remove
the old Store service through the public deployment. Do not let the first
public deployment remove the old service before the private replacement is ready.
Console deploys from the private repository to the existing Console Pages projects.
Core admin keeps its existing domain, login, report deep links and incident APIs;
Store staff use `/admin` on the Developer Console.
