# 007 Runtime auth independence

**Status:** Draft.

## One-line problem

Mentra Runtime Services are meant to be self-hostable, but the current
cloud-client auth lifecycle still assumes Cloud Core is available to exchange and
refresh access tokens. Runtime itself does not import Core or call Core on
each request, but a phone cannot stay connected forever without a Core-backed
credential lifecycle.

## What "make `endpoints.core` and `cloud.core` optional" means

Today `new CloudClient(...)` always requires:

```ts
endpoints: {
  core: string
  runtime: string
}
```

and always exposes:

```ts
cloud.core
```

That makes sense for Mentra-managed deployments, where the same SDK talks to both
Cloud Core and Cloud Runtime. It is too strict for runtime-only deployments.

Making them optional means:

- a host that only wants Runtime can construct the cloud-client with only a
  runtime endpoint;
- `cloud.runtime` can authenticate with a runtime token that does not require
  Core exchange/refresh;
- `cloud.core` is absent, disabled, or throws a clear "Core not configured"
  error in that mode;
- Mentra-managed deployments still configure Core exactly as they do today.

It does **not** mean Mentra gives up ownership of Core services. Core remains the
Mentra-owned product surface for accounts, store/catalog, installs, user mapping,
miniapp-token minting, console/store/oem portal, and other non-live-service APIs.

## Current state

Runtime authentication currently works like this:

1. Cloud-client obtains a Core-backed access token from Core via
   `/api/client/auth/exchange`.
2. Cloud-client refreshes through Core via `/api/client/auth/refresh`.
3. Runtime WebSocket/REST receives that access token.
4. Runtime verifies the token locally with `@mentra/cloud-shared`
   `verifyAccessTokenSignature`.

Runtime is already request-independent from Core: it does not ask Core to
authorize each WebSocket, UDP, camera, or audio request. The remaining coupling is
the token issuer/refresh path and the fixed token audience/issuer assumptions.

## Goals

- Allow Runtime Services to operate with zero live dependency on Cloud Core.
- Let Mentra-managed deployments continue using Cloud Core/Auth as the default
  broker and issuer.
- Let OEMs choose between:
  - using Mentra Core directly;
  - proxying Mentra Core;
  - using their own runtime-token issuer/JWKS;
  - running runtime-only with no Core endpoint at all.
- Keep runtime request authorization local and fast: JWT signature + claims, no
  per-request auth service call.
- Support issuer/JWKS rotation from day one.
- Keep the cloud-client usable in React Native and Node/Bun test harnesses.

## Non-goals

- Replacing Mentra Core product APIs.
- Requiring OEMs to self-host Core.
- Making runtime-only deployments automatically support Mentra Store/catalog,
  installs, or Core-backed miniapp-token minting.
- Designing the full developer-backend miniapp auth replacement here. That may
  become a follow-up once runtime-token issuance is split.

## Proposed token split

Separate the live-service token from the Core/product token. Avoid brand names in
audiences so the protocol survives a product/company rename.

### Core token

- Audience: `cloud-core`.
- Issuer: Cloud Core/Auth, or an OEM proxy that delegates to Cloud Core/Auth.
- Used for Core-owned APIs: account/session product APIs, catalog/install,
  miniapp-token minting, and future Core services.

### Runtime token

- Audience: `cloud-runtime`.
- Issuer: any configured runtime issuer:
  - Cloud Core/Auth;
  - OEM auth service;
  - OEM proxy to Mentra;
  - local/dev issuer.
- Used only for Runtime Services: WebSocket session, subscriptions, audio,
  camera, stream, and related live-service REST.

The same JWKS can sign both token families in Mentra-managed deployments, but
the design must not require that. Runtime should trust configured issuers, not a
hard-coded "Core exists" assumption.

## Deployment modes

### Hosted Core + hosted Runtime

This is the default Mentra-managed path. An OEM onboards through the portal with:

- a unique `tenantId`;
- production issuer metadata (`issuer`, JWKS or well-known URL);
- optional sandbox/staging issuer metadata for development environments.

Core/Auth verifies the OEM's subject token using that onboarded metadata, maps
`(tenantId, tenantUserId)`, then mints normalized `cloud-runtime` tokens for the hosted
Runtime. Hosted Runtime only has to trust the normalized Cloud Runtime issuer.

Mentra's own mobile app is treated as one OEM integration. During migration, its
login credential can still be the v1 core token obtained from the legacy backend;
Core/Auth uses that credential to issue the same normalized runtime token shape.

### Hosted Runtime via OEM proxy

An OEM may hide Mentra endpoints behind its own backend. The proxy can either
delegate token exchange to Cloud Core/Auth or return a Cloud Runtime token minted
by an issuer our hosted Runtime is configured to trust. Runtime still sees a
normal `cloud-runtime` JWT and does local verification.

### OEM-hosted Runtime

The OEM runs the Cloud Runtime service itself, typically from our Docker image
with environment config. Their runtime can trust their own issuer/JWKS directly
and does not need a Cloud Core endpoint for live services. They may still use
Cloud Core separately for store/catalog/account product APIs if desired.

### Local/dev Runtime

Local test harnesses can use a dev issuer and JWKS/static key without starting
Core, as long as the client supplies a valid `cloud-runtime` token.

## Runtime verifier config

Runtime should verify JWTs from a configured issuer list:

```ts
runtimeAuth: {
  audience: "cloud-runtime",
  issuers: [
    {
      issuer: "https://auth.example.com",
      jwksUrl: "https://auth.example.com/.well-known/jwks.json",
      userIdClaim: "sub",
      oemIdClaim: "tenant_id"
    },
    {
      issuer: "https://sandbox-auth.example.com",
      jwksUrl: "https://sandbox-auth.example.com/.well-known/jwks.json",
      userIdClaim: "sub",
      fixedOemId: "acme"
    }
  ]
}
```

The two issuer entries above are examples of two mapping modes, not two required
entries:

- `oemIdClaim` means the token carries the OEM id in a claim such as `tenant_id`.
- `fixedOemId` means this issuer is dedicated to one OEM, so Runtime gets the OEM
  id from config.

Every configured issuer must provide exactly one way to derive `tenantId`. `sub` is
the JWT-standard "subject" claim and should be the default user id claim, but the
claim name is configurable for OEM compatibility. Runtime normalizes the result
internally to a stable runtime user id plus `tenantId`.

Open claim-shape question: should runtime continue requiring
`session_id` and `jti`, or should those become optional/issuer-specific claims?
Runtime needs a stable per-user identity and enough session identity for logging
and correlation; it should not need Core's refresh-token session model.

## Cloud-client construction modes

Current config requires a Core URL and Core-backed `Auth`.

Target construction should support at least two modes:

```ts
type CloudClientConfig =
  | {
      endpoints: { core: string; runtime: string; proxy?: string }
      auth: CoreBackedAuthConfig
      transports: CloudClientTransports
    }
  | {
      endpoints: { runtime: string; proxy?: string }
      auth: RuntimeOnlyAuthConfig
      transports: CloudClientTransports
    }
```

Runtime-only auth can be as simple as:

```ts
type RuntimeOnlyAuthConfig = {
  runtime: {
    getToken: () => Promise<string>
    identity?: () => Promise<{ userId: string; tenantId?: string }>
  }
}
```

In a split-auth future, Core and Runtime may each have their own token provider:

```ts
auth: {
  core?: CoreAuthConfig
  runtime: RuntimeAuthConfig
}
```

In hosted-Core mode, the runtime token provider may call Core/Auth under the
hood. In runtime-only mode, it may call an OEM auth backend, read an already
issued token, or use a local/dev issuer. `cloud.runtime` should not know which.

Core owns client identity. Runtime-only tokens still carry identity claims for
Runtime authorization and logging, but the cloud-client does not expose those as
`cloud.auth.identity`. Miniapp token minting and miniapp auto-auth are Core-backed
features; a runtime-only deployment that needs an equivalent must provide its own
OEM-specific backend auth story.

## `cloud.core` behavior in runtime-only mode

Decision: `cloud.core` exists only when Core is configured. The constructor
accepts runtime-only clients, but any Core-auth configuration requires
`endpoints.core`; Core/Auth calls are never routed to Runtime as a fallback.
Avoid silently keeping a required dummy `core` endpoint because that recreates the
current coupling.

## Miniapp auth impact

Today miniapp-scoped tokens are minted by Core. No Core means no Mentra-managed
miniapp backend auth. If an OEM wants a runtime-only miniapp backend auth story,
that should be a separate OEM-specific design and should not block runtime auth
independence for live captions/audio/camera.

## Implementation plan

1. Add a runtime token verifier abstraction in `@mentra/cloud-runtime`.
   - Support JWKS URL(s), issuer, audience, and claim mapping.
   - Require explicit issuer config at runtime startup.
2. Introduce runtime-token audience `cloud-runtime`.
   - Runtime must not accept Core/product tokens as a fallback.
3. Split cloud-client auth providers.
   - Runtime module asks for runtime tokens.
   - Core module asks for Core tokens.
   - Hosted Core mode uses an explicit Core broker provider that calls
     `/api/client/auth/runtime-token`.
4. Make Core endpoint optional in runtime-only construction.
5. Decide and implement `cloud.core` runtime-only behavior.
6. Update docs for four deployment modes:
   - Cloud Core/Auth + hosted Cloud Runtime.
   - Cloud Core/Auth through OEM proxy + OEM-hosted Runtime.
   - OEM runtime auth issuer + no Core for live services.
   - local/dev runtime-only.
7. Add tests and E2E harness cases.

## Test plan

- Unit: runtime verifier accepts configured issuer/JWKS/audience and rejects
  wrong issuer, audience, expiry, and missing required identity claim.
- Unit: cloud-client can construct runtime-only with no `endpoints.core`.
- Unit: `cloud.runtime.connect()` uses the runtime token provider only.
- Unit: Core-backed mode remains backward compatible.
- Integration: runtime accepts a token from a local test JWKS with Core not
  running.
- E2E: local captions can connect to local runtime while Core service is stopped,
  as long as the host supplies a valid runtime token.
- E2E: Mentra-managed path still exchanges/refreshes via Core and connects to
  Runtime.

## Open decisions

- Is `cloud.core` absent, disabled, or split into a separate client?
- Does runtime require `session_id` and `jti`, or only stable user identity plus
  optional session correlation?
- Do runtime tokens use `sub = mentraUserId`, OEM user ID, or an issuer-mapped
  stable runtime user ID?
- Should Cloud Core/Auth mint runtime tokens as a distinct audience/token type,
  or should the current access token evolve into a multi-audience token during
  migration?
- What is the minimum miniapp-backend auth story for runtime-only deployments?

## Related

- [`../001-cloud-core/auth/`](../001-cloud-core/auth/): current Core-backed token
  exchange, refresh, miniapp-token mint, and JWKS.
- [`../002-cloud-runtime/`](../002-cloud-runtime/): Runtime Services architecture
  and protocol.
- [`../004-cloud-client/`](../004-cloud-client/): current client construction,
  auth, runtime, and core modules.
- [`../003-cloud-proxy/`](../003-cloud-proxy/): optional OEM proxy story.
