# 007 Runtime auth independence

**Status:** Draft.

## One-line problem

Mentra Runtime Services are meant to be self-hostable, but the current
cloud-client auth lifecycle still assumes Cloud Core is available to exchange and
refresh Mentra access tokens. Runtime itself does not import Core or call Core on
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
Mentra Core and Mentra Runtime. It is too strict for runtime-only deployments.

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

1. Cloud-client obtains a Mentra access token from Core via
   `/api/client/auth/exchange`.
2. Cloud-client refreshes through Core via `/api/client/auth/refresh`.
3. Runtime WebSocket/REST receives the access token.
4. Runtime verifies the token locally with `@mentra/cloud-shared`
   `verifyAccessTokenSignature`.

Runtime is already request-independent from Core: it does not ask Core to
authorize each WebSocket, UDP, camera, or audio request. The remaining coupling is
the token issuer/refresh path and the fixed token audience/issuer assumptions.

## Goals

- Allow Runtime Services to operate with zero live dependency on Cloud Core.
- Let Mentra-managed deployments continue using Mentra Core as the default issuer.
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

Separate the live-service token from the Core/product token.

### Core token

- Audience: `mentra-core`.
- Issuer: Mentra Core, or an OEM proxy that delegates to Mentra Core.
- Used for Core-owned APIs: account/session product APIs, catalog/install,
  miniapp-token minting, and future Core services.

### Runtime token

- Audience: `mentra-runtime`.
- Issuer: any configured runtime issuer:
  - Mentra Core/Auth;
  - OEM auth service;
  - OEM proxy to Mentra;
  - local/dev issuer.
- Used only for Runtime Services: WebSocket session, subscriptions, audio,
  camera, stream, and related live-service REST.

The same JWKS can sign both token families in Mentra-managed deployments, but
the design must not require that. Runtime should trust configured issuers, not a
hard-coded "Core exists" assumption.

## Runtime verifier config

Runtime should verify JWTs from a configured issuer list:

```ts
runtimeAuth: {
  audience: "mentra-runtime",
  issuers: [
    {
      issuer: "https://core.mentra.glass",
      jwksUrl: "https://core.mentra.glass/.well-known/jwks.json",
      userIdClaim: "sub",
      oemIdClaim: "oem_id"
    },
    {
      issuer: "https://auth.oem.example",
      jwksUrl: "https://auth.oem.example/.well-known/jwks.json",
      userIdClaim: "sub",
      fixedOemId: "oem_example"
    }
  ]
}
```

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
    identity?: () => Promise<{ userId: string; oemId?: string }>
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

## `cloud.core` behavior in runtime-only mode

Options:

1. **Absent property:** `cloud.core` exists only when Core is configured.
   - Strong type signal.
   - More TypeScript API churn.
2. **Disabled module:** `cloud.core` always exists but methods throw
   `CoreNotConfiguredError`.
   - Less API churn.
   - Runtime-only hosts can fail later if they accidentally call Core.
3. **Separate clients:** `new RuntimeClient(...)` and `new CloudClient(...)`.
   - Cleanest conceptual split.
   - More package/API surface.

Recommendation for spike: evaluate Option 1 vs Option 3. Avoid silently keeping
a required dummy `core` endpoint because that recreates the current coupling.

## Miniapp auth impact

Today miniapp-scoped tokens are minted by Core. Runtime-only deployments need an
explicit answer:

- no Core means no Mentra-managed miniapp backend auth; or
- the host provides `miniappTokenProvider(packageName)`; or
- runtime issues runtime-scoped miniapp tokens from its own configured issuer.

This should be a follow-up design decision. It should not block runtime auth
independence for live captions/audio/camera.

## Implementation plan

1. Add a runtime token verifier abstraction in `@mentra/cloud-runtime`.
   - Support JWKS URL(s), issuer, audience, and claim mapping.
   - Preserve current env-key verifier as the Mentra-managed default or local dev
     shortcut.
2. Introduce runtime-token audience `mentra-runtime`.
   - Keep compatibility with existing `mentra-cloud` access tokens during the
     migration window if needed.
3. Split cloud-client auth providers.
   - Runtime module asks for runtime tokens.
   - Core module asks for Core tokens.
   - Existing Core-backed mode wires both to the current `cloud.auth`.
4. Make Core endpoint optional in runtime-only construction.
5. Decide and implement `cloud.core` runtime-only behavior.
6. Update docs for four deployment modes:
   - Mentra-managed Core + Mentra-managed Runtime.
   - Mentra Core through OEM proxy + OEM Runtime.
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
- Should Mentra Core mint runtime tokens as a distinct audience/token type, or
  should the current access token evolve into a multi-audience token during
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
