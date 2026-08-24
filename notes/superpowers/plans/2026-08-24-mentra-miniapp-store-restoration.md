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
- [x] Generate SYSTEM package identity from the ZIPs bundled into each Mentra
      App build. There is no author-declarable manifest permission or parallel
      hardcoded package-name list; a dev miniapp copying a bundled package name
      is not privileged without host-owned release provenance.
- [x] Protect every bundled SYSTEM package from removal and ordinary Store or
      preinstall replacement.
- [x] Protect every bundled SYSTEM package from direct user uninstall at the
      host registry boundary while preserving Remove from Home.
- [x] Treat every currently shipped bundle (including Notes, Translation,
      Livestreamer, Captions, Merge, Maps, Recorder, and Teleprompter) as SYSTEM
      automatically because its ZIP is present in the build.
- [x] Persist user uninstalls for non-SYSTEM bundled miniapps so app startup
      does not silently reinstall them; an explicit later install clears the
      tombstone.
- [x] Record the installing Store as provenance and reject cross-Store updates
      and removals.
- [x] Add a build-assigned SYSTEM update channel: the bundled Store selected as
      owner for a SYSTEM package may install a newer catalog release, and that
      release retains host-trusted SYSTEM provenance across restarts.
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
- [x] Preflight update `minHostVersion` and `sdkVersion` against the current
      Mentra App before showing or applying an update. Incompatible updates are
      deferred and become eligible automatically after the host is upgraded.
- [x] Preflight every new install and update against the remembered glasses
      model's required hardware. For example, reject a `CAMERA: REQUIRED`
      release for Even Realities G1 while accepting it for Mentra Live; optional
      hardware does not block installation.
- [x] Enforce hardware compatibility in the host install request and verify the
      canonical ZIP manifest again before activation, not only in Store UI.
- [x] Automatically update compatible SYSTEM releases assigned to this Store
      and non-SYSTEM releases already owned by this Store. Never adopt or update
      another Store's packages.
- [x] Keep the Store itself out of its in-process update loop; Store-self update
      remains a future signed host-owned updater concern.
- [x] Package and integrity-check `com.mentra.store-1.0.1.zip`.

## Verification

- [x] Cloud typecheck.
- [x] Developer Console production build.
- [x] Cloud Store/CLI bundle tests: 16 passed.
- [x] Publish-to-catalog integration: 7 passed, including concurrent listing
      edits, moderation, artwork privacy, and the 10-screenshot cap.
- [x] Miniapp packer regressions: 2 passed, including atomic preservation of
      the previous artifact after a failed ZIP command.
- [x] Mentra Miniapp SDK: 272 passed.
- [x] Installer/SYSTEM security tests, including bundle-name impersonation.
- [x] Store catalog, automatic-update policy, ownership, refresh serialization,
      and UI-model tests: 19
      passed.
- [x] Headless Chromium Store UI E2E at a 390×844 phone viewport: catalog,
      search-query preservation, install, details, verified identity, Installed
      state, and horizontal-overflow assertion.
- [x] Mentra App TypeScript compile.
- [x] Mentra App Jest: 85 suites passed (1 skipped), 672 tests passed
      (2 skipped).
- [x] Android ASG and Bluetooth SDK compile checks.
- [x] Full iOS Simulator native build with code signing disabled.
- [x] ZIP integrity check. Bundled Store SHA-256:
      `e18fdc3b66776db7b50b9ed349c1f343f831dc97bfd58983d40c9c1e5878bcad`.
- [x] Review regressions: bounded streaming inflation and CRC checks in both
      Core and the phone, trusted host-selected Core URL, complete catalog
      pagination, Store-owned uninstall visibility, pre-activation host/SDK
      compatibility gates, running-context retry/rollback around updates,
      required/optional hardware installation gates (including G1 camera
      rejection and Mentra Live acceptance),
      per-Store SYSTEM update ownership, unfiltered background update
      reconciliation, serialized post-mutation refreshes, preservation of
      newer trusted SYSTEM releases over older bundled ZIPs, and central
      rejection of direct/dev SYSTEM replacements,
      unbounded install request correlation, update repair of incompatible
      releases, live detail resolution after catalog refreshes, Expo-native
      bounded response streaming, and rejection of remote preinstalled
      replacements for build-owned SYSTEM packages, Store availability without
      connected glasses, and credential-free private-LAN Local/Auto Core
      origins without allowing public cleartext catalog traffic (including DNS
      names that resemble private IPv6 prefixes).
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

## Launch-readiness audit findings (2026-08-24)

The implementation is a strong install/catalog foundation, but the following
work remains before describing the overall Store program as production-ready:

- [x] Add compatible automatic updates for this Store's installed releases and
      its build-assigned SYSTEM packages, with host/SDK deferral and retry after
      the Mentra App becomes compatible.
- [ ] Seed or migrate production Store content. Cloud V2 production currently
      has no active published miniapp records, while the legacy Cloud V1 Store
      currently exposes 10 published cloud miniapps that cannot be copied
      blindly without canonical local bundles and publisher identities.
- [ ] Merge and deploy the Core catalog route; the production
      `/api/store/apps` endpoint returns 404 until this change is deployed.
- [ ] Resolve the remaining browser Developer Console scope in Linear OS-1443.
      The Console now manages listings, shows the canonical manifest and
      release history, and can submit/re-submit CLI-uploaded drafts. Direct ZIP
      upload remains intentionally CLI-only so publisher signing keys stay on
      the developer's machine; the Linear acceptance text should be updated if
      that is the final product decision.
- [x] Make the published Cloud V2 `mentra` CLI default to production and
      discover the selected Core's public WorkOS client id, while retaining
      environment overrides for dev/staging/OEM deployments.
- [ ] Expand the admin review UI to show the canonical manifest permissions,
      hardware requirements, Store listing/artwork, and moderation controls
      before publication.
- [ ] Decide and enforce Store-listing completeness requirements (at minimum
      icon, description, privacy/support information) before publication.
- [ ] Add successful-update garbage collection for obsolete semver bundle
      directories while preserving the rollback version.
- [ ] Verify the full flow on attached iOS and Android devices, including
      install, runtime restart, rollback, offline recovery, update, uninstall,
      and Remove from Home.
- [ ] Finish the public SDK launch work tracked in Linear OS-1907 and promote
      Cloud V2 `@mentra/cli` from prerelease after this production auth flow is
      validated.

## Pull request and review

- [x] Review the complete diff against `origin/dev`.
- [x] Commit focused changes without AI attribution.
- [x] Push the existing workspace branch without renaming it.
- [x] Open a non-draft PR targeting `dev` with test evidence.
- [ ] Monitor required checks and automated reviews.
- [x] Fix valid findings and rerun affected verification.
- [ ] Leave the PR ready for human review.
