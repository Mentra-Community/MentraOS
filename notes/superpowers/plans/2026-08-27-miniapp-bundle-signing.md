---
status: draft
owner: Mentra
---

# Mentra miniapp bundle signing implementation plan

> Execution plan for making publisher identity part of every production miniapp
> bundle before Store installation is enabled.

**Goal:** Every production miniapp ZIP is self-contained and developer-signed.
Core rejects releases whose signer does not match the package's established
publisher, and the Mentra App independently verifies and pins that publisher
identity before installation or update. There is no unsigned compatibility
path for Store releases created before launch.

**Architecture:** `pack` creates the final signed ZIP. `publish` uploads that
exact artifact without re-signing it. The ZIP contains an Ed25519 public key,
canonical signed content statement, and signature in a reserved metadata
entry. Core and the Mentra App run equivalent verification. Core performs an
early publication check; the Mentra App remains the final installation
authority. Core does not sign miniapps or Store installation descriptors in
this version.

**Spec source of truth:**
`notes/superpowers/specs/2026-08-26-mentra-miniapp-store-restoration-design.md`

---

## Decisions

- The developer owns and protects the package signing private key.
- Core receives only the public key and the already-signed ZIP.
- The signing identity is embedded in the ZIP, not transported as a detached
  Store response field.
- `mentra pack` and `mentra-miniapp pack` both produce the same final signed
  artifact. `publish` never introduces a second signing implementation.
- The Store passes the final ZIP URL and transport SHA-256 to the host. The
  host obtains publisher identity from the ZIP itself.
- A package's first accepted production release establishes its publisher key
  fingerprint in Core.
- A package's first installation establishes its publisher key fingerprint on
  that Mentra App, except that build-owned SYSTEM packages additionally pin the
  expected fingerprint in the generated bundled catalog.
- Every later release or update must use the same publisher key. Key rotation
  is not accepted in v1, but the signature schema reserves a versioned signer
  lineage so rotation can be added without grandfathering unsigned installs.
- The existing Store provenance rule remains independent: the publisher key
  identifies who produced the miniapp, while `storeOwnerPackageName`
  identifies which trusted Store manages the installation.
- Core-signed `storeAuthorization` is out of scope. A build-trusted SYSTEM
  Store is a trusted installer. If backend-issued installation capabilities
  become necessary later, they can be layered on top without changing the
  publisher identity.

## Signed ZIP format

The final ZIP contains exactly one reserved signing entry:

```text
miniapp.json
build/...
assets/...
META-INF/MENTRA.SIG
```

`META-INF/MENTRA.SIG` is UTF-8 canonical JSON with this conceptual shape:

```ts
interface MentraBundleSignatureV1 {
  schemaVersion: 1;
  algorithm: "Ed25519";
  publicKeyJwk: {
    kty: "OKP";
    crv: "Ed25519";
    x: string;
  };
  publisherKeyFingerprint: string;
  payload: {
    packageName: string;
    version: string;
    manifestSha256: string;
    contentSha256: string;
  };
  signature: string;
  signerLineage?: unknown;
}
```

The verifier derives `publisherKeyFingerprint` from `publicKeyJwk`; it never
trusts the serialized fingerprint by itself.

`contentSha256` is calculated from a versioned canonical file index:

1. Validate and normalize every ZIP path.
2. Exclude directories and exactly one `META-INF/MENTRA.SIG` entry.
3. Reject duplicate, case-colliding, unsafe, symbolic-link, encrypted, or
   otherwise unsupported entries before hashing.
4. For each remaining file, record its normalized path, uncompressed byte
   length, and SHA-256.
5. Sort records lexicographically by normalized path.
6. Hash canonical JSON containing the schema version and sorted file records.

`miniapp.json` is therefore covered by the complete content digest.
`manifestSha256` additionally binds its parsed canonical JSON representation,
which Core and the host already use for release metadata and identity checks.

After inserting `META-INF/MENTRA.SIG`, `pack` computes the SHA-256 of the final
ZIP. That final hash is used for Store download integrity. It is not placed in
the embedded signed payload because doing so would create a circular hash.

Removing or changing the signature entry must make a production archive
uninstallable. Changing any other ZIP content must invalidate the embedded
signature.

## Key lifecycle and storage

The CLI already stores authentication in the OS keychain, falling back to
mode-`0600` files under `~/.mentra/cli-v2`. Publisher keys should reuse that
storage policy but be package-scoped rather than Core-URL-scoped so the same
package identity works across official, OEM, and self-hosted Stores.

Proposed commands:

```text
mentra miniapps keys create --package com.example.app
mentra miniapps keys show --package com.example.app
mentra miniapps keys export --package com.example.app --out ./publisher-key.json
mentra miniapps keys import --package com.example.app ./publisher-key.json
```

Required behavior:

- `create` is explicit and prints backup/CI guidance.
- The private key is stored in the OS keychain when available.
- File fallback lives beneath `~/.mentra/cli-v2/signing-keys/` with mode
  `0600`; the CLI never places it in the miniapp project automatically.
- Export requires an explicit path and warning. The exported secret file is
  written with mode `0600`.
- Import verifies the public/private key pair and refuses to overwrite a
  different key without an explicit destructive confirmation.
- CI supports an explicit key file or secret environment input without writing
  the key into source control.
- Missing keys cause `pack` to fail with the exact create/import command.
- The CLI never silently generates a replacement key for an established
  package.
- Logout removes authentication but does not delete publisher signing keys.

## Command behavior

### `mentra pack` and `mentra-miniapp pack`

Both commands must call one shared packing/signing implementation in
`@mentra/miniapp-cli`:

1. Build unless `--no-build` was supplied.
2. Read and validate the canonical `miniapp.json`.
3. Resolve the package signing key from explicit CLI/CI input or package key
   storage.
4. Build the canonical content index.
5. Sign the canonical payload with Ed25519.
6. Insert `META-INF/MENTRA.SIG`.
7. Verify the completed archive using the same public verifier.
8. Write `build/<packageName>-<version>.zip` atomically.
9. Print the publisher fingerprint and final bundle SHA-256.

Production `pack` always signs. Development snapshots continue using the
existing short-lived development attestation flow rather than becoming
production releases. Any explicit unsigned archive helper must be limited to
unit-test fixtures and must not be accepted by Store, preinstall, bundled, or
semver release installation paths.

### `mentra publish`

`publish` performs or consumes `pack`, then:

1. Reads the final ZIP.
2. Verifies its embedded signature locally.
3. Confirms package and version match the project manifest.
4. Uploads the unchanged ZIP.

`--no-pack` means “upload this already-signed artifact,” not “sign during
upload.” An invalid, unsigned, or differently signed existing ZIP fails before
network access.

## Implementation checklist

### Shared bundle signing and verification

**Primary paths:** `sdk/miniapp-cli/src/`, plus a dependency-minimal verifier
module reusable by Core and the mobile host where practical.

- [ ] Define the versioned `META-INF/MENTRA.SIG` schema.
- [ ] Define canonical public-key fingerprinting and canonical JSON bytes.
- [ ] Define the canonical file-index/content-digest algorithm.
- [ ] Implement signing and completed-archive verification.
- [ ] Reject missing, duplicate, malformed, stripped, and unsupported
      signature entries.
- [ ] Add deterministic fixtures that all environments verify identically.

### CLI key management and packing

**Primary paths:** `cloud-v2/packages/cli/src/credentials.ts`,
`cloud-v2/packages/cli/src/signing.ts`, `cloud-v2/packages/cli/src/index.ts`,
and `sdk/miniapp-cli/src/pack.ts`.

- [ ] Replace automatic Core-scoped release-key generation with explicit
      package-key creation/import.
- [ ] Add show/create/import/export commands and CI inputs.
- [ ] Move package storage to package-scoped keychain entries with the secure
      `~/.mentra/cli-v2` fallback.
- [ ] Make the shared `pack` path embed and verify the signature.
- [ ] Make `publish` upload the exact signed ZIP without detached signing.
- [ ] Remove the old detached `signedBundle` upload behavior after all callers
      use the embedded format.

### Core package identity and upload verification

**Primary paths:** `cloud-v2/packages/core/src/services/miniapps/`, release and
package models, and Console/CLI release APIs.

- [ ] Parse and verify the embedded signature during every release upload.
- [ ] Store the derived publisher fingerprint and public key on the package
      identity, with release rows retaining the verified fingerprint for audit.
- [ ] Atomically bind the first accepted production signer to an unbound
      package.
- [ ] Reject every later release whose signer differs.
- [ ] Verify package, version, canonical manifest hash, and content digest
      against the actual uploaded archive.
- [ ] Surface the fingerprint and verification state in CLI and Developer
      Console release details.
- [ ] Remove detached signature metadata as an authority once the embedded
      format is mandatory.

### Store/catalog transport

**Primary paths:** `cloud-v2/packages/core/src/services/miniapps/store-catalog.service.ts`
and `miniapps/store/`.

- [ ] Continue publishing the final signed ZIP URL and final bundle SHA-256.
- [ ] Optionally expose the verified publisher fingerprint for UI/audit, while
      treating the ZIP as the host's authority.
- [ ] Do not send a loose public key or publisher signature as the install
      authority.
- [ ] Remove the unused v1 `storeAuthorization` contract from the required
      Store flow.

### Mentra App verification and continuity

**Primary paths:** `mobile/modules/engine/src/services/validateInstallBundle.ts`,
`AppRegistry.ts`, `LocalMiniappRuntime.ts`, and installed identity storage.

- [ ] Require and verify `META-INF/MENTRA.SIG` before activating any production
      semver bundle.
- [ ] Recompute the canonical content and manifest digests from the downloaded
      ZIP; never trust catalog metadata for publisher verification.
- [ ] Persist the derived publisher fingerprint in a package-level identity
      record independent of individual release garbage collection.
- [ ] Pin the fingerprint on first authorized install.
- [ ] Reject manual Store installs and automatic updates with a different
      signer before extraction or activation.
- [ ] Preserve the current Store-owner and SYSTEM-owner checks as separate
      authorization layers.
- [ ] Ensure rollback restores both the previous active release and publisher
      identity transactionally.
- [ ] Include safe fingerprint/signature status in diagnostics without
      exposing private material.

### Bundled SYSTEM miniapps

**Primary paths:** first-party miniapp packaging, `mobile/assets/miniapps/`, and
the generated bundled miniapp catalog.

- [ ] Create or import durable signing keys for every bundled package owner.
- [ ] Repack every bundled production ZIP with its publisher signature.
- [ ] Add the expected publisher fingerprint to each generated bundled catalog
      entry.
- [ ] Verify the embedded signer matches the build-pinned fingerprint during
      bundled synchronization.
- [ ] Require Store-delivered SYSTEM updates to match that same build-pinned
      publisher identity.
- [ ] Keep the Store package itself updateable only through a new Mentra App
      build for this release.

### Greenfield cutover

- [ ] Do not support unsigned Store releases or trust the signer of a later
      update as a migration mechanism.
- [ ] Repack/re-upload or delete any prerelease Store inventory created with
      detached signatures before enabling Store installations.
- [ ] Regenerate all bundled miniapp artifacts and build catalogs.
- [ ] Remove the signing feature from the Store spec's deferred list and make
      signed publisher continuity a launch gate.
- [ ] Keep the Store preview disabled until all production artifact sources use
      the signed format.

## Verification matrix

- [ ] Same package and same key: first install and update succeed.
- [ ] Same package and different key: Core upload fails.
- [ ] A forged catalog that changes the advertised fingerprint cannot bypass
      host verification.
- [ ] A trusted Store requesting a differently signed replacement fails.
- [ ] A valid signature over changed manifest or executable bytes fails.
- [ ] A stripped, duplicated, malformed, or case-colliding signature entry
      fails.
- [ ] Final ZIP transport-hash mismatch fails before signature admission.
- [ ] Signed release blocked by host/SDK/hardware compatibility remains
      uninstalled.
- [ ] Failed update preserves the running prior release and publisher identity.
- [ ] Automatic update applies a same-signer compatible release and defers all
      incompatible or mismatched-signer releases.
- [ ] Private, beta, public, and SYSTEM distributions use identical publisher
      verification.
- [ ] `pack` output can be installed without ever being uploaded to Core, when
      invoked through an explicitly authorized non-Store installation path.
- [ ] CLI key export/import produces the same publisher fingerprint on another
      machine and in CI.
- [ ] Core, CLI, and Mentra App verify the same golden signed ZIP fixtures.

## Explicitly later

- Old-key-authorized publisher key rotation and signer lineage acceptance.
- Lost-key recovery policy.
- Hardware-backed or managed signing services.
- Core/Store-backend-signed installation capabilities.
- Public certificate transparency or publisher identity directories.
