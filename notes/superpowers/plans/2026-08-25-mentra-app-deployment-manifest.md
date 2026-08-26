---
status: draft
owner: Mentra
---

# Mentra App deployment manifest implementation plan

> Execution checklist. Keep the first release focused on the same official app
> binary with customer-hosted Core, Runtime, OTA, and speech artifacts.

**Goal:** Run a completed coordinated Mentra App release inside a
customer-controlled network by selecting one deployment manifest before sign-in
and before any public-network integration starts.

**Architecture:** The app resolves an embedded, MDM-provided, or QR-enrolled
deployment profile at cold boot. The active immutable profile configures auth and
Engine; Engine passes the OTA URL to Bluetooth SDK and model locations to its
speech managers. Custom profiles fail closed without Mentra endpoint fallbacks.

**Tech Stack:** React Native/Expo, TypeScript, MMKV, native managed-app
configuration bridges, Cloud V2, coordinated GitHub Actions releases.

**Spec source of truth:**
`notes/superpowers/specs/2026-08-25-mentra-app-deployment-manifest-design.md`

---

## Phase 1: Typed profile and pre-network boot

### Task 1: Add the deployment contract and resolver

**Files:**

- Create `mobile/modules/engine/src/runtime/deployment.ts`
- Modify `mobile/modules/engine/src/runtime/bootstrap.ts`
- Create `mobile/src/services/deployment/DeploymentService.ts`
- Create `mobile/src/services/deployment/embeddedDeployment.ts`
- Add focused resolver/schema tests beside those files

- [ ] Define and validate deployment manifest v1.
- [ ] Generate the embedded Mentra profile from coordinated build inputs.
- [ ] Resolve MDM URL, enrolled URL, then embedded profile in that order.
- [ ] Persist the custom URL and last valid manifest under `deploymentId`.
- [ ] Require exact `releaseIdentity` match and HTTPS outside development.
- [ ] Never fall back to the embedded profile after a custom source is selected.

### Task 2: Gate the React tree on deployment readiness

**Files:**

- Modify `mobile/src/app/_layout.tsx`
- Modify `mobile/src/contexts/AllProviders.tsx`
- Create `mobile/src/contexts/DeploymentContext.tsx`
- Add boot-route tests

- [ ] Load local deployment state before mounting `AuthProvider`.
- [ ] Move `SentrySetup()` behind the resolved telemetry policy.
- [ ] Mount PostHog only when the active profile enables it.
- [ ] Default native Firebase analytics collection off, then enable it only for
      an active profile that permits it.
- [ ] Render a local recovery/setup screen when a first-time custom profile
      cannot be loaded.

### Task 3: Add enrollment and deployment switching

**Files:**

- Create a deployment setup route under `mobile/src/app/auth/`
- Modify `mobile/src/contexts/DeeplinkContext.tsx`
- Add minimal Android/iOS MDM configuration bridges
- Modify logout/reset utilities

- [ ] Support a `mentra://deployment?url=...` QR payload.
- [ ] Show deployment name and Core/Runtime hosts before activation.
- [ ] Read the manifest URL from Android Enterprise and Apple managed app
      configuration when supplied.
- [ ] Make switching deployment stop Engine, sign out, clear the old auth
      namespace, and reboot through the same resolver.

## Phase 2: Feed the profile into auth and Engine

### Task 1: Make auth deployment-scoped

**Files:**

- Modify `mobile/src/utils/auth/authClient.ts`
- Modify `mobile/src/utils/auth/provider/accountClient.ts`
- Modify auth secure-storage helpers and tests
- Modify `mobile/src/utils/cloudVersion.ts`

- [ ] Construct the account provider only after deployment resolution.
- [ ] Namespace access tokens, refresh tokens, cached profile, and refresh state
      by `deploymentId`.
- [ ] Route login, refresh, subject-token, OAuth, and minimum-version calls only
      to the active Core URL.
- [ ] Render only the auth methods the profile enables; the first private
      deployment supports pre-provisioned email/password accounts without
      public Google, Apple, signup, verification-email, or recovery flows.
- [ ] Make the minimum-version screen use managed-update copy instead of public
      store URLs when `appUpdates.mode` is `managed`.
- [ ] Remove the current special deployment selection from scattered settings;
      represent Mentra and China using the common profile contract when ready.

### Task 2: Extend Engine configuration

**Files:**

- Modify `mobile/modules/engine/src/runtime/bootstrap.ts`
- Modify `mobile/src/services/cloudClient.ts`
- Modify `mobile/src/services/MantleManager.ts`
- Modify Engine lifecycle/config tests

- [ ] Add OTA and speech-model locations plus Engine-owned feature flags to the
      public config type.
- [ ] Pass the active profile into the existing `engine.configure()` call.
- [ ] Keep Core/Runtime construction and reconnection on the resolved immutable
      profile for the whole Engine lifecycle.

### Task 3: Route OTA and speech artifacts

**Files:**

- Modify `mobile/modules/engine/src/services/otaManifestUrl.ts`
- Modify `mobile/modules/engine/src/services/STTModelManager.ts`
- Modify `mobile/modules/engine/src/services/TTSModelManager.ts`
- Add URL-precedence, no-fallback, and download tests

- [ ] Resolve OTA as developer override, deployment URL, then embedded Mentra
      release pin.
- [ ] Reuse the existing Engine Wi-Fi/hotspot OTA coordinator unchanged after
      selecting the URL.
- [ ] Replace hard-coded Sherpa GitHub base URLs with deployment inputs.
- [ ] Ensure a custom profile with an unreachable artifact server fails without
      requesting GitHub or Mentra.

## Phase 3: Fail-close optional egress

**Files:**

- Modify `mobile/modules/engine/src/services/NavigationService.ts`
- Modify `mobile/src/services/ar99ApiConfig.ts` and `ar99Ota.ts`
- Modify external-link, wallpaper, store, privacy, and docs UI call sites
- Add policy tests

- [ ] Disable Mapbox route/geocode/native navigation entry points when the
      profile disables navigation.
- [ ] Disable AR99 vendor API/OTA requests when the profile disables them.
- [ ] Hide or replace public links/assets when external links are disabled.
- [ ] Confirm customer-hosted Core supplies only internal miniapp/media URLs for
      the pilot registry.
- [ ] Add a test that enumerates the known network integrations and asserts each
      has an explicit profile-controlled path.

## Phase 4: Customer artifacts and coordinated release

**Files:**

- Modify `.github/scripts/create-release-plan.mjs`
- Modify `.github/scripts/finalize-release-manifest.mjs`
- Modify `.github/workflows/reusable-coordinated-ota.yml` or add a reusable
  deployment-artifact job
- Add release-script tests and enterprise handoff docs

- [ ] Publish `mentra-deployment-template-<identity>.json` on the existing
      coordinated GitHub release.
- [ ] Publish a checksum-bearing bundle of the supported STT/TTS archives, or a
      separately versioned model bundle referenced by the release record.
- [ ] Record URLs, sizes, SHA-256 hashes, and provenance in the completed release
      manifest.
- [ ] Do not create a customer mobile build lane; reuse the exact Android and
      iOS artifacts from the coordinated release.
- [ ] Document Android MDM/APK import and iOS Apple Business Manager/MDM setup.

## Phase 5: Private service packaging and qualification

**Files:** Cloud V2 deployment charts/scripts, customer runbook, end-to-end tests

- [ ] Package the exact Core and Runtime service subset used by the official app.
- [ ] Configure customer-approved STT/TTS providers in private Runtime.
- [ ] Host the coordinated OTA bundle and speech artifacts on the internal
      update service.
- [ ] Run Android and iOS login, Runtime, miniapp, OTA, and offline-model tests.
- [ ] Run a clean-device packet capture with public internet blocked and fail the
      qualification if any unapproved destination is contacted.
- [ ] Verify the embedded Mentra profile in the ordinary coordinated release
      gates so consumer behavior remains unchanged.

## Suggested cut lines

- **PR 1:** Manifest types/resolver, embedded Mentra profile, boot gating, and
  tests. No customer deployment is promised yet.
- **PR 2:** QR/MDM enrollment and deployment-scoped auth/Core/Runtime.
- **PR 3:** OTA/model routing plus telemetry and optional-feature egress gates.
- **PR 4:** Coordinated deployment artifacts and a physical disconnected pilot.

An Android pilot is roughly a multi-PR, several-week effort rather than a small
endpoint toggle. The existing Engine configuration, portable OTA bundle, hotspot
flow, and coordinated release manifest remove much of the hard work; boot order,
auth isolation, telemetry gating, model hosting, and private Cloud packaging are
the remaining critical path.
