---
status: draft
owner: Mentra
---

# Mentra Private Deployment call implementation plan

> Execution checklist for the first customer deployment: the official Mentra
> App, bundled Mentra Call, Microsoft Entra, one reduced customer-hosted Runtime
> Services process, and direct Teams participation through ACS. Do not package
> Core, Store, or a dedicated Mentra Call backend for this milestone.

**Goal:** Run Mentra Call on Android and iOS in a restricted customer-controlled
workspace without Mentra public Core, Runtime, Store, or miniapp services.

**Architecture:** The app resolves a workspace manifest before authentication.
The first customer template selects native Microsoft Entra sign-in, disables the
Core path, enables approved bundled miniapps, and authenticates Runtime directly
with an Entra-issued token. One Runtime process enables only the meeting-provider
module. Mentra Live sends media directly to the phone over SoftAP; the phone
publishes raw media through ACS to Teams. The same
cached Entra account supplies the delegated token exchanged for an authenticated
Teams-user ACS token, with no second interactive login. Mentra Call invokes
host capabilities and has no required backend in this profile.

**Tech stack:** React Native/Expo, TypeScript, Android/iOS MSAL, local MentraJS,
native ACS Calling SDK, direct SoftAP glasses-to-phone transport, modular Cloud
V2 Runtime Services, and coordinated GitHub releases.

**Spec source of truth:**
`notes/superpowers/specs/2026-08-25-mentra-app-deployment-manifest-design.md`

---

## Product acceptance consumed from Mentra Call

This plan consumes one bounded Mentra Call product slice; it is not the master
Mentra Call roadmap and does not reuse the older V1/V1.5/V2/V3 numbering.

- Join an existing Microsoft 365 work/school Teams meeting from a pasted URL.
- Show one primary **Join Teams call** action plus clear SoftAP connection,
  joining, in-call, failure, recovery, and leave states.
- Use the direct SoftAP glasses-to-phone media path; do not provision a public
  streaming relay for this enterprise profile.
- Preserve one unambiguous outgoing-microphone policy. Use the phone microphone
  unless the integrated SoftAP contract qualifies glasses microphone audio;
  incoming Teams audio plays through the glasses.
- Target 1280x720 at 15 fps and less than two seconds of measured end-to-end
  latency at the Teams receiver under the reference network.
- Leave tears down local media and ACS resources, confirms exit, and returns
  home.
- No meeting creation, Graph/calendar permission, invite flow, chat, Google Meet,
  Zoom, or public WHIP/WHEP relay is required for the first enterprise release.

Nicolo's branch may use an ACS guest identity named `Mentra Live` to qualify the
native media path. The enterprise integration instead uses the signed-in
employee's Entra/Teams identity and does not add a second interactive login.

---

## Execution lanes

### Lane A: Alex — unblocked enterprise/platform foundations from `dev`

Phases 1, 2, Phase 3 Task 1, and Phase 4 can proceed without the native ACS
branch. Lane A owns deployment resolution, Entra, generic Runtime-only Engine
auth, modular Runtime boot, the server-side ACS exchange, and the Azure
reference service. The Runtime meetings endpoint is exercised through
a server-side harness; Lane A does not connect it to native ACS.

### Lane B: Nicolo — native ACS/media branch

The owner of `nicolo/acs-teams-v1` retains the native ACS module and raw-media
implementation, audio policy, current Miniapp SDK meeting request, and Mentra
Call ACS controller. The enterprise integration must adapt its input to the
direct SoftAP source before qualification. Lane A does not edit or replace
those files.

### Lane C: Alex + Nicolo — post-merge integration

Phase 3 Task 2, Phase 5, final bundling, and end-to-end call qualification begin
after Lane B lands on `dev`. This lane connects the trusted native host to the
already-qualified Runtime meetings endpoint and finalizes the Miniapp SDK call
contract with the native implementation's owner.

Lane A exits when the official app can resolve a customer manifest, sign in with
Entra, and authenticate directly to a reduced Runtime; that Runtime starts only
the meetings HTTP module and completes an ACS Teams-user exchange through a
server-side harness. Lane A is not expected to place a Teams call.

### Merge gates

1. Ship the design and all Lane A work together in this Alex-owned PR based on
   current `dev`; it does not import or modify Nicolo's ACS branch. Keep the
   work reviewable as staged commits inside the PR.
2. Nicolo rebases or merges current `dev`, qualifies the guest ACS media path,
   and lands Lane B as its own focused PR. Lane B does not wait for enterprise
   Entra or Runtime work.
3. Once this PR and Lane B are on `dev`, create Lane C from fresh
   `dev`. Jointly finalize the provider-neutral host/Miniapp SDK boundary and
   replace miniapp credential pass-through with host-owned Runtime exchange.
4. Pin and bundle the matching Mentra Call package only after Lane C's contract
   is stable, then run the complete Azure reference deployment qualification.

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
- [ ] Make `coreUrl` and `runtimeUrl` nullable without localhost or Mentra
      fallbacks.
- [ ] Retain package-name-keyed `systemMiniapps.configuration` for genuine
      package-specific values, but keep Runtime URLs and auth scopes at the host
      deployment level.
- [ ] Add `auth.mode: "microsoft-entra"` with exact authority URL, native client
      id, Runtime API scope, and ACS Teams delegated scopes. Request no Graph
      scope in the first call-focused template.
- [ ] Add `features.runtimeRealtimeSession`; false disables Runtime WebSocket,
      audio, and subscriptions while preserving authenticated Runtime REST
      capabilities.
- [ ] Generate the embedded Mentra profile from coordinated build inputs. It
      keeps `auth.mode: "mentra-account"`, public Core/Runtime, and the ordinary
      consumer feature set.
- [ ] Restore the selected deployment before showing auth or starting a network
      integration.
- [ ] Persist workspace origin and last valid manifest under `deploymentId`.
- [ ] Namespace credentials, settings, miniapp state, and caches by
      `deploymentId`.
- [ ] Require HTTPS outside development. Do not couple a deployment manifest to
      one exact mobile release.
- [ ] Use Runtime's common unauthenticated `/api/client/min-version` policy for
      required and recommended app-version floors. Keep Core's existing route
      temporarily for already-released clients.
- [ ] Validate all URLs, deployment links, package names, glasses model ids, and
      Entra authority/scopes.
- [ ] Reject `common`, `organizations`, personal Microsoft accounts, and any
      authority not pinned to the declared first-pilot tenant.
- [ ] Test that null Core never resolves to an embedded Mentra endpoint and the
      selected customer Runtime never falls back to Mentra Runtime.

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
- Add the well-known manifest route to the reduced Runtime HTTP profile
- Modify logout/reset utilities

- [ ] Preserve current Google, Apple, and email controls and add a visually
      separate Connect to a workspace action.
- [ ] Make consumer actions activate the embedded profile before auth.
- [ ] Ask for an organization address and normalize bare hostnames, homepage
      URLs, and complete well-known manifest URLs to the workspace origin.
- [ ] Fetch `/.well-known/mentra-deployment.json` directly from that origin.
- [ ] Discard pasted paths, queries, and fragments; reject credentials,
      non-HTTPS origins, invalid TLS, oversized responses, and cross-origin
      redirects.
- [ ] Require the configured Runtime URL to match the entered origin.
- [ ] Keep the fetched workspace pending through resolution, schema validation,
      and security-policy validation.
- [ ] Show display name, hostname, and Microsoft organization sign-in before
      activation, with technical details expandable.
- [ ] Provide Back and Cancel before activation. Neither may persist state or
      start providers.
- [ ] Provide Use a different workspace and Return to Mentra before login.
- [ ] Persist `source: "manual"`; do not implement QR, a Mentra directory, or
      managed-app configuration injection in v1.
- [ ] Cache the last valid manifest for disconnected boot and never fall back to
      the consumer profile after custom selection.
- [ ] Clear the cached manifest on workspace logout and return to the neutral
      Mentra/workspace landing screen, including after restart.

## Phase 2: Native Microsoft Entra authentication

### Task 1: Add deployment-scoped MSAL on Android and iOS

**Files:**

- Create `mobile/src/services/auth/DeploymentAuthProvider.ts`
- Add an Expo/native Microsoft Entra auth module for Android and iOS
- Create `mobile/src/services/auth/EntraAuthService.ts`
- Modify auth routing and account context
- Modify secure-storage and logout utilities
- Add unit, native integration, and end-to-end auth tests

- [ ] Initialize MSAL only after a `microsoft-entra` manifest is active.
- [ ] Put MSAL behind `DeploymentAuthProvider`; app navigation, Engine, Runtime
      clients, and miniapps must not import the Entra adapter directly.
- [ ] Configure it dynamically from the exact tenant authority and client id
      while using the official Mentra App's registered native redirect URI.
- [ ] Use Authorization Code + PKCE through the system browser or supported
      Microsoft broker.
- [ ] Persist only MSAL/account state in OS-protected storage, scoped by
      deployment id.
- [ ] Return a canonical workspace identity keyed by deployment, issuer, and
      provider subject. The Entra adapter derives its subject from verified
      `tid` plus `oid`; email remains display metadata only.
- [ ] Acquire the deployment's Runtime API scope for the selected account and
      refresh it silently.
- [ ] Silently acquire the ACS Teams delegated token for the same account when
      the native meeting capability needs it.
- [ ] Keep consumer Google/Apple/email bound to the embedded Mentra profile.
- [ ] Let the manifest select exactly one workspace auth adapter. Do not show an
      identity-provider picker or disabled "coming soon" providers after a
      workspace is selected.
- [ ] Do not create a Cloud V2/Core session for the call-focused workspace.
- [ ] Implement logout, disabled-user recovery, authority mismatch, token expiry,
      and deployment switching without credential crossover.
- [ ] Test assigned/unassigned users, wrong tenant, MFA, Conditional Access,
      cancelled login, revoked session, and broker/browser return on both
      platforms.

### Task 2: Authenticate Runtime directly with Entra

**Files:** Engine Runtime auth seam, Runtime verifier config, and deployment guide

- [ ] Wire the existing `auth.runtime.getToken` Cloud Client mode through the
      Mentra App/Engine production configuration.
- [ ] Validate exact Entra issuer, tenant, audience, signature, expiry, and
      configured Runtime API scope on every protected endpoint.
- [ ] Authorize only assigned users/groups defined by customer policy.
- [ ] Key server audit events by tenant id and object id; do not persist raw
      identity-provider tokens.
- [ ] Return actionable 401/403 responses without exposing token contents.
- [ ] Document the single-tenant public-client registration, official Android
      and iOS redirects, Enterprise Application assignment, Runtime API scope,
      and consent.

## Phase 3: Runtime-only Engine and bundled Mentra Call

### Task 1: Make REST-only Runtime startup supported in Engine

**Files:**

- Modify `mobile/modules/engine/src/engine.ts`
- Modify `mobile/modules/engine/src/services/CloudClientService.ts`
- Modify Engine startup services that currently assume cloud auth
- Modify `mobile/src/services/MantleManager.ts`
- Add local-only startup tests

- [ ] Construct the Cloud Client with no Core endpoint and the host-provided
      Runtime token callback.
- [ ] Expose Runtime REST capabilities without opening the Runtime WebSocket or
      starting cloud audio, reconnect alarms, reports, support-profile sync, or
      cloud registry synchronization.
- [ ] Continue Bluetooth, device hydration, pairing/reconnect, local settings,
      display, local miniapp runtime/launcher, phone stream coordination, ACS,
      and configured OTA.
- [ ] Replace the global Core-owned local-miniapp identity assumption with the
      verified deployment-scoped Entra identity.
- [ ] Do not expose a miniapp-backend token in the call-focused profile. Mentra Call
      uses host capabilities and has no required backend.
- [ ] Fail unavailable cloud-only miniapp APIs explicitly rather than retrying
      localhost or Mentra endpoints.
- [ ] Suppress cloud-disconnected UI/notifications in local-only mode.

### Task 2: Integrate, bundle, and constrain Mentra Call after native ACS lands

**Lane:** C — do not begin from current `dev` or duplicate the native branch.

**Files:**

- Sync the release-pinned Mentra Call package into `mobile/assets/miniapps/`
- Regenerate `mobile/src/generated/bundledMiniapps.ts`
- Modify bundled install/registry/launcher policy
- Integrate the merged Mentra Call ACS work in its external repository
- Add bundle and launch tests

- [ ] Bundle Mentra Call in the official app and approve it in the first
      customer manifest template.
- [ ] Apply `systemMiniapps.approvedPackageNamesOverride` to install, registry,
      menus, autostart, and primary system-miniapp launch surfaces. Do not make
      comprehensive blocking of secondary shared-screen routes a v1 gate.
- [ ] Remove the Mentra Call backend dependency from the ACS path.
- [ ] Keep the Miniapp SDK call request provider-neutral. `session.meeting` is
      the current spike shape, not a frozen API name or payload.
- [ ] Keep ACS/Entra credentials below the trusted host boundary; miniapp
      JavaScript receives no bearer token.
- [ ] Preserve existing Teams/ACS join, leave, mute, state, recovery, and
      incoming-audio behavior from `nicolo/acs-teams-v1`, replacing the WHEP
      source with the integrated SoftAP source.
- [ ] Present one primary Join Teams call action and accept an existing
      Microsoft 365 work/school Teams URL.
- [ ] Show clear SoftAP connection and recovery UX when the glasses-to-phone
      media source cannot start or is interrupted.
- [ ] Leave tears down the local media source and ACS call, confirms exit, and
      returns to Mentra Call home.
- [ ] Do not add meeting creation, calendar, invite, chat, Google Meet, Zoom, or
      public streaming-relay work to this integration task.

## Phase 4: Modular Runtime Services

### Task 1: Compose enabled Runtime modules in one process

**Files:** Runtime startup, API composition, provider validation, container,
Azure template, tests, and operator documentation

- [ ] Add an explicit positive allowlist: `RUNTIME_SERVICES=meetings` for the
      first enterprise template.
- [ ] Select provider implementations independently with
      `MEETING_PROVIDERS=acs-teams`; enabling a module must not implicitly select
      a vendor.
- [ ] Keep one Runtime binary, process, HTTP port, and container. Do not create a
      container or repository per module.
- [ ] Register routes and initialize providers only for enabled modules.
- [ ] Fail startup when an enabled module has missing or invalid required
      configuration. Do not infer enablement from API-key presence.
- [ ] Do not connect Redis, bind UDP, spawn audio workers, start ownership loops,
      or accept Runtime WebSockets when the real-time/audio module is disabled.
- [ ] Do not initialize storage/photos, maps, TTS, or speech providers when their
      modules are disabled.
- [ ] Serve the exact deployment manifest at the well-known path from a mounted
      release-matched file.
- [ ] Publish health/readiness that reports enabled-module configuration without
      disclosing secrets.

### Task 2: Add the Runtime meetings provider

**Files:** Runtime meetings API/provider, ACS Identity SDK integration,
server-side qualification harness, token/redaction tests, and Azure configuration

- [ ] Add an `acs-teams` provider behind the Runtime meetings capability.
- [ ] Require a valid Core-issued Runtime API bearer token for every credential
      request. An absent delegated token requests a guest credential.
- [ ] When a delegated Entra token is supplied, validate tenant, client/app id,
      object id, scopes, expiry, and that the subject matches the authenticated
      Runtime user. Reject an invalid supplied token instead of falling back to
      a guest.
- [ ] Exchange it with ACS `GetTokenForTeamsUser` using customer-owned ACS
      managed identity/RBAC where supported, with a rotated connection-string
      secret permitted for the first controlled deployment.
- [ ] Create or reuse an anonymous ACS communication user and issue a `voip`
      token when no delegated token is supplied.
- [ ] Return a short-lived guest or Teams-user ACS token, with the selected
      identity mode, in a stable response that Lane C can consume; do not add
      mobile/native integration in Lane A.
- [ ] Keep Entra and ACS bearer tokens out of miniapp messages, logs, errors, and
      diagnostics.
- [ ] Require ACS configuration at module startup. Require Entra tenant/client
      configuration only when the Teams-user exchange path is exercised; require
      no Cloudflare, MongoDB, Recall, speech, Store, or Mentra cloud variables.

## Phase 5: Reuse Entra for authenticated Teams identity

The existing native path proves raw media with a guest token. A Private
Deployment uses the employee Teams identity when a delegated token is available
and otherwise remains capable of joining as a guest. It reuses Phase 2; there is
no second interactive SSO screen.

**Lane:** C — begin only after the native ACS/media branch lands on `dev`.

### Task 1: Add host-owned ACS credential acquisition

**Files:** MSAL scope acquisition, native host/Engine call capability, Nicolo ACS
native module integration, tests, and admin guide

- [ ] Add delegated ACS `Teams.ManageCalls` and `Teams.ManageChats` permissions
      to the Entra registration and document admin consent/assignment.
- [ ] Silently acquire an ACS-scoped Entra token for the same cached MSAL account
      when available and send it only to the configured customer Runtime over
      TLS. A non-Entra identity, or an unavailable delegated token, requests a
      guest credential instead.
- [ ] Have the trusted host obtain and refresh the short-lived employee or guest
      ACS credential from Runtime; do not put it in the Miniapp SDK request.
- [ ] Treat `session.meeting.join` as the current spike shape. Finalize a
      provider-neutral Miniapp SDK capability only after the native lifecycle is
      stable.
- [ ] Confirm the Android and iOS Calling SDK agent construction required by a
      Teams-user token while retaining raw media.
- [ ] Test same-tenant and external meetings, employee roster identity, lobby
      policy, disabled user, token expiry/refresh, revoked consent, missing Teams
      license, and Conditional Access.

## Phase 6: Deployment policy, artifacts, and qualification

### Task 1: Enforce content, hardware, and egress policy

**Files:** Existing wallpaper/link/update/miniapp/pairing/telemetry call sites and
policy tests

- [ ] Use only `content.wallpaperUrls`; empty means no remote presets.
- [ ] Route privacy, terms, docs, support, store, and review actions through
      resolved fields. Do not add `externalLinks`.
- [ ] Apply the approved system-miniapp list to installation, registry, system
      miniapp catalogs and menus, autostart, and primary launch surfaces. The
      embedded Mentra profile uses `null`; the customer template pins Mentra Call
      and explicitly approved utilities. Secondary shell routes to shared
      built-in screens are not part of the v1 acceptance gate.
- [ ] Filter every pairing entry point with `glasses.allowedModelsOverride`;
      keep vendor behavior in model adapters and do not add AR99-specific
      schema. Allowing a model authorizes pairing, not public vendor traffic;
      vendor integrations without manifest-selected endpoints fail closed.
- [ ] Disable navigation, cloud speech, cloud reports, public store/registry, and
      any other unavailable integration in the call-focused template.
- [ ] Add an integration inventory test asserting every known network path is
      selected, disabled, or explicitly approved by the active profile.

### Task 2: Publish customer artifacts and guides

**Files:** Coordinated release scripts/workflows, Mintlify docs, Runtime deployment
templates, and runbooks

- [ ] Publish a release-matched call-focused deployment template.
- [x] Publish the existing Runtime image once through public GHCR with an
      immutable digest, signed SPDX SBOM and build provenance; mirror that exact
      digest into the Azure reference deployment with only `meetings` enabled.
- [ ] Publish customer-hostable Mentra Live OTA artifacts when OTA is enabled.
- [ ] Reuse the exact normal Android and iOS app artifacts; no customer build
      lane.
- [ ] Document Android APK/MDM and iOS App Store/Apple Business Manager
      distribution. State that workspace entry is manual in v1.
- [ ] Publish a Microsoft Entra guide for native app redirects, single-tenant
      authority, API permissions/scopes, assignment, consent, revocation, and
      troubleshooting.
- [ ] Publish an ACS Runtime guide that lists only the required meetings module
      and secret, supports rotation, and explains Teams-user identity.
- [ ] Document that restricted-network means customer-approved Microsoft and
      ACS/Teams egress, not zero internet.

### Task 3: Qualify the Mentra Azure reference deployment

**Files:** Mentra Azure environment and end-to-end test records

- [ ] Deploy one reduced Runtime process in Mentra's Azure account using Mentra's
      non-production Entra tenant and customer-style isolation.
- [ ] Use a customer-style ACS resource and secret store/managed identity.
- [ ] Do not deploy customer Core or use Mentra public Core/Runtime.
- [ ] Select the workspace using official Android and iOS Mentra App artifacts.
- [ ] Run Entra assignment, MFA, wrong-tenant, disabled-user, expiry, logout, and
      deployment-switch tests.
- [ ] Run Teams join, mute, incoming audio, SoftAP interruption/recovery, leave,
      and 30–60 minute soak tests on Android and iOS.
- [ ] At the Teams receiver, record observed resolution, frame rate, bitrate,
      and end-to-end latency; qualify the 1280x720 at 15 fps and less-than-two-
      second targets under the documented reference network.
- [ ] Verify join-only UX: pasted work Teams URL, SoftAP connection/recovery,
      call state, explicit leave confirmation, resource teardown, and return
      home.
- [ ] Run packet capture with Mentra public services blocked and fail on any
      unapproved destination.
- [ ] Re-run ordinary consumer release gates with the embedded Mentra profile.

## Suggested commit stages inside the Lane A implementation PR

1. Manifest types/resolver, landing screen, manual workspace flow, nullable
   Core/Runtime, and pre-network telemetry gating.
2. Provider-neutral auth contract plus native Entra adapter,
   deployment-scoped identity, secure logout, and Runtime API token provider.
3. Runtime module composition plus the meetings-only HTTP profile.
4. Runtime meetings/ACS guest issuance and Teams-user token exchange, exercised
   through a server-side qualification harness with no native/mobile changes.
5. OTA/content/hardware policy, Azure template, guides, and restricted-network
   qualification scaffolding.

Native ACS integration remains the separate Lane C PR after Nicolo's Lane B
lands. Do not add delegated Graph meeting creation to either V1 lane.

The narrowed call deployment avoids the largest previous work item: packaging
Core and every Runtime dependency. It still requires real mobile work—native
Entra login, Runtime-only Engine auth, modular Runtime boot, and secure ACS
credential ownership—but those changes form a reusable foundation for later
workspace profiles.

## Explicitly deferred Mentra Call follow-ons

These remain valid product directions but are not tasks or merge gates for this
implementation plan:

- Create a Teams meeting as the signed-in user with delegated Graph
  `OnlineMeetings.ReadWrite`; remove any shared licensed Graph service-account
  flow from an eventual enterprise creation path.
- Copy/share invite links, calendar discovery, chat, TTS of chat, custom display
  names, and additional in-call controls.
- Google Meet and Zoom enterprise qualification and their corresponding
  customer-controlled provider infrastructure.
- Public WHIP/WHEP or other cloud-relay media providers for the enterprise
  profile.

## Branch and dependency strategy

Do not build the entire effort on `nicolo/acs-teams-v1`. At the time of this
plan, that branch has no pull request, is 52 commits ahead and 108 commits behind
`dev`, and contains approximately 4,900 lines of native/media/API changes. It is
the source of the ACS media implementation, not the base for unrelated manifest,
auth, or Runtime work.

- Keep the design and the single Lane A manifest, Entra, Runtime-auth, and
  modular-Runtime implementation together in this PR from current `dev`; it
  does not depend on Nicolo's branch.
- Have Nicolo rebase or merge current `dev` into `nicolo/acs-teams-v1`, validate
  Android/iOS, and open its own focused PR for the native ACS/media capability.
- If native integration must proceed before that PR merges, create a narrowly
  scoped stacked branch from `nicolo/acs-teams-v1` and target that branch. Do not
  mix Runtime or deployment-manifest work into the stack.
- After the native ACS PR and this Lane A PR land, create the final
  integration PR from fresh `dev` and adapt the spike Miniapp SDK contract so
  credentials stay below the host boundary.
- PR #3743 is compatible but not a dependency. If its Store/Core split lands
  first, rebase normally; do not copy its tentative implementation or make this
  deployment wait for it.
