# 016 - Miniapp signing and dev attestation

**Status:** In progress.

## PRD

### Problem

Cloud V2 miniapp auto-auth gives miniapps a package-scoped backend token. That
token is powerful enough for a backend to trust the caller as a specific
miniapp, so package identity must not come from arbitrary local JavaScript.

The released-miniapp path has a registry and install record that names the
package. The dev path is different: all local dev miniapps run through one
runtime slot (`com.dev`) and the real package name comes from a QR/dev URL. A
developer could otherwise claim another package name in dev mode and ask Core to
mint a token for that package.

### Goals

1. Make `@mentra/cli` the public front door for `mentra dev`, `mentra pack`, and
   `mentra publish`.
2. Reuse the existing SDK-side `mentra-miniapp` dev/build/pack implementation
   while layering Cloud V2 identity on top.
3. Register developer signing keys with Core.
4. Sign release bundle metadata before upload.
5. Sign short-lived dev attestations for local dev URLs.
6. Require dev attestations before the mobile dev slot can request a miniapp
   auth token for a real package name.

### Non-goals

- Do not expose Core access tokens to miniapp JavaScript.
- Do not let `com.dev` become the auth audience.
- Do not require login for UI-only local dev miniapps that never call
  `session.auth`.

## User Stories

1. A developer runs `mentra dev` from a miniapp folder. The CLI starts the
   existing local dev server and includes a signed attestation in the QR.
2. A UI-only miniapp can still run locally without login, but
   `session.auth.getToken()` is unavailable.
3. A dev miniapp that claims a package outside the developer org prefix cannot
   get a miniapp backend token.
4. A developer runs `mentra publish`; Core verifies the signed bundle metadata
   before creating the release.
5. Admins and reviewers can later see which signing key created a release.

## Required Behavior

### Developer signing key

The CLI owns an Ed25519 private key per Core environment. The private key stays
local. Core stores only the public key and links it to the developer org/user.

```ts
interface DeveloperSigningKey {
  id: string
  developerOrgId: string
  workosUserId: string
  publicKeyJwk: JsonWebKey
  status: "active" | "revoked"
}
```

### Release signature

`mentra publish` signs deterministic metadata:

```ts
interface BundleSignaturePayload {
  packageName: string
  version: string
  bundleSha256: string
  manifestSha256: string
  createdAt: string
}
```

Core verifies:

- the signing key exists and is active,
- the signing key belongs to the developer org,
- the package belongs to the developer org prefix,
- the signature matches the payload,
- the uploaded bundle hash matches `bundleSha256`.

### Dev attestation

`mentra dev` signs a short-lived note after the dev URL is known:

```ts
interface DevMiniappAttestation {
  packageName: string
  devServerUrl: string
  nonce: string
  expiresAt: string
  signingKeyId: string
  signature: string
}
```

Mobile stores the attestation with the dev app record. When `com.dev` calls
`session.auth.getToken()`, mobile resolves the real source package and sends the
attestation to Core. Core verifies it before minting a token whose audience is
the real package.

### CLI package boundary

`@mentra/cli` is the trusted developer front door. It owns login credentials,
developer signing keys, release signatures, and dev attestations.

`@mentra/miniapp-cli` remains a useful lower-level SDK tool for local dev,
manifest helpers, production builds, and bundle packing. It must not know about
Core credentials or private signing keys. Instead, it exposes a programmatic API:

```ts
dev({
  cwd,
  signDevAttestation: ({ packageName, devServerUrl }) => string | Promise<string>
})

pack({ cwd, build: true })
buildProduction(cwd)
```

When a developer runs `mentra dev`, `@mentra/cli` registers or loads the local
developer signing key, calls the SDK dev API, and injects a signing callback. The
SDK dev server still chooses the reachable LAN URL and live-reload sidecar port,
then asks the callback to sign that final URL. Standalone
`mentra-miniapp dev` still works, but it produces an unsigned QR, so miniapp
auto-auth is unavailable.

This avoids passing private keys through process environment and keeps the API
boundary reviewable before the CLI is published as a beta.

`MENTRA_CLI_TOKEN` is an explicit automation/E2E override and should take
precedence over saved keychain credentials. This keeps CI/API-key flows from
accidentally using a stale interactive session.

### Expiry and refresh behavior

Dev attestations are short-lived. If one expires while the local miniapp is
running, the current background/UI code may continue to run, but the next
`session.auth.getToken()` mint or refresh fails until the developer rescans a
fresh `mentra dev` QR. The SDK must surface that as auth unavailable rather than
falling back to an untrusted package claim.

## Faults

| Fault | Expected behavior |
| --- | --- |
| Not logged in during `mentra dev` | Miniapp runs; backend auto-auth unavailable |
| Dev URL has no attestation | Dev slot cannot request miniapp auth |
| Attestation package differs from requested package | Core rejects token mint |
| Attestation expires mid-use | Next token mint/refresh fails; developer rescans fresh `mentra dev` QR |
| Signing key revoked | Core rejects publish and dev auth |
| Bundle modified after signing | Core rejects release upload |
| Package outside org prefix | Core rejects package creation/publish/dev auth |

## QA

- Unit/integration: create signing key, sign release metadata, verify accepted.
- Unit/integration: reject tampered release metadata.
- Unit/integration: mint miniapp token with valid dev attestation.
- Unit/integration: reject dev token request with expired/tampered attestation.
- E2E: `mentra dev` QR opens on phone, `session.auth.getToken()` works for the
  claimed package only.
- Local pre-deploy E2E: run local Core/Runtime with dev WorkOS configuration but
  isolated local Mongo/R2. This verifies the WorkOS bearer-token shape and
  signing endpoints without deploying branch code to shared dev or using
  `cloud-debug`.
