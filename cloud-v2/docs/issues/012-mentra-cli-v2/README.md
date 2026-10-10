# 012 - Mentra CLI v2

**Status:** Draft.

## Problem

The legacy `@mentra/cli` belongs to the old cloud and old app-server model. The
new miniapp platform needs a single developer CLI that can run local miniapps,
build bundles, sign artifacts, publish to Cloud Core, and support CLI login.

The existing `@mentra/miniapp-cli` has useful dev/build/pack primitives, but the
public developer entrypoint should become `@mentra/cli` with the `mentra` binary.

## Goals

- Publish a new major version of `@mentra/cli` for cloud-v2.
- Keep day-to-day commands short and context-aware.
- Store CLI login credentials and developer signing keys securely.
- Reuse miniapp build/pack/manifest logic instead of duplicating it.
- Run local development builds without login; the phone treats a dev build of a
  package as that package and applies the installed signer rule
  ([016](../016-miniapp-signing-and-dev-attestation/)).
- Support release provenance by signing bundle manifests.

## Non-goals

- Do not preserve legacy v1 CLI command compatibility in the cloud-v2 CLI.
- Do not make CLI publish bypass Console2/Admin review policy.
- Do not expose Cloud Core access tokens to miniapp JavaScript.

## Package Shape

```txt
@mentra/cli
  bin: mentra
  version: 2.x

@mentra/miniapp-cli or @mentra/miniapp-tools
  reusable build, pack, manifest, schema, dev-server helpers
```

`@mentra/miniapp-cli` stays usable as a standalone CLI. It owns per-package
publisher keys and opt-in bundle signing (`pack --sign`, `keys ...`; see
[016](../016-miniapp-signing-and-dev-attestation/)). `@mentra/cli` calls it
through its programmatic API instead of shelling out or passing private signing
keys through environment variables.

The public docs should prefer Bun scripts:

```json
{
  "scripts": {
    "dev": "mentra dev",
    "build": "mentra build",
    "pack": "mentra pack",
    "publish": "mentra publish"
  },
  "devDependencies": {
    "@mentra/cli": "^2.0.0"
  }
}
```

Publish safety: packages that are still in beta/preview must set
`publishConfig.tag = "alpha"` so `npm publish` and compatible publish tooling do
not accidentally move the public `latest` dist-tag.

## Commands

```txt
mentra login
mentra whoami
mentra miniapps list
mentra miniapps create <packageName> --name <displayName>
mentra miniapps delete <packageName>
mentra releases list <packageName>
mentra dev
mentra build
mentra pack
mentra publish
mentra logout
```

Context-aware commands inspect the current directory. If `miniapp.json` is
present, `mentra publish` publishes that miniapp. Outside a miniapp folder, a
future explicit form can be supported:

```txt
mentra miniapp publish ./path/to/miniapp
```

### `mentra dev`

- Starts the local miniapp dev server through the `@mentra/miniapp-cli` dev API.
- Prints QR/deep link for the phone. The QR carries no credential.
- Needs no login and makes no backend call. The phone runs the build under its
  manifest package name, refuses it while that package is installed with a
  publisher signature, and `session.auth.getToken()` works as it does for the
  installed miniapp.

### `mentra build`

- Builds production web assets into `dist/`.
- Does not zip or publish.

### `mentra pack`

- Validates `miniapp.json`.
- Runs production build unless `--no-build` is passed.
- Copies manifest/icon/assets into `dist/`.
- Writes `build/<packageName>-<version>.zip`.
- Computes `bundleSha256` and `manifestSha256`.

### `mentra publish`

- Runs `pack`.
- Ensures the package is claimed by the current developer org.
- Signs publish metadata with the local developer signing key.
- Uploads the release bundle zip to Cloud Core.
- Creates a `MiniAppRelease` row with bundle hash, size, and storage metadata.

The first implemented path posts the bundle zip as base64 to Core. This is good
enough for local/dev E2E and keeps the storage service/model honest. The next
iteration should use presigned upload URLs for larger bundles:

```txt
POST upload-intent -> PUT bundle.zip -> POST finalize
```

### Local E2E Against Dev-Like Auth

The safest way to test CLI auth and signing changes before deploying to shared
dev is:

1. Run Core/Runtime locally from the branch under test.
2. Use Doppler dev WorkOS settings so local Core verifies the same WorkOS-issued
   CLI tokens as the hosted dev environment.
3. Keep Mongo/R2 isolated unless explicitly doing a shared-dev data migration
   test.

That gives local code the same auth shape as dev without mutating the shared dev
database or interrupting teammates. Pointing local Core at shared dev Mongo can
be useful for one-off reproduction, but it should be treated as a risky
break-glass technique because local code can mutate shared records.

Do not use `cloud-debug` for this flow when another developer is relying on it.

### `mentra miniapps`

Package identity commands.

```txt
mentra miniapps list
mentra miniapps create com.mentra.myapp --name "My App"
mentra miniapps delete com.mentra.myapp
```

`miniapps create` reserves package identity. It does not create a review
submission and does not publish bytes. Core rejects package names outside the
developer org package prefix.

### `mentra releases`

Release inspection commands.

```txt
mentra releases list com.mentra.myapp
```

Release lifecycle state belongs to `MiniAppRelease`, not `MiniApp`, so old and
new versions can coexist with different review states.

## Current Release Bundle Format

`mentra publish` uses the local miniapp packer contract:

```txt
build/<packageName>-<version>.zip
```

This is the installable bundle the phone downloads and unzips. The zip root must
contain `miniapp.json`. Two-layer miniapps also include files such as
`background/index.js`, `ui/index.html`, UI chunks/assets, and `icon.png`.

Use "release bundle" for the zip. Use "background JS bundle" only for the
internal background file inside the zip.

## Auth and Signing

CLI login and artifact signing are separate.

### CLI Login Credential

Used to authorize Cloud Core API calls.

```txt
mentra login -> browser AuthKit/Console2 flow -> CLI stores credential in Keychain
```

### Developer Signing Key

Generated locally and registered with Cloud Core.

```ts
interface DeveloperSigningKey {
  id: string
  developerOrgId: string
  workosUserId: string
  publicKeyJwk: JsonWebKey
  status: "active" | "revoked"
  createdAt: string
  lastUsedAt?: string
}
```

The private key stays on the developer machine, ideally in Keychain.

### Bundle Signature

```ts
interface BundleSignaturePayload {
  packageName: string
  version: string
  bundleSha256: string
  manifestSha256: string
  createdAt: string
}
```

Cloud Core verifies the signature and stores the signing key id on the bundle.

## User Stories

1. A new developer runs `bunx @mentra/cli login` and authorizes in the browser.
2. A developer runs `bun run dev` and scans a QR code.
3. Local Merge calls `session.auth.getToken()` in dev mode; Core mints the same
   audience-scoped miniapp token it mints for the installed package.
4. A developer runs `bun run publish`; a signed bundle appears in Console2.
5. A teammate can verify who signed and uploaded a bundle.
6. A revoked developer signing key can no longer publish.

## Faults To Test

| Fault | Expected behavior |
| --- | --- |
| Not logged in | `publish` fails with login prompt; `dev` works without auth token |
| Signing key missing | CLI creates/registers one after login |
| Signing key revoked | Publish rejected; CLI prompts to create new key |
| Package not claimed | Publish rejected by Core |
| Dev build of a signed installed package | Phone refuses it and asks the user to uninstall first |
| Upload interrupted | Bundle remains unfinalized and can be retried |
| Hash mismatch after upload | Finalize rejected |
| Duplicate version | Core rejects the release; developer bumps `miniapp.json` version |

## Open Decisions

- Presigned upload route shape and retry/resume semantics.
