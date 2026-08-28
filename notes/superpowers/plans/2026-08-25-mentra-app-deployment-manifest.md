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

**Architecture:** The app restores an MDM-provided or previously enrolled
deployment at cold boot. Otherwise, a local landing screen lets Google, Apple,
or Email activate the embedded Mentra profile, while Enterprise / SSO enrolls a
custom profile by QR or URL. The active immutable profile configures auth and
Engine; Engine passes the OTA URL to Bluetooth SDK and model locations to its
speech managers. Customer overrides and the embedded Mentra profile resolve to
one complete object; the air-gap template explicitly replaces or nulls every
public-network destination.

**Tech Stack:** React Native/Expo, TypeScript, MMKV, native managed-app
configuration bridges, Cloud V2, Cloudflare R2, coordinated GitHub Actions
releases.

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

- [ ] Define and validate deployment manifest v1 as a recursive override of the
      complete embedded Mentra profile. Arrays replace; explicit null disables
      nullable destinations; validation runs on the resolved profile.
- [ ] Generate the embedded Mentra profile from coordinated build inputs.
- [ ] Resolve an MDM URL or previously enrolled profile before showing auth.
- [ ] Keep the embedded Mentra profile available for explicit consumer login
      selection rather than silently treating it as the only cold-boot default.
- [ ] Persist the custom URL and last valid manifest under `deploymentId`.
- [ ] Require exact `releaseIdentity` match and HTTPS outside development.
- [ ] Never fall back to the embedded profile after a custom source is selected.
- [ ] Validate wallpaper URLs, deployment links, system-miniapp package names,
      and `glasses.allowedModelsOverride` identifiers as part of the resolved
      typed contract.

### Task 2: Gate the React tree on deployment readiness

**Files:**

- Modify `mobile/src/app/_layout.tsx`
- Modify `mobile/src/contexts/AllProviders.tsx`
- Create `mobile/src/contexts/DeploymentContext.tsx`
- Add boot-route tests

- [ ] Load local deployment state before mounting `AuthProvider`.
- [ ] Move `SentrySetup()`, PostHog, and Firebase Analytics behind the one
      resolved `telemetry` switch. Default native collection off until a
      profile with `telemetry: true` is active.
- [ ] Render the local consumer-or-enterprise landing screen before starting any
      network integration when no deployment is already selected.
- [ ] Render a local recovery/setup screen when a first-time custom profile
      cannot be loaded.

### Task 3: Add enrollment and deployment switching

**Files:**

- Create a deployment setup route under `mobile/src/app/auth/`
- Modify `mobile/src/contexts/DeeplinkContext.tsx`
- Add minimal Android/iOS MDM configuration bridges
- Modify logout/reset utilities

- [ ] Add an Enterprise / SSO action beside Google, Apple, and Email on the
      initial landing screen.
- [ ] Make Google, Apple, and Email activate the embedded Mentra profile before
      entering the existing consumer auth flow.
- [ ] Make Enterprise / SSO open MDM, QR, or manual-URL enrollment and support a
      `mentra://deployment?url=...` QR payload.
- [ ] Show deployment name and Core/Runtime hosts before activation.
- [ ] Read the manifest URL from Android Enterprise and Apple managed app
      configuration when supplied.
- [ ] After enrollment, show the deployment name and render the resolved
      profile's declared email, SSO, or other authentication methods. Treat the
      enrollment QR as configuration, not an auth credential.
- [ ] For email/password, show account creation only when `allowSignup` is
      true and send it to the selected Core. When it is false, present sign-in
      only; the customer must pre-provision users or configure SSO.
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
- [ ] Keep consumer Google, Apple, and Email entry points bound to the embedded
      Mentra profile. Render only the active custom profile's auth methods and
      supporting signup, verification, and recovery flows after enrollment.
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
- [ ] Create a Mentra-owned Cloudflare R2 bucket and custom model CDN domain
      (for example `models.mentra.glass`), mirror the exact approved Sherpa-ONNX
      archives, and record upstream source/license provenance.
- [ ] Replace hard-coded upstream Sherpa GitHub base URLs with deployment
      inputs. The embedded Mentra profile points at the Mentra-owned model CDN;
      private profiles may point at an internal mirror.
- [ ] Ensure a custom profile with an unreachable artifact server fails without
      requesting GitHub or Mentra.

## Phase 3: Deployment-scoped content, hardware, and optional egress

**Files:**

- Modify `mobile/modules/engine/src/services/NavigationService.ts`
- Modify `mobile/src/components/settings/BackgroundPicker.tsx`
- Modify `mobile/src/constants/appConfig.ts` and legal/support link call sites
- Modify `mobile/src/constants/miniapps.ts`, bundled installation, built-in
  catalog, menu, launcher, and deep-link routing
- Modify the pairing model registry, selection, scanning, deep-link, and
  reconnect paths
- Add policy tests

- [ ] Disable Mapbox route/geocode/native navigation entry points when the
      profile disables navigation.
- [ ] Replace hard-coded preset wallpapers with the active profile's complete
      `content.wallpaperUrls` list; an empty list makes no public request.
- [ ] Route privacy, terms, documentation, support, app-store, and review
      actions through their resolved manifest fields. Missing customer fields
      inherit the embedded Mentra values; explicit null suppresses nullable
      destinations. Do not add a blanket `externalLinks` switch.
- [ ] Apply `systemMiniapps.hiddenPackageNames` consistently to registration,
      bundled installation, launcher/menu visibility, direct routes, and
      autostart. The embedded Mentra profile supplies an empty list.
- [ ] Centralize pairable glasses behind stable model ids. When
      `glasses.allowedModelsOverride` is present, filter the pairing model list
      to it; otherwise show the normal catalog. Do not add enforcement to scan,
      deep-link, reconnect, or profile-switch paths.
- [ ] Keep vendor-specific behavior behind glasses adapters; do not add AR99 or
      other model-specific policy fields to the deployment schema.
- [ ] Ship the first private template with only Mentra Live in the pairing
      override. Do not expose another model until its adapter passes a blocked-
      public-internet test and any vendor network calls are disabled or routed
      to customer-controlled endpoints.
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
- [ ] Keep Core in the first private deployment. Do not make Runtime-only auth
      or split Core's account, registry, settings, version-check, and reporting
      APIs part of this implementation.
- [ ] Configure customer-approved STT/TTS providers in private Runtime.
- [ ] Host the coordinated OTA bundle and speech artifacts on the internal
      update service.
- [ ] Run Android and iOS login, Runtime, miniapp, OTA, and offline-model tests.
- [ ] Run a clean-device packet capture with public internet blocked and fail the
      qualification if any unapproved destination is contacted.
- [ ] Verify the embedded Mentra profile in the ordinary coordinated release
      gates so consumer behavior remains unchanged.

## Suggested cut lines

- **PR 1:** Manifest types/resolver, embedded Mentra profile, deployment-neutral
  landing screen, boot gating, and tests. No customer deployment is promised yet.
- **PR 2:** QR/MDM enrollment, consumer-versus-enterprise auth selection, and
  deployment-scoped auth/Core/Runtime.
- **PR 3:** OTA/model routing, deployment wallpaper/link/system-miniapp policy,
  pairing-model override, telemetry, and optional-feature egress gates.
- **PR 4:** Coordinated deployment artifacts and a physical disconnected pilot.

An Android pilot is roughly a multi-PR, several-week effort rather than a small
endpoint toggle. The existing Engine configuration, portable OTA bundle, hotspot
flow, and coordinated release manifest remove much of the hard work; boot order,
auth isolation, telemetry gating, model hosting, and private Cloud packaging are
the remaining critical path.
