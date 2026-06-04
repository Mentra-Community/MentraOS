# Cloud Core Auth: design

**Status:** Design proposal. The end-to-end implementation plan for the v2 auth
system across oem-auth, identity, the cloud-client auth module, and miniapp
auto-auth. The wire contract (endpoints, token shapes, JWKS) is in
[`spec.md`](./spec.md); this doc is how it is built across the codebase, so the
full set of code changes can be understood from spec + design alone.

## End to end, in one pass

1. A user signs in. For an OEM user the OEM's backend mints a short-lived subject
   JWT; for a Mentra user the subject is the existing core token (transition) or a
   Supabase session (end state).
2. The **cloud-client** exchanges the subject token at
   `POST /api/client/auth/exchange` for a Mentra **access token** (+ refresh), and
   owns refresh from there. The access token carries `sub = mentraUserId`, `oemId`.
3. For each running miniapp, the cloud-client mints a **miniapp-scoped token**
   (`POST /api/client/auth/miniapp-token`, `aud = <packageName>`), caches it, and
   refreshes before expiry.
4. The on-device runtime injects the miniapp token into the bundle (webview +
   Crust engine). The raw access token never reaches a bundle.
5. The bundle calls its developer backend with the miniapp token. The backend
   verifies it against Mentra's **JWKS**, checks `aud`, and applies its `oemId`
   trust policy. No per-request call to Mentra.

Identity throughout is `mentraUserId` (the `users._id`) + `oemId`.

## Components and the code changes

### 1. Cloud Core (`packages/core`)

- **Exchange** `POST /api/client/auth/exchange` (RFC 8693). Add the reserved
  internal **`mentra` OEM** issuer: route on `subject_token_type` and verify the
  Mentra subject tokens with the shared secrets (`AUGMENTOS_AUTH_JWT_SECRET` for
  the core token, `SUPABASE_JWT_SECRET` for a Supabase session), versus the
  OEM-JWT path which verifies against the OEM's registered key. Map
  `(oemId, oemUserId)` to the user record. Path moves from the implemented
  `/api/oem/oauth/token` to `/api/client/auth/exchange` (the client is the caller).
- **Refresh** `POST /api/client/auth/refresh` (rotating refresh token).
- **Miniapp-token mint** `POST /api/client/auth/miniapp-token`: verify the access
  token, mint an Ed25519 JWT with `aud = packageName`, configurable TTL. No
  install check.
- **JWKS** `GET /.well-known/jwks.json`: publish both public keys with `kid`.
- **Two Ed25519 signing keys** (access-token key, miniapp-token key) in config.
- **`user.service.ts`:** `mentraUserId` is the `users._id` (drop the
  `mu_${ulid()}` mint and the separate `mentraUserId` field/index).

### 2. Cloud-client auth module (`@mentra/cloud-client`, `cloud.auth`)

- Construct with a subject token (or a `getSubjectToken()` callback). On first use
  call `/exchange`; own refresh via `/refresh`.
- `getMiniappToken(packageName)`: call the mint endpoint, cache per package,
  re-mint before expiry.
- Expose `identity { mentraUserId, oemId }` (decoded from the access token).
- Never expose the access token to a bundle.

### 3. On-device runtime (the bundle host)

- The miniapp connect handshake returns `mentraUserId` + the initial miniapp
  token (from `cloud.auth.getMiniappToken`).
- Inject the miniapp token into the bundle's two JS contexts (webview + Crust),
  and refresh/re-inject before expiry. Mechanism in
  [`auto-auth/injection.md`](./auto-auth/injection.md).
- The cloud-client is wired in through the runtime transport adapter
  ([`../../004-cloud-client/island-adapter.md`](../../004-cloud-client/island-adapter.md)).

### 4. Developer SDK and backend verifier

- The frontend SDK (`@mentra/react` `useMentraAuth()`, and the local SDK in the
  Crust context) reads `{ mentraUserId, token }` from the bridge on device, or from
  the "Sign in with Mentra" OAuth redirect on the web.
- The backend verifier (replacing the v1 `createMentraAuthRoutes` temp-token
  exchange): fetch the JWKS, verify the signature and `aud == packageName`, apply
  the `oemId` trust policy. No per-request call to Mentra, no API-key hash.

## v1 to v2 coexistence

- During transition the client holds **both** tokens: the core token for the v1
  path (unchanged), and the access token (exchanged from it) for the v2 path. The
  exchange bridges core token to access token; retire the bridge when v2 is primary
  by swapping the subject token to a Supabase session (same endpoint).
- The v1 webview auth path (temp token, `frontendToken`, the API-key hash) is
  replaced by the asymmetric JWKS flow above; it stays until v1 is retired.

## Implementation order

1. Cloud Core: the `_id` change, the exchange (Mentra-as-OEM), the mint endpoint,
   JWKS, the two signing keys.
2. Cloud-client `auth` module (exchange, refresh, `getMiniappToken`).
3. On-device injection + the runtime transport wiring.
4. Developer SDK verifier + `useMentraAuth`.

## References

- [`spec.md`](./spec.md): the endpoint and token contract.
- [`identity/spike.md`](./identity/spike.md): the identity model and the migration
  bridge.
- [`auto-auth/spike.md`](./auto-auth/spike.md) and
  [`auto-auth/injection.md`](./auto-auth/injection.md): the miniapp flow and the
  on-device injection.
- [`oem-auth/design.md`](./oem-auth/design.md): the OEM-JWT verification and replay
  protection.
