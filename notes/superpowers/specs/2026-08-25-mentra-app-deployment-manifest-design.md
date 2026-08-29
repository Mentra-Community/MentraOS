---
status: draft
owner: Mentra
---

# Mentra Enterprise Self-Hosted deployment design

## Outcome

The same official Mentra App binary can run against Mentra's public services or
as part of a Mentra Enterprise Self-Hosted deployment. A deployment manifest is
resolved before sign-in and selects the authentication, services, artifacts,
content, hardware catalog, and network-capable behavior for that workspace.

The first customer deployment is deliberately narrower than a self-hosted copy
of the complete MentraOS cloud. It supports the bundled Mentra Call miniapp,
Mentra Live, Microsoft Entra sign-in, and direct Microsoft Teams participation
through Azure Communication Services (ACS). It does not require customer-hosted
Cloud V2 Core or Runtime.

This is an operating mode of the Mentra App and Mentra Engine, not a customer
fork, branded build, or second release pipeline.

The v1 network posture is customer-controlled and restricted, not literally
air-gapped. The app must not contact Mentra's public Core, Runtime, telemetry,
artifact, content, or miniapp services after a self-hosted profile is active.
It may reach destinations explicitly approved by the deployment operator,
including the customer's Microsoft Entra tenant, ACS resource, Workspace
Gateway, and the configured WHIP/WHEP streaming provider.

## Terminology

- **Mentra Enterprise Self-Hosted** is the deployment offering.
- **Customer-hosted deployment** means its required server component runs in
  infrastructure controlled by the customer, including the customer's Azure or
  AWS account.
- **Workspace Gateway** is the small customer-hosted API required by the first
  Mentra Call deployment. It is not a repackaged full Core or Runtime.
- **Restricted-network deployment** describes the v1 network posture: only
  customer-approved destinations are reachable.
- **Air-gapped deployment** is reserved for a future zero-egress qualification
  profile.
- **On-premises deployment** is used only when the customer runs services in its
  own data center.

Do not use "private deployment" as the product or architecture name because it
does not identify who hosts the services.

## First supported deployment

The first Mentra Enterprise Self-Hosted deployment requires:

- The official Android and iOS Mentra App binaries from one coordinated release.
- The bundled, phone-hosted Mentra Call miniapp.
- Mentra Live as the only glasses model qualified for the first pilot.
- A customer workspace URL and deployment manifest reachable before sign-in.
- Native Microsoft Entra sign-in against the deployment operator's tenant.
- A customer-hosted Workspace Gateway.
- A customer-owned ACS resource.
- A customer-approved WHIP/WHEP streaming provider. The current
  `nicolo/acs-teams-v1` implementation uses Cloudflare Stream.
- Customer-hosted Mentra Live OTA artifacts if OTA is enabled for the pilot.
- No unapproved public-network access after app and device provisioning.

The initial media path is:

```text
Mentra Live camera
  -> WHIP
  -> customer-approved streaming provider
  -> WHEP
  -> Mentra App native decoder
  -> ACS raw outgoing media
  -> Microsoft Teams

Microsoft Teams
  -> ACS raw incoming audio
  -> Mentra App PCM playback
  -> glasses speakers
```

"Direct to Teams through ACS" means that the phone is the Teams participant and
there is no Recall bot. It does not mean the current implementation has no media
relay: Cloudflare remains between the glasses' WHIP publisher and the phone's
WHEP consumer until a direct glasses-to-phone transport is implemented.

### Why full Core and Runtime are not required

The first deployment does not need Core's consumer-account system, Supabase,
remote miniapp registry, reporting, public store, or general tenant management.
It also does not need Runtime's speech pipeline or general real-time miniapp
session. The only Runtime responsibility used by the current Mentra Call branch
is managed-stream allocation and status. That narrow function moves behind the
Workspace Gateway instead of forcing customers to deploy the complete Runtime.

The Mentra App therefore needs a supported cloud-session-disabled Engine mode:

- It does not construct or connect a Cloud Client.
- It does not request a Core token or Runtime token.
- It uses the verified Entra tenant id plus object id as the local user
  namespace, scoped again by `deploymentId`.
- It installs and launches only bundled local miniapps approved by the active
  manifest.
- Cloud-backed settings, reports, speech, registry synchronization, and remote
  miniapps are unavailable.
- Managed media requests are routed to the Workspace Gateway rather than to
  Runtime.

Core and Runtime URLs remain optional fields in the common manifest contract so
a later full-platform customer profile can configure them. They are explicitly
`null` in the first Mentra Call template. Missing or null service URLs must never
fall back to Mentra's public endpoints.

## Workspace Gateway

The Workspace Gateway is the only customer-hosted server package required by
the first deployment. It has a small, explicit contract:

```text
GET    /.well-known/mentra-deployment.json
POST   /api/media/streams
GET    /api/media/streams/:streamId
DELETE /api/media/streams/:streamId
POST   /api/communications/teams/guest-token
POST   /api/communications/teams/user-token      (later Teams-identity step)
```

An optional meeting-creation endpoint may be supplied, but the preferred future
flow creates a meeting on behalf of the signed-in user with delegated Microsoft
Graph permission rather than a shared service account.

The gateway:

- validates Microsoft Entra access tokens from the configured tenant and app
  registration;
- authorizes the user or assigned group before allocating resources;
- holds streaming-provider credentials and creates short-lived WHIP/WHEP
  resources;
- holds an ACS server credential, or uses Azure managed identity/RBAC, to mint or
  exchange short-lived ACS credentials;
- never receives the user's Microsoft password;
- does not require Supabase, MongoDB, Recall, Soniox, ElevenLabs, the Mentra
  Miniapp Store, or Mentra public infrastructure in the ACS-only profile.

The service should be delivered as a small container and an Azure reference
deployment. Configuration validation is profile-aware: it rejects missing ACS
or streaming credentials, but does not require environment variables for
disabled providers.

The existing Mentra Call backend already demonstrates ACS guest-token minting
and Teams meeting creation, while Cloud V2 Runtime demonstrates Cloudflare
managed-stream allocation. V1 extracts only these required responsibilities
behind the gateway contract. It must not package the existing backends with all
of their unrelated SaaS configuration.

## One configuration path

The application always consumes one typed deployment object. A new installation
does not need a deployment selected before it can render a local landing screen.

The landing screen keeps the normal Mentra account choices and adds one
visually separate workspace action:

```text
                         Mentra

                 [ Sign up with email ]
                 [ Continue with Google ]
                 [ Continue with Apple  ]   (iOS only)

              Already have an account? Log in

                  -------- or --------

                 [ Connect to a workspace ]
```

Google, Apple, or Email activates the embedded Mentra deployment before starting
the existing consumer authentication flow. Connect to a workspace opens a local
screen with Back, one URL field, and Continue:

```text
< Back

Workspace URL
https://mentra.example-corp.com

[ Continue ]
```

The workspace URL is the human-shareable HTTPS origin for the deployment. It is
not a raw JSON URL, Core URL, or Runtime URL. The app fetches:

```text
GET https://mentra.example-corp.com/.well-known/mentra-deployment.json
```

V1 requires `services.workspaceGatewayUrl` to have the same origin as the
entered workspace URL. Optional Core, Runtime, artifact, and content hosts may
be different when a future profile uses them.

Entering a workspace creates a candidate only. The app downloads, resolves, and
validates the manifest and exact `releaseIdentity`, then shows the deployment
display name, workspace hostname, and declared sign-in type. It persists and
activates the workspace only after the user confirms.

```text
< Cancel

Connect to Example Corp

Workspace: mentra.example-corp.com
Sign-in:   Microsoft organization account

[ Continue to Example Corp ]
[ View connection details ]
```

Back or Cancel returns to the ordinary Mentra landing screen without changing
endpoints or saving the candidate. A selected but unauthenticated workspace also
offers Use a different workspace and Return to Mentra. Returning clears the
selection and restores the local landing screen.

V1 supports manual workspace entry only. The selected workspace is restored on
subsequent boots. Enrollment records `source: "manual"`; a future MDM adapter can
supply the same origin and mark it enforced without changing manifest discovery
or validation. QR enrollment and a Mentra-hosted workspace directory are not in
v1.

HTTPS and the device trust store authenticate the workspace server. A device
administrator may install a private CA. V1 rejects URL credentials, query
strings, fragments, invalid TLS, oversized responses, and cross-origin
redirects. Manifest signing is not required initially.

## Microsoft Entra is the main workspace sign-in

The first call-focused profile uses `auth.mode: "microsoft-entra"`. The Mentra
App uses the native Microsoft Authentication Library (MSAL) on Android and iOS
with Authorization Code + PKCE. It does not open a customer Core callback and it
does not create a Cloud V2 session.

The manifest contains only public Entra configuration: the exact tenant
authority, native application client id, and requested scopes. It never contains
a client secret. The customer administrator registers the official Mentra App
package/bundle redirect URI in a single-tenant public-client app registration,
assigns allowed users or groups, and grants the permissions required by the
enabled call features.

The end-user flow is:

```text
Mentra App resolves workspace manifest
  -> app creates the deployment-scoped native MSAL client
  -> system browser or Microsoft broker opens the customer's Entra tenant
  -> user completes the organization's MFA and Conditional Access
  -> MSAL returns the verified account and caches tokens securely
  -> app derives local identity from verified tid + oid
  -> bundled Mentra Call becomes available
```

The customer's Workspace Gateway validates bearer tokens against that exact
tenant, issuer, audience, signature, expiry, and required scopes. The app and
gateway key users by stable tenant id plus object id, not mutable email.

### Reusing the same sign-in for Teams and ACS

Yes: the same Entra account and the same cached MSAL sign-in should become the
Teams identity. It is one interactive login, but it is not one literal bearer
token. MSAL silently obtains separate access tokens for different audiences and
scopes after the user has signed in:

```text
one Entra account/session
  |- ID token / account claims            -> Mentra App workspace identity
  |- Workspace Gateway access token       -> stream allocation and gateway API
  |- ACS Teams delegated access token     -> exchanged for ACS Teams-user token
  `- Microsoft Graph access token         -> optional /me/onlineMeetings creation
```

For authenticated Teams identity, the Entra registration receives the delegated
ACS permissions `Teams.ManageCalls` and `Teams.ManageChats`. Microsoft currently
requires both for Teams-user token exchange. The app silently acquires that
Entra token for the already-selected MSAL account. The customer-hosted gateway
then calls ACS `GetTokenForTeamsUser` using its ACS server credential and returns
the short-lived ACS Teams-user token to the native host. The ACS Calling SDK
joins as that employee, subject to the employee's Teams license and policies.

Microsoft recommends performing the exchange on a trusted backend because the
exchange request is signed with an ACS secret or Azure credential. The client
secret, ACS connection string, or managed-identity credential stays in the
gateway and is never placed in the app or manifest. See Microsoft's guides for
[Teams-user token exchange](https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/manage-teams-identity),
[required Entra permissions](https://learn.microsoft.com/en-us/azure/communication-services/concepts/interop/teams-user/azure-ad-api-permissions),
and [Teams interoperability](https://learn.microsoft.com/en-us/azure/communication-services/concepts/teams-interop).

The current `nicolo/acs-teams-v1` branch deliberately mints an anonymous ACS
communication user and passes its token through the miniapp. That joins Teams as
a guest and may encounter the meeting lobby. It does not use the employee's
Teams identity. This guest flow is acceptable as the fastest internal media
bring-up checkpoint, while Entra still gates access to the workspace. Claiming
"joins as your Teams account" requires the Teams-user exchange above and native
Android/iOS validation.

The app should own ACS credential acquisition. A bundled miniapp requests
`session.meeting.join(...)` without receiving or persisting an ACS token; the
host silently obtains the appropriate credential from the gateway. This removes
the token pass-through debt already identified in the ACS branch.

### Creating a Teams meeting

Joining an existing Teams URL needs no Microsoft Graph permission. If Mentra
Call must create the meeting, the preferred enterprise flow uses the same MSAL
account to request delegated `OnlineMeetings.ReadWrite` and calls
`POST /me/onlineMeetings`. This creates the meeting as the signed-in employee and
removes the current shared licensed service account plus app-only Graph secret.
Microsoft documents that delegated contract in
[Create onlineMeeting](https://learn.microsoft.com/en-us/graph/api/application-post-onlinemeetings?view=graph-rest-1.0).

The native host, not miniapp JavaScript, owns the Graph access token. A host
meeting-creation API may call Graph directly or proxy through the Workspace
Gateway. The miniapp receives only the resulting join URL.

## Manifest v1

The first call-focused template is illustrative:

```json
{
  "schemaVersion": 1,
  "deploymentId": "example-corp",
  "displayName": "Example Corp Mentra",
  "releaseIdentity": "3.1.0",
  "services": {
    "workspaceGatewayUrl": "https://mentra.example-corp.com",
    "coreUrl": null,
    "runtimeUrl": null
  },
  "auth": {
    "mode": "microsoft-entra",
    "authorityUrl": "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555",
    "clientId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "gatewayScopes": ["api://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/mentra.access"],
    "teamsScopes": [
      "https://auth.msft.communication.azure.com/Teams.ManageCalls",
      "https://auth.msft.communication.azure.com/Teams.ManageChats"
    ],
    "graphScopes": ["https://graph.microsoft.com/OnlineMeetings.ReadWrite"]
  },
  "artifacts": {
    "mentraLiveOtaManifestUrl": "https://mentra.example-corp.com/artifacts/mentra-live/version.json",
    "sttModelBaseUrl": null,
    "ttsModelBaseUrl": null
  },
  "appUpdates": {
    "mode": "managed",
    "storeUrls": {
      "android": null,
      "ios": null
    },
    "reviewUrls": {
      "android": null,
      "ios": null
    }
  },
  "content": {
    "wallpaperUrls": []
  },
  "links": {
    "privacyPolicyUrl": "https://mentra.example-corp.com/privacy",
    "termsOfServiceUrl": "https://mentra.example-corp.com/terms",
    "documentationUrl": "https://mentra.example-corp.com/docs",
    "supportUrl": "https://mentra.example-corp.com/support"
  },
  "systemMiniapps": {
    "approvedPackageNamesOverride": [
      "com.mentra.call",
      "com.mentra.settings"
    ]
  },
  "glasses": {
    "allowedModelsOverride": ["mentra-live"]
  },
  "features": {
    "cloudSession": false,
    "cloudSpeech": false,
    "onDeviceSpeech": false,
    "navigation": false
  },
  "telemetry": false
}
```

Rules:

- `deploymentId` namespaces credentials, token caches, local settings, and
  installed/running miniapp state.
- The resolved `services.workspaceGatewayUrl` origin equals the entered
  workspace origin in v1.
- `services.coreUrl` and `services.runtimeUrl` are nullable. Null means the
  service is absent; the app must not substitute embedded Mentra endpoints.
- `features.cloudSession: false` prevents Cloud Client construction, Core token
  synchronization, Runtime connection, cloud audio upload, remote miniapp
  registry sync, and cloud-backed reports/settings.
- `auth.mode: "microsoft-entra"` selects native MSAL. The authority must name an
  exact tenant for the first pilot; `common`, `organizations`, and consumer
  Microsoft accounts are rejected.
- Tenant authority, client id, and scopes are public configuration. Client
  credentials and provider secrets remain in the gateway's secret store.
- The embedded Mentra profile uses `auth.mode: "mentra-account"` and complete
  Core and Runtime URLs. It retains Google, Apple, email signup, login,
  verification, and recovery.
- `releaseIdentity` exactly matches the installed coordinated release.
- URLs are absolute HTTPS outside development.
- `content.wallpaperUrls` is the complete preset catalog. An empty array makes
  no wallpaper request.
- Legal and support URLs belong to the deployment. There is no blanket
  `externalLinks` switch.
- Store and review destinations belong to `appUpdates`. Null review URLs
  suppress review prompts. Managed mode shows administrator-provided update
  instructions instead of public-store actions.
- `systemMiniapps.approvedPackageNamesOverride` is either `null` or a complete
  allowlist. `null` uses the release's full built-in catalog, `[]` approves none,
  and a populated array approves only those package names. The embedded Mentra
  profile uses `null`; customer templates use an explicit release-pinned list.
- A non-approved system miniapp is not installed, registered, shown, autostarted,
  deep-linked, or launched even though its code may exist in the shared binary.
- `glasses.allowedModelsOverride` filters the pairing catalog by stable model
  id. It is not a pairing security boundary. Vendor-specific behavior remains
  behind glasses adapters; there is no `ar99VendorServices` field.
- The embedded Mentra profile is complete. A customer manifest recursively
  overrides it, arrays replace, and explicit null disables nullable values.
  Validation runs on the resolved profile. Service nulls are never re-filled by
  consumer defaults.
- `telemetry: false` prevents Sentry, PostHog, and Firebase Analytics from
  initializing.

## Boot sequence

```text
load local settings
  -> restore selected deployment, if present
  -> otherwise render local consumer/workspace landing screen
  -> consumer choice activates embedded Mentra deployment
  -> workspace choice fetches /.well-known/mentra-deployment.json
  -> resolve and validate candidate plus exact release identity
  -> show workspace and sign-in type for confirmation
  -> atomically persist immutable active deployment
  -> initialize telemetry only when enabled
  -> create the selected auth provider
  -> for Microsoft Entra, initialize deployment-scoped MSAL and sign in
  -> configure Engine from the active deployment
  -> when cloudSession is false, start local device + miniapp services only
  -> install/launch only approved bundled miniapps
```

Changing deployment is controlled logout:

1. Leave any call and stop Engine.
2. Clear the active deployment's MSAL/account state and local runtime identity.
3. Select, validate, and persist the new deployment.
4. Restart through the normal boot route.

Credentials and app state must not cross deployment ids.

## Engine and Mentra Call contract

Core and Runtime URL injection already exists through
`engine.configure({config: {coreUrl, runtimeUrl}})`. Extend the contract so
those services are optional and `cloudSession: false` is a real supported path,
not two fake localhost URLs.

Cloud-session-disabled startup still brings up:

- Bluetooth and glasses state;
- local pairing and reconnection;
- local settings required by glasses and bundled miniapps;
- the local miniapp registry, launcher, WebView/JS runtime, and display path;
- the phone stream coordinator;
- native ACS meeting services;
- OTA using the selected deployment artifact URL, when configured.

It does not start cloud audio uplink, Core-token sync, Runtime reconnect alarms,
preinstalled registry sync, support-profile sync, cloud reports, or cloud speech.

Mentra Call changes required by this deployment:

- Bundle the release-pinned Mentra Call package in the official Mentra App.
- Remove the build-time hard-coded Mentra Call backend URL from the ACS path.
- Route managed stream create/status/delete through the selected Workspace
  Gateway.
- Move ACS credential fetching into the trusted host; miniapp code receives no
  ACS or Entra token.
- Keep call state in the native host/phone runtime for ACS calls.
- Join existing Teams URLs without Graph.
- Expose optional host-owned meeting creation that returns only a join URL.
- Fail closed when a required gateway capability is absent.

The provider-neutral `session.meeting` API remains the correct miniapp contract.
Deployment and Microsoft-specific credential details stay below that boundary.

## Network-capable behavior

The deployment resolves before Sentry, PostHog, Firebase, AuthProvider, version
checks, Engine, or any other network-capable integration starts. Native Firebase
collection defaults off in the binary and is enabled only after the embedded
Mentra profile is selected.

In the first call-focused template:

- Mapbox/navigation is unavailable.
- Wallpaper requests use only the configured list.
- Legal, documentation, support, store, and review actions use resolved fields.
- The Mentra Miniapp Store and all non-approved miniapps are unavailable.
- Only Mentra Live is shown in pairing.
- Cloud speech is unavailable; Runtime and speech SaaS credentials are not
  required.
- The only call-media destinations are the selected streaming provider, the
  customer ACS resource, and Microsoft Teams endpoints.
- The official binary may still contain dormant optional vendor SDK code. A
  customer policy forbidding those bytes requires a separate native build and
  is outside this same-binary design.

## Distribution

The coordinated release remains the correlation mechanism for the Android app,
iOS app, Engine, Bluetooth SDK, OTA, hashes, and provenance.

Android customers may import the exact Mentra-signed APK into MDM. iOS uses the
normal App Store app through Apple Business Manager/MDM. V1 users enter the
workspace URL manually; native managed-app configuration injection is later.

Publish these release artifacts after implementation exists:

- `mentra-deployment-template-<identity>.json`
- the release-pinned bundled Mentra Call package
- the existing Mentra Live OTA bundle
- an Azure Workspace Gateway deployment template and administrator runbook

Do not create a second mobile build lane.

## MVP acceptance

The first Android-and-iOS call-focused pilot is complete when:

1. The official Mentra App selects a workspace by manual URL and activates only
   after manifest and release validation.
2. An assigned user signs in through the deployment's Microsoft Entra tenant,
   including MFA/Conditional Access, without Mentra Core or Supabase.
3. Engine starts with Core and Runtime absent, pairs Mentra Live, and launches
   the approved bundled Mentra Call miniapp without cloud connection alarms.
4. The Workspace Gateway allocates a WHIP/WHEP stream through the approved
   provider, and the glasses stream reaches the phone.
5. The phone joins a work/school Teams meeting through native ACS raw media on
   Android and iOS, with no Recall bot. The first media checkpoint may use the
   current guest ACS identity; a pilot requiring employee identity must also
   pass the Teams-user token exchange qualification.
6. Leaving, mute, stream recovery, incoming glasses audio, and a 30–60 minute
   device soak pass on both platforms within the native branch's supported
   limits.
7. Mentra public Core, Runtime, telemetry, artifacts, content, and miniapp
   services receive no traffic. Only the manifest-declared/customer-approved
   Microsoft, ACS, gateway, and streaming destinations are contacted.
8. The embedded Mentra profile still passes ordinary consumer release tests.

## Explicitly later

- Full-platform customer-hosted Core and Runtime, remote miniapps, cloud speech,
  synchronized settings, reports, and customer registry/store behavior.
- Authenticated Teams-user ACS identity if the first media pilot is accepted
  with guest identity. It reuses the same MSAL account; it is not a second login.
- Direct glasses-to-phone media transport that removes Cloudflare or another
  WHIP/WHEP relay.
- Streaming providers other than the first qualified Cloudflare path.
- Local email/password accounts, signup, verification, and recovery.
- Okta, Google, generic OIDC, SAML, and non-Entra identity providers.
- MDM workspace injection. Distribution through MDM is already supported; only
  automatic workspace configuration is deferred.
- Workspace discovery by email domain or organization code.
- Signed manifests, customer-managed manifest keys, and dynamic certificate
  pinning.
- Customer branding or bundle identifiers.
- Non-Mentra glasses restricted-network qualification, including AR99 vendor
  services.
