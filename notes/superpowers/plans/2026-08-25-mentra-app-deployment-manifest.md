---
status: draft
owner: Mentra
---

# Mentra Enterprise self-hosted deployment implementation plan

> Execution checklist. Keep the first release focused on the same official app
> binary with customer-hosted Core, Runtime, OTA, and speech artifacts.

**Goal:** Run a completed coordinated Mentra App release inside a
customer-controlled network by selecting one deployment manifest before sign-in
and before any public-network integration starts.

**Architecture:** The app restores an MDM-provided or previously enrolled
deployment at cold boot. Otherwise, a local landing screen lets Google, Apple,
or Email activate the embedded Mentra profile. Connect to a workspace accepts a
human-facing HTTPS origin and fetches its manifest from
`/.well-known/mentra-deployment.json`. The app activates the candidate only
after validation and confirmation, then starts the selected Core's configured
auth flow. MDM injects the same workspace origin. The active immutable profile
configures auth and Engine; Engine passes the OTA URL to Bluetooth SDK and model
locations to its speech managers. Customer overrides and the embedded Mentra
profile resolve to one complete object; the air-gap template explicitly
replaces or nulls every public-network destination.

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
- [ ] Resolve an MDM workspace URL or previously enrolled profile before
      showing auth.
- [ ] Keep the embedded Mentra profile available for explicit consumer login
      selection rather than silently treating it as the only cold-boot default.
- [ ] Persist the workspace origin and last valid manifest under `deploymentId`.
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

### Task 3: Add workspace enrollment and deployment switching

**Files:**

- Modify `mobile/src/app/auth/start.tsx`
- Create `mobile/src/app/auth/workspace.tsx`
- Create `mobile/src/services/deployment/WorkspaceDeploymentService.ts`
- Modify mobile login translations, starting with `mobile/src/i18n/en.ts`
- Modify `cloud-v2/packages/core/src/api/well-known.api.ts`
- Add mobile and Core well-known-manifest tests
- Add minimal Android/iOS MDM configuration bridges
- Modify logout/reset utilities

- [ ] Preserve the current Mentra consumer signup/login controls and add a
      visually separate Connect to a workspace action below them.
- [ ] Make Google, Apple, and Email activate the embedded Mentra profile before
      entering the existing consumer auth flow.
- [ ] On the workspace route, ask for the HTTPS origin supplied by the user's
      organization, with an example such as `https://mentra.example.com`. Do not
      ask for a raw JSON or Core API URL.
- [ ] Provide Back on workspace entry and Cancel on candidate confirmation.
      Neither action may persist a workspace, mutate endpoints, or initialize a
      network-capable provider.
- [ ] Normalize the origin and fetch the manifest directly from
      `/.well-known/mentra-deployment.json`. Reject credentials, query strings,
      fragments, invalid TLS, oversized responses, and cross-origin redirects.
- [ ] Make Core or its deployment ingress serve the exact manifest JSON at the
      well-known path without authentication. Back it with the mounted release-
      matched deployment file rather than a second registry or pointer.
- [ ] Require the resolved `services.coreUrl` origin to equal the workspace
      origin in v1. Permit separate Runtime, artifact, and content hosts, but do
      not let discovery silently move authentication to another host.
- [ ] Keep the fetched deployment pending until recursive resolution, schema
      validation, and exact `releaseIdentity` validation succeed. Do not mutate
      active endpoints while loading or previewing a candidate.
- [ ] Show display name, workspace hostname, and sign-in type before activation,
      with Core/Runtime hosts under expandable connection details. Continue
      atomically persists the workspace and re-enters the gated auth route.
- [ ] On a manually selected workspace's pre-login screen, offer Use a different
      workspace and Return to Mentra. Returning clears the custom selection and
      restores the local consumer landing. Keep these controls unavailable when
      an enforced MDM workspace is active and show managed-organization copy.
- [ ] Read the workspace origin from Android Enterprise and Apple managed app
      configuration when supplied and use the same well-known resolver. Treat
      an enforced MDM value as authoritative.
- [ ] For the first private pilot, render one organization-account action for
      `auth.mode: "core-sso"`. Do not expose private signup, passwords,
      verification email, or recovery.
- [ ] Make switching deployment stop Engine, sign out, clear the old auth
      namespace, and reboot through the same resolver.
- [ ] Cache the selected manifest for disconnected boot and refresh it from the
      stable workspace URL when reachable. Test invalid candidates, MDM
      precedence, failed refresh, and the absence of cross-deployment
      credentials.

## Phase 2: Feed the profile into auth and Engine

### Task 1: Make auth deployment-scoped

**Files:**

- Modify `mobile/src/utils/auth/authClient.ts`
- Modify `mobile/src/utils/auth/provider/accountClient.ts`
- Modify auth secure-storage helpers and tests
- Modify `mobile/src/utils/cloudVersion.ts`
- Create `cloud-v2/packages/core/src/api/account/sso.api.ts`
- Create `cloud-v2/packages/core/src/services/account/oidc.client.ts`
- Modify `cloud-v2/packages/core/src/api/app.ts`
- Modify Core account/profile consumers that currently read identity from GoTrue

- [ ] Construct the account provider only after deployment resolution.
- [ ] Namespace access tokens, refresh tokens, cached profile, and refresh state
      by `deploymentId`.
- [ ] Route login, refresh, subject-token, OAuth, and minimum-version calls only
      to the active Core URL.
- [ ] Keep consumer Google, Apple, and Email entry points bound to the embedded
      Mentra profile and `auth.mode: "mentra-account"`. Render only the flow for
      an active custom profile's auth mode after enrollment.
- [ ] Make Core the auth broker for the first private pilot: generalize its
      existing PKCE browser handoff from fixed Google/Apple-through-GoTrue to one
      server-configured OIDC connection, map issuer plus subject to a Core user,
      and return the normal Cloud V2 session through a one-time handoff.
- [ ] Keep issuer metadata, client credentials, claim mapping, and IdP tokens in
      customer-hosted Core configuration. The manifest declares only
      `auth.mode: "core-sso"`; the app opens a fixed route on active Core.
- [ ] Validate Microsoft Entra as the reference OIDC integration, while keeping
      the Core adapter standards-based for Okta, Google, or an internal OIDC
      provider. Customer IT registers the application and assigns users/groups;
      Mentra public infrastructure and Supabase are not in the private auth path.
- [ ] Reuse the existing trusted-issuer verification and external-token exchange
      where their claim contract fits. Do not require a standard customer IdP to
      mint Mentra-specific routing claims without an explicit adapter.
- [ ] Replace first-party profile lookups that assume a GoTrue user with an
      identity-provider-neutral record keyed by issuer plus stable subject. Do
      not use email as the durable user key.
- [ ] Keep SAML and local email/password adapters outside the first pilot. They
      must fit the same post-manifest Core-session boundary when added.
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
- [ ] Apply `systemMiniapps.approvedPackageNamesOverride` consistently to
      registration, bundled installation, launcher/menu visibility, direct
      routes, and autostart. `null` uses the complete built-in catalog, `[]`
      approves none, and a populated array approves only those packages.
- [ ] Generate the embedded Mentra profile with a `null` override. Generate
      customer templates with an explicit release-pinned package allowlist so
      newly introduced system miniapps require customer approval.
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
- [ ] Document the workspace URL and well-known endpoint, MDM key, private-CA
      installation, OIDC application registration, and callback URL.

## Phase 5: Private service packaging and qualification

**Files:** Cloud V2 deployment charts/scripts, customer runbook, end-to-end tests

- [ ] Package the exact Core and Runtime service subset used by the official app.
- [ ] Keep Core in the first private deployment as the customer-hosted control
      plane for identity, sessions, token exchange, registry, settings,
      version-check, and reporting. Runtime is the real-time execution plane.
      Do not model Runtime-only operation as a manifest option.
- [ ] Package direct OIDC support in Core without Supabase. Provide configuration
      for issuer, client id/secret, scopes, callback URL, and stable subject-claim
      mapping.
- [ ] Verify just-in-time user creation, disabled-user behavior, session expiry,
      and reauthentication without creating a second employee password store.
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
- **PR 2:** Workspace URL/well-known manifest enrollment, MDM configuration,
  deployment-scoped Core/Runtime, and direct enterprise OIDC sign-in.
- **PR 3:** OTA/model routing, deployment wallpaper/link/system-miniapp policy,
  pairing-model override, telemetry, and optional-feature egress gates.
- **PR 4:** Coordinated deployment artifacts and a physical disconnected pilot.

An Android pilot is roughly a multi-PR, several-week effort rather than a small
endpoint toggle. The existing Engine configuration, portable OTA bundle, hotspot
flow, and coordinated release manifest remove much of the hard work; boot order,
auth isolation, telemetry gating, model hosting, and private Cloud packaging are
the remaining critical path.

SAML, local email/password accounts, self-service workspace discovery, and
directory/domain verification are follow-up identity work. The first pilot uses
a workspace URL and one server-configured OIDC connection against the customer's
existing corporate identity provider.
