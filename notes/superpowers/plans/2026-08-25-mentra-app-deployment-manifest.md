---
status: draft
owner: Mentra
---

# Mentra Enterprise Self-Hosted call deployment implementation plan

> Execution checklist for the first customer deployment: the official Mentra
> App, bundled Mentra Call, Microsoft Entra, a small customer-hosted Workspace
> Gateway, and direct Teams participation through ACS. Do not package full Core
> or Runtime for this milestone.

**Goal:** Run Mentra Call on Android and iOS in a restricted customer-controlled
workspace without Mentra public Core or Runtime.

**Architecture:** The app resolves a workspace manifest before authentication.
The first customer template selects native Microsoft Entra sign-in, disables the
Cloud Client, enables a local-only Engine and approved bundled miniapps, and
routes managed-stream and ACS credential requests to a customer-hosted Workspace
Gateway. Mentra Live publishes WHIP to the configured provider; the phone
consumes WHEP and publishes raw media through ACS to Teams. The current guest
ACS identity is the media bring-up path. The same cached Entra account later
supplies the delegated token exchanged for an authenticated Teams-user ACS
token, with no second interactive login.

**Tech stack:** React Native/Expo, TypeScript, Android/iOS MSAL, local MentraJS,
native ACS Calling SDK, customer-hosted Workspace Gateway, Cloudflare Stream for
the first WHIP/WHEP provider, coordinated GitHub releases.

**Spec source of truth:**
`notes/superpowers/specs/2026-08-25-mentra-app-deployment-manifest-design.md`

---

## Phase 1: Deployment contract and pre-network boot

### Task 1: Add the typed deployment resolver

**Files:**

- Create `mobile/modules/engine/src/runtime/deployment.ts`
- Modify `mobile/modules/engine/src/runtime/bootstrap.ts`
- Create `mobile/src/services/deployment/DeploymentService.ts`
- Create `mobile/src/services/deployment/embeddedDeployment.ts`
- Add resolver/schema tests beside those files

- [ ] Define manifest v1 as an override of the complete embedded Mentra profile.
      Arrays replace; explicit null disables nullable destinations; validation
      runs on the resolved profile.
- [ ] Add `services.workspaceGatewayUrl` and make `coreUrl` and `runtimeUrl`
      nullable without localhost or Mentra fallbacks.
- [ ] Add `auth.mode: "microsoft-entra"` with exact authority URL, native client
      id, and gateway/Teams/Graph delegated scopes.
- [ ] Add `features.cloudSession`; false means no Cloud Client or cloud-dependent
      services are constructed.
- [ ] Generate the embedded Mentra profile from coordinated build inputs. It
      keeps `auth.mode: "mentra-account"`, public Core/Runtime, and the ordinary
      consumer feature set.
- [ ] Restore the selected deployment before showing auth or starting a network
      integration.
- [ ] Persist workspace origin and last valid manifest under `deploymentId`.
- [ ] Namespace credentials, settings, miniapp state, and caches by
      `deploymentId`.
- [ ] Require exact `releaseIdentity` and HTTPS outside development.
- [ ] Validate all URLs, deployment links, package names, glasses model ids, and
      Entra authority/scopes.
- [ ] Reject `common`, `organizations`, personal Microsoft accounts, and any
      authority not pinned to the declared first-pilot tenant.
- [ ] Test that null Core/Runtime never resolves to embedded Mentra endpoints.

### Task 2: Gate the React and native startup paths

**Files:**

- Modify `mobile/src/app/_layout.tsx`
- Modify `mobile/src/contexts/AllProviders.tsx`
- Create `mobile/src/contexts/DeploymentContext.tsx`
- Modify native analytics configuration on Android and iOS
- Add boot-route and clean-install tests

- [ ] Load deployment state before mounting consumer `AuthProvider`.
- [ ] Move Sentry, PostHog, and Firebase Analytics behind the resolved master
      telemetry switch.
- [ ] Default native collection off before JavaScript/profile resolution.
- [ ] Render a fully local landing screen when no deployment is selected.
- [ ] Render local recovery/setup UI if a first custom manifest cannot load.
- [ ] Add clean-install packet-capture coverage proving no telemetry or Mentra
      service starts while a workspace is unresolved.

### Task 3: Add manual workspace enrollment

**Files:**

- Modify `mobile/src/app/auth/start.tsx`
- Create `mobile/src/app/auth/workspace.tsx`
- Create `mobile/src/services/deployment/WorkspaceDeploymentService.ts`
- Modify login translations, starting with `mobile/src/i18n/en.ts`
- Add the well-known manifest route to the Workspace Gateway
- Modify logout/reset utilities

- [ ] Preserve current Google, Apple, and email controls and add a visually
      separate Connect to a workspace action.
- [ ] Make consumer actions activate the embedded profile before auth.
- [ ] Ask for a human-facing HTTPS workspace origin, not a JSON/Core/Runtime URL.
- [ ] Fetch `/.well-known/mentra-deployment.json` directly from that origin.
- [ ] Reject credentials, query, fragment, invalid TLS, oversized responses, and
      cross-origin redirects.
- [ ] Require `services.workspaceGatewayUrl` to match the entered origin.
- [ ] Keep the fetched workspace pending through resolution, schema validation,
      and exact release validation.
- [ ] Show display name, hostname, and Microsoft organization sign-in before
      activation, with technical details expandable.
- [ ] Provide Back and Cancel before activation. Neither may persist state or
      start providers.
- [ ] Provide Use a different workspace and Return to Mentra before login.
- [ ] Persist `source: "manual"`; do not implement QR, a Mentra directory, or
      managed-app configuration injection in v1.
- [ ] Cache the last valid manifest for disconnected boot and never fall back to
      the consumer profile after custom selection.

## Phase 2: Native Microsoft Entra authentication

### Task 1: Add deployment-scoped MSAL on Android and iOS

**Files:**

- Add an Expo/native Microsoft Entra auth module for Android and iOS
- Create `mobile/src/services/auth/EntraAuthService.ts`
- Modify auth routing and account context
- Modify secure-storage and logout utilities
- Add unit, native integration, and end-to-end auth tests

- [ ] Initialize MSAL only after a `microsoft-entra` manifest is active.
- [ ] Configure it dynamically from the exact tenant authority and client id
      while using the official Mentra App's registered native redirect URI.
- [ ] Use Authorization Code + PKCE through the system browser or supported
      Microsoft broker.
- [ ] Persist only MSAL/account state in OS-protected storage, scoped by
      deployment id.
- [ ] Derive the stable local user namespace from verified `tid` plus `oid`, not
      email.
- [ ] Acquire the Workspace Gateway scope for the selected account and refresh
      it silently.
- [ ] Keep consumer Google/Apple/email bound to the embedded Mentra profile.
- [ ] Do not create a Cloud V2/Core session for the call-focused workspace.
- [ ] Implement logout, disabled-user recovery, authority mismatch, token expiry,
      and deployment switching without credential crossover.
- [ ] Test assigned/unassigned users, wrong tenant, MFA, Conditional Access,
      cancelled login, revoked session, and broker/browser return on both
      platforms.

### Task 2: Authenticate the Workspace Gateway

**Files:** Workspace Gateway auth middleware and deployment guide

- [ ] Validate exact Entra issuer, tenant, audience, signature, expiry, and
      gateway scope on every protected endpoint.
- [ ] Authorize only assigned users/groups defined by customer policy.
- [ ] Key server audit events by tenant id and object id; do not persist raw
      identity-provider tokens.
- [ ] Return actionable 401/403 responses without exposing token contents.
- [ ] Document the single-tenant public-client registration, official Android
      and iOS redirects, Enterprise Application assignment, gateway API scope,
      and consent.

## Phase 3: Cloud-session-disabled Engine and bundled Mentra Call

### Task 1: Make local-only Engine startup supported

**Files:**

- Modify `mobile/modules/engine/src/engine.ts`
- Modify `mobile/modules/engine/src/services/CloudClientService.ts`
- Modify Engine startup services that currently assume cloud auth
- Modify `mobile/src/services/MantleManager.ts`
- Add local-only startup tests

- [ ] When `cloudSession` is false, skip Cloud Client construction, Core token
      sync, Runtime connection, cloud audio uplink, reconnect alarms, cloud
      reports, support-profile sync, and cloud registry synchronization.
- [ ] Continue Bluetooth, device hydration, pairing/reconnect, local settings,
      display, local miniapp runtime/launcher, phone stream coordination, ACS,
      and configured OTA.
- [ ] Replace the global Core-owned local-miniapp identity assumption with the
      verified deployment-scoped Entra identity.
- [ ] Do not mint miniapp tokens from Core for approved bundled miniapps.
- [ ] Fail unavailable cloud-only miniapp APIs explicitly rather than retrying
      localhost or Mentra endpoints.
- [ ] Suppress cloud-disconnected UI/notifications in local-only mode.

### Task 2: Bundle and constrain Mentra Call

**Files:**

- Sync the release-pinned Mentra Call package into `mobile/assets/miniapps/`
- Regenerate `mobile/src/generated/bundledMiniapps.ts`
- Modify bundled install/registry/launcher policy
- Modify Mentra Call ACS branch in its external repository
- Add bundle and launch tests

- [ ] Bundle Mentra Call in the official app and approve it in the first
      customer manifest template.
- [ ] Apply `systemMiniapps.approvedPackageNamesOverride` to install, registry,
      menus, deep links, autostart, and direct launch.
- [ ] Remove the build-time hard-coded Mentra Call backend URL from its ACS path.
- [ ] Keep provider-neutral call requests in `session.meeting`.
- [ ] Keep ACS/Entra credentials below the trusted host boundary; miniapp
      JavaScript receives no bearer token.
- [ ] Preserve existing Teams/ACS join, leave, mute, state, recovery, WHEP
      update, and incoming-audio behavior from `nicolo/acs-teams-v1`.

## Phase 4: Workspace Gateway and managed media

### Task 1: Package the minimal gateway

**Files:** New Workspace Gateway package, container, Azure template, tests, and
operator documentation

- [ ] Serve the exact deployment manifest at the well-known path from a mounted
      release-matched file.
- [ ] Provide authenticated create/status/delete managed-stream endpoints.
- [ ] Extract the existing Cloudflare Stream provider logic needed to create a
      live input and return WHIP/WHEP URLs.
- [ ] Hold provider credentials only in the customer secret store.
- [ ] Provide an ACS guest-token endpoint using customer-owned ACS credentials
      for the fastest media checkpoint.
- [ ] Use Azure managed identity/RBAC in the reference environment where the ACS
      SDK supports it; permit a rotated connection-string secret for the first
      controlled deployment.
- [ ] Validate only the configuration needed by the active provider/profile. Do
      not require MongoDB, Recall, speech, store, or Mentra cloud variables.
- [ ] Add rate limits, per-user resource ownership, expiration, idempotent
      teardown, and abandoned-stream cleanup.
- [ ] Publish a health/readiness endpoint that does not disclose secrets.

### Task 2: Route managed streams outside Runtime

**Files:**

- Modify `mobile/modules/engine/src/services/cloudStreamApi.ts`
- Modify `mobile/modules/engine/src/services/PhoneStreamCoordinator.ts`
- Add a Workspace Gateway media client
- Add provider-routing and recovery tests

- [ ] Introduce a managed-stream provisioning interface independent of Cloud V2
      Runtime.
- [ ] Select Runtime only when a full platform profile supplies it; select the
      Workspace Gateway for the call-focused profile.
- [ ] Authenticate gateway calls with the deployment-scoped Entra account.
- [ ] Preserve existing `StreamResult`, WHIP start, WHEP playback, status,
      teardown, and reconnect behavior for Mentra Call.
- [ ] Never expose streaming-provider credentials to the app or miniapp.
- [ ] Make the remaining Cloudflare hop explicit in UI diagnostics and operator
      documentation.

### Task 3: Move ACS token ownership into the host

**Files:**

- Modify `mobile/modules/engine/src/services/AcsMeetingService.ts`
- Modify Android/iOS ACS meeting modules as required
- Modify `LocalMiniappRuntime` meeting handlers
- Modify Mentra Call `CallManager`
- Add token/redaction and end-to-end tests

- [ ] Change the miniapp contract so `session.meeting.join` does not carry an ACS
      token.
- [ ] Have the trusted host call the configured gateway just before join and
      refresh before expiry when necessary.
- [ ] Redact ACS and Entra bearer tokens from logs, errors, diagnostics, and
      miniapp messages.
- [ ] Preserve native call lifecycle as the source of truth.
- [ ] Qualify the current guest token path first and clearly label its Teams
      roster/lobby behavior.

## Phase 5: Reuse Entra for authenticated Teams identity

This phase is not required to prove raw media, but it is required before claiming
that the user joins as their corporate Teams account. It reuses Phase 2; there is
no second interactive SSO screen.

### Task 1: Add Teams-user token exchange

**Files:** MSAL scope acquisition, Workspace Gateway ACS exchange endpoint,
native ACS agent setup, tests, and admin guide

- [ ] Add delegated ACS `Teams.ManageCalls` and `Teams.ManageChats` permissions
      to the Entra registration and document admin consent/assignment.
- [ ] Silently acquire an ACS-scoped Entra token for the same cached MSAL account.
- [ ] Send it only to the trusted customer gateway over TLS; validate tenant,
      client/app id, object id, scopes, and that it matches the active account.
- [ ] Exchange it with ACS `GetTokenForTeamsUser` using the gateway's ACS
      credential.
- [ ] Return only the short-lived ACS Teams-user token to the native host.
- [ ] Confirm the Android and iOS Calling SDK agent construction required by a
      Teams-user token while retaining raw media.
- [ ] Test same-tenant and external meetings, employee roster identity, lobby
      policy, disabled user, token expiry/refresh, revoked consent, missing Teams
      license, and Conditional Access.

### Task 2: Create meetings as the signed-in user when required

**Files:** Host meeting API, optional gateway proxy, Mentra Call UI adapter, and
Graph tests

- [ ] Allow joining a supplied Teams URL without Graph permission.
- [ ] When creation is enabled, silently request delegated Graph
      `OnlineMeetings.ReadWrite` for the same MSAL account.
- [ ] Call `POST /me/onlineMeetings` from the trusted host or gateway and return
      only the join URL to Mentra Call.
- [ ] Remove the current shared licensed Graph service account and app-only
      client secret from the customer template.
- [ ] Keep meeting creation optional so customers that only join scheduled
      meetings grant no Graph permission.

## Phase 6: Deployment policy, artifacts, and qualification

### Task 1: Enforce content, hardware, and egress policy

**Files:** Existing wallpaper/link/update/miniapp/pairing/telemetry call sites and
policy tests

- [ ] Use only `content.wallpaperUrls`; empty means no remote presets.
- [ ] Route privacy, terms, docs, support, store, and review actions through
      resolved fields. Do not add `externalLinks`.
- [ ] Apply the approved system-miniapp list everywhere. The embedded Mentra
      profile uses `null`; the customer template pins Mentra Call and explicitly
      approved utilities.
- [ ] Filter the pairing picker with `glasses.allowedModelsOverride`; keep vendor
      behavior in model adapters and do not add AR99-specific schema.
- [ ] Disable navigation, cloud speech, cloud reports, public store/registry, and
      any other unavailable integration in the call-focused template.
- [ ] Add an integration inventory test asserting every known network path is
      selected, disabled, or explicitly approved by the active profile.

### Task 2: Publish customer artifacts and guides

**Files:** Coordinated release scripts/workflows, Mintlify docs, gateway deployment
templates, and runbooks

- [ ] Publish a release-matched call-focused deployment template.
- [ ] Publish the Workspace Gateway container digest, SBOM, checksums, and Azure
      deployment template.
- [ ] Publish customer-hostable Mentra Live OTA artifacts when OTA is enabled.
- [ ] Reuse the exact normal Android and iOS app artifacts; no customer build
      lane.
- [ ] Document Android APK/MDM and iOS App Store/Apple Business Manager
      distribution. State that workspace entry is manual in v1.
- [ ] Publish a Microsoft Entra guide for native app redirects, single-tenant
      authority, API permissions/scopes, assignment, consent, revocation, and
      troubleshooting.
- [ ] Publish an ACS/Cloudflare gateway guide that lists only the required
      secrets, supports rotation, and distinguishes guest from Teams-user
      identity.
- [ ] Document that restricted-network means customer-approved Microsoft and
      streaming egress, not zero internet.

### Task 3: Qualify the Mentra Azure reference deployment

**Files:** Mentra Azure environment and end-to-end test records

- [ ] Deploy the Workspace Gateway in Mentra's Azure account using Mentra's
      non-production Entra tenant and customer-style isolation.
- [ ] Use a customer-style ACS resource, secret store/managed identity, and
      dedicated Cloudflare configuration.
- [ ] Do not deploy or use Mentra public Core or Runtime.
- [ ] Select the workspace using official Android and iOS Mentra App artifacts.
- [ ] Run Entra assignment, MFA, wrong-tenant, disabled-user, expiry, logout, and
      deployment-switch tests.
- [ ] Run Teams join, mute, incoming audio, Wi-Fi recovery, WHEP replacement,
      leave, and 30–60 minute soak tests on Android and iOS.
- [ ] Run packet capture with Mentra public services blocked and fail on any
      unapproved destination.
- [ ] Re-run ordinary consumer release gates with the embedded Mentra profile.

## Suggested cut lines

- **PR 1:** Manifest types/resolver, landing screen, manual workspace flow,
  nullable Core/Runtime, and pre-network telemetry gating.
- **PR 2:** Native Entra authentication plus deployment-scoped identity and
  secure logout.
- **PR 3:** Cloud-session-disabled Engine and approved bundled Mentra Call.
- **PR 4:** Workspace Gateway, Cloudflare managed-stream routing, and host-owned
  ACS guest credentials; complete direct-to-Teams media checkpoint.
- **PR 5:** Authenticated Teams-user token exchange and optional delegated Graph
  meeting creation if required by the pilot.
- **PR 6:** OTA/content/hardware policy, release artifacts, guides, and physical
  restricted-network qualification.

The narrowed call deployment avoids the largest previous work item: packaging
general Core and Runtime with every unrelated SaaS and data dependency. It still
requires real mobile work—native Entra login, cloudless Engine startup, managed
stream extraction, and secure ACS credential ownership—but those changes are
directly tied to Mentra Call and form a reusable foundation for later workspace
profiles.
