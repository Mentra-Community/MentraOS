---
status: active
owner: Mentra
---

# Mentra Miniapp Store restoration checklist

## Outcome

Restore the Mentra Miniapp Store as the bundled `com.mentra.store` miniapp for
Mentra 3.0. Cloud Core owns Mentra's catalog and publishing workflow, while the
Mentra Miniapp SDK and Mentra App host expose a backend-neutral installer that
OEM Store miniapps can also use.

The first release deliberately uses the approved MVP trust model: an exact,
build-owned SYSTEM package plus package, version, HTTPS bundle URL, and SHA-256.
The SDK request already reserves the signed authorization envelope so Store and
publisher signatures can be enforced later without changing the API.

## Architecture and trust boundary

- [x] Keep Mentra catalog, ownership, review, publication, listings, and bundle
      storage in Cloud Core rather than Cloud Runtime.
- [x] Implement `com.mentra.store` as a normal two-layer miniapp built with
      `@mentra/miniapp`.
- [x] Keep installation in the host; Store miniapps receive no filesystem or
      native unzip access.
- [x] Keep the installation request backend-neutral: package, version, URL,
      SHA-256, release metadata, and an optional future authorization envelope.
- [x] Make SYSTEM build-owned and non-author-declarable.
- [x] Require both an exact hardcoded package and host-bundled provenance. A dev
      miniapp copying `com.mentra.store` is not privileged.
- [x] Protect every bundled SYSTEM package from Store replacement or removal.
- [x] Record the installing Store as provenance and reject cross-Store updates
      and removals.
- [x] Allow an OEM build to add one or more bundled Store package names to the
      build-owned allowlist while reusing the same SDK/host contract and any
      backend.

## Canonical release bundles

- [x] Treat exactly one root `miniapp.json` as canonical package identity.
- [x] Bind submitted package, version, manifest, developer signature, and bundle
      SHA-256 to the ZIP contents.
- [x] Reject malformed ZIPs, CRC failures, nested/duplicate manifests, unsafe
      paths, symbolic links, missing entries, excessive entry counts, oversized
      manifests, oversized downloads, and decompression abuse.
- [x] Require lowercase reverse-DNS package names and semantic versions.
- [x] Verify expected package, expected version, and SHA-256 again in the phone
      before native extraction.
- [x] Stage and atomically activate an install, preserving the prior version on
      failure and cleaning downloaded archives.
- [x] Add malicious-bundle, manifest identity, signature, and hash tests.

## Cloud Core catalog and developer workflow

- [x] Add Store listing metadata separate from signed release manifests.
- [x] Support subtitle, long description, categories, privacy/support/website
      URLs, icon, cover, screenshots, featured state, and review tier.
- [x] Add authenticated listing read/update and artwork upload/delete endpoints.
- [x] Validate artwork media signatures, content types, sizes, ownership, and
      public-reference visibility.
- [x] Add public catalog browse, search, pagination, deterministic ordering,
      details, immutable bundle metadata, compatibility metadata, and assets.
- [x] Return only active apps whose active release is published.
- [x] Preserve the existing developer signing-key verification and admin
      accept/publish workflow.
- [x] Cover publish-to-catalog and artwork behavior with Mongo/storage-backed
      integration tests.

## Mentra CLI and Developer Console

- [x] Read the CLI version from its package metadata.
- [x] Build, pack, validate, sign, and upload canonical ZIPs.
- [x] Replace base64 release uploads with multipart bundles while retaining the
      legacy Core input for compatibility.
- [x] Add draft upload (`--no-submit`), JSON output, release list/status, review
      feedback, and explicit submission workflows.
- [x] Retain browser login and API-token-compatible noninteractive auth.
- [x] Ensure repeated packing cannot retain stale files from an older ZIP.
- [x] Add Developer Console listing fields and Store artwork management.
- [x] Display canonical manifest data, release history, review status/notes, and
      signing-key identity in the existing release detail workflow.
- [x] Build and typecheck the CLI and Developer Console.

## Mentra Miniapp Store

- [x] Add `miniapps/store` to the monorepo and bundled miniapp registry.
- [x] Reuse the Cloud V1 Store icon.
- [x] Implement a responsive light/dark UI based on the current Store Figma and
      existing Mentra Miniapp UI primitives.
- [x] Implement Discover, search, details, screenshots, links, Installed, and
      Updates views.
- [x] Implement Get, install progress, Open, Update, Uninstall, loading, empty,
      offline, incompatible, failure, retry, and delisted-installed states.
- [x] Add labels, focus styling, safe-area handling, and reduced motion.
- [x] Run the controller headlessly and refresh on startup, Store open,
      foreground, connectivity restoration, and a bounded background interval.
- [x] Coalesce refreshes and serialize host mutations to prevent races/loops.
- [x] Prevent downgrades by offering only strict semantic-version upgrades.
- [x] Package and integrity-check `com.mentra.store-1.0.0.zip`.

## Verification

- [x] Cloud typecheck.
- [x] Developer Console production build.
- [x] Cloud Store/CLI bundle tests: 16 passed.
- [x] Publish-to-catalog integration: 7 passed, including concurrent listing
      edits, moderation, artwork privacy, and the 10-screenshot cap.
- [x] Miniapp packer regressions: 2 passed, including atomic preservation of
      the previous artifact after a failed ZIP command.
- [x] Mentra Miniapp SDK: 270 passed.
- [x] Installer/SYSTEM security tests, including bundle-name impersonation.
- [x] Store controller, ownership, and UI-model tests: 10 passed.
- [x] Headless Chromium Store UI E2E at a 390×844 phone viewport: catalog,
      search-query preservation, install, details, verified identity, Installed
      state, and horizontal-overflow assertion.
- [x] Mentra App TypeScript compile.
- [x] Mentra App Jest: 84 suites passed (1 skipped), 671 tests passed
      (2 skipped).
- [x] Android ASG and Bluetooth SDK compile checks.
- [x] Full iOS Simulator native build with code signing disabled.
- [x] ZIP integrity check. Bundled Store SHA-256:
      `0b48bd91d7c9afcceeb43943b74703b98c0e42c255d621e8bc6b1c71a0aaa2ca`.
- [x] Review regressions: bounded streaming inflation and CRC checks in both
      Core and the phone, trusted host-selected Core URL, complete catalog
      pagination, Store-owned uninstall visibility, pre-activation host/SDK
      compatibility gates, running-context retry/rollback around updates,
      unbounded install request correlation, update repair of incompatible
      releases, and live detail resolution after catalog refreshes.
- [x] Touched-file lint and `git diff --check`.
- [x] Full Cloud suite audit: 544 passed, 1 skipped. The aggregate invocation
      also reproduces unrelated shared-state/credential baselines (R2 is not
      configured; Slack env is captured at import; account/audio suites race
      global Mongo/Redis state). Account auth passes 14/14 in isolation; Store
      lifecycle remains green in isolation.
- [x] No secrets, environment files, build directories, or generated native
      projects are included.
- [ ] Interactive phone/glasses smoke test. No simulator or physical device was
      attached to this workspace; native builds and automated host/UI tests are
      the available pre-review gates.

## Intentionally deferred signed federation hardening

These are not blockers for the approved first-release trust model.

- [x] Reserve the versioned authorization shape in `InstallMiniappRequest`.
- [ ] Add the Mentra/OEM Store-backend public-key trust table to each app build.
- [ ] Verify Store issuer, audience, expiry, and authorization signature in the
      host.
- [ ] Verify publisher signatures again on-device and enforce publisher-key
      continuity across package upgrades.
- [ ] Add issuer/key rotation and revocation UX.

## Pull request and review

- [x] Review the complete diff against `origin/dev`.
- [x] Commit focused changes without AI attribution.
- [x] Push the existing workspace branch without renaming it.
- [x] Open a non-draft PR targeting `dev` with test evidence.
- [ ] Monitor required checks and automated reviews.
- [x] Fix valid findings and rerun affected verification.
- [ ] Leave the PR ready for human review.
