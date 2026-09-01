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
through Azure Communication Services (ACS). It uses a reduced, customer-hosted
configuration of the existing Runtime Services process. It does not require
customer-hosted Cloud V2 Core, Store, or a dedicated Mentra Call backend.

This is an operating mode of the Mentra App and Mentra Engine, not a customer
fork, branded build, or second release pipeline.

The v1 network posture is customer-controlled and restricted, not literally
air-gapped. The app must not contact Mentra's public Core, Runtime, telemetry,
artifact, content, or miniapp services after a self-hosted profile is active.
It may reach destinations explicitly approved by the deployment operator,
including the customer's Microsoft Entra tenant, customer Runtime, ACS resource,
and Microsoft Teams.

## Terminology

- **Mentra Enterprise Self-Hosted** is the deployment offering.
- **Customer-hosted deployment** means its required server component runs in
  infrastructure controlled by the customer, including the customer's Azure or
  AWS account.
- **Modular Runtime Services** is the existing Cloud V2 Runtime binary started
  with an explicit allowlist of service modules. The first deployment runs one
  HTTP-only process containing only the meeting-provider service. It is not a
  new gateway or a container per capability.
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
- One customer-hosted Runtime Services process with only `meetings` enabled.
- A customer-owned ACS resource.
- The direct SoftAP glasses-to-phone media transport integrated with the native
  ACS host. The existing Cloudflare/WHEP spike is not the enterprise media path.
- Customer-hosted Mentra Live OTA artifacts if OTA is enabled for the pilot.
- No unapproved public-network access after app and device provisioning.

The initial media path is:

```text
Mentra Live camera
  -> local SoftAP glasses-to-phone transport
  -> Mentra App native media host
  -> ACS raw outgoing media
  -> Microsoft Teams

Microsoft Teams
  -> ACS raw incoming audio
  -> Mentra App PCM playback
  -> glasses speakers
```

"Direct to Teams through ACS" means that the phone is the Teams participant,
there is no Recall bot, and the enterprise media path has no public streaming
relay between the glasses and phone.

## Mentra Call product slice and roadmap boundary

The older Mentra Call roadmap mixed three independent concerns under a single
V1/V2/V3 sequence. This deployment design does not inherit those version labels.
It tracks the concerns separately so enterprise work does not accidentally
rescope Nicolo's native ACS work or pull later Mentra Call features into the
first deployment.

| Concern | First integrated deployment | Later evolution |
|---|---|---|
| Product experience | Join an existing work/school Teams meeting by pasting its URL; one primary **Join Teams call** action; clear SoftAP connection, joining, in-call, failure, and leave states; leaving returns to the Mentra Call home screen | Create/invite/end meetings, calendar discovery, chat, custom display names, native sharing, and additional in-call controls |
| Media transport | Mentra Live sends video directly to the phone over the local SoftAP transport; the native phone host sends ACS raw media to Teams and returns incoming voice to the glasses | Additional local transport optimization and qualified media/audio modes |
| Identity and deployment | Nicolo's branch first proves the media path with an ACS guest identity; the enterprise integration replaces that credential source with the same employee Entra identity used to enter the workspace | Other IdPs, non-Entra deployments, and other meeting-provider identity models |
| Meeting providers | Microsoft 365 work/school Teams through ACS | Google Meet, Zoom, and any consumer Recall-backed compatibility remain separate Mentra Call roadmap work |

The first combined product slice therefore requires:

- Join an existing Microsoft 365 work/school Teams URL without Graph or calendar
  access.
- Target 1280x720 at 15 fps at the Teams receiver and less than two seconds of
  measured end-to-end video latency under the reference network. ACS raw-media
  formats are negotiation ceilings, so qualification records the observed
  receiver resolution, frame rate, bitrate, and latency rather than assuming
  the requested format was delivered.
- Show clear SoftAP connection and recovery UX when the local glasses-to-phone
  media link cannot start or is interrupted.
- Preserve one unambiguous outgoing microphone source. The current phone-
  microphone policy remains the baseline unless the integrated SoftAP media
  contract explicitly qualifies glasses microphone audio; remote Teams audio
  plays through the glasses without a competing second uplink.
- Provide an unambiguous Leave action, confirm that the call ended, tear down
  stream and ACS resources, and return to the Mentra Call home screen.
- Keep meeting creation, calendar integration, invitation UX, chat, Google Meet,
  and Zoom outside the first enterprise acceptance gate.
  Existing mute or recovery behavior already present on the native branch may
  ship and must not regress, but this effort does not add new in-call product
  controls.

The guest-media checkpoint and enterprise release intentionally have different
roster identity. The branch-local guest checkpoint may use the hard-coded
display name `Mentra Live`. The enterprise release joins with an ACS Teams-user
token and therefore appears as the signed-in employee's Microsoft work identity;
it must not attempt to override that identity with the guest display name.

This specification does not replace the broader Mentra Call product roadmap or
change the existing consumer Google Meet/Zoom behavior. It defines only the
Mentra Call capability consumed by the first Mentra Enterprise Self-Hosted
deployment.

### Why Core is not required and Runtime remains small

The first deployment does not need Core's consumer-account system, Supabase,
remote miniapp registry, reporting, Store, or general tenant management. The
tentative Store extraction in PR #3743 makes that boundary even narrower: Core
remains the identity/control plane and miniapp-token issuer while catalog,
publishing, review, artifacts, and Console behavior move to Store. This first
deployment needs neither product surface because its identity issuer is the
customer's Entra tenant and its approved miniapps are bundled locally.

Runtime still owns the trusted server half of the ACS identity capability. For
the first deployment that means only ACS Teams-user token exchange. It does not
sit in the media path or run Runtime's speech pipeline or real-time
audio/WebSocket session.

The Mentra App therefore needs a supported runtime-only Engine mode:

- It configures no Core endpoint and performs no Core token exchange.
- It obtains a Runtime API token from the active Entra/MSAL session and supplies
  it through the existing host-provided Runtime token seam.
- It uses Runtime REST capabilities without opening the Runtime WebSocket or
  starting cloud audio.
- It uses the verified Entra tenant id plus object id as the local user
  namespace, scoped again by `deploymentId`.
- It installs and launches only bundled local miniapps approved by the active
  manifest.
- Cloud-backed settings, reports, speech, registry synchronization, and remote
  miniapps are unavailable.
- Mentra Call requests the native-meeting host capability. The native host owns
  the local SoftAP media transport and does not call an app-specific backend for
  ACS mode.

Core and Runtime URLs remain independently optional in the common manifest
contract. Core is explicitly `null` and Runtime names the customer deployment in
the first Mentra Call template. Missing or null service URLs must never fall
back to Mentra's public endpoints.

## Modular Runtime Services

The first deployment uses the existing Runtime package and container image, not
a new service or image. One Runtime process exposes:

```text
GET    /.well-known/mentra-deployment.json
GET    /healthz
GET    /ready
GET    /api/client/min-version
POST   /api/meetings/acs/teams-user-token
```

The reduced Runtime:

- validates Runtime API access tokens directly against the configured Microsoft
  Entra issuer, JWKS, audience, tenant, signature, expiry, and scope;
- authorizes the user or assigned group before exchanging credentials;
- holds an ACS server credential, or uses Azure managed identity/RBAC, to mint or
  exchange short-lived ACS credentials;
- never receives the user's Microsoft password;
- does not require Supabase, MongoDB, Recall, Soniox, ElevenLabs, the Mentra
  Miniapp Store, or Mentra public infrastructure in the reduced profile.

Runtime service selection is an explicit positive allowlist, for example:

```text
RUNTIME_SERVICES=meetings
MEETING_PROVIDERS=acs-teams
```

This is boot composition inside one process, not one container per module. An
enabled module registers its routes, initializes only its provider, and validates
its required configuration at startup. Missing required configuration fails
startup with a precise error. A disabled module registers no routes, initializes
no dependencies, and requires no credentials. Service enablement must never be
inferred solely from the presence or absence of API keys.

The existing Runtime startup must be split so this profile does not connect to
Redis, bind UDP, spawn audio workers, start ownership loops, or accept Runtime
WebSockets. The meetings module adds the trusted ACS exchange used by the native
meeting host. The generic managed-stream module may remain available for other
MentraOS profiles, but it is disabled and requires no Cloudflare configuration
in the enterprise template.

## Ownership and merge boundary

The architecture above does not require the enterprise work to fork or rewrite
the native ACS/media implementation currently being developed on
`nicolo/acs-teams-v1`. The first implementation tranche starts from current
`dev` and is limited to foundations that have no semantic dependency on that
branch:

| Lane | Owner | Starting point | Exit condition |
|---|---|---|---|
| Enterprise/platform foundations | Alex | One implementation branch from current `dev` | Workspace resolution, Entra sign-in, Runtime-only Engine auth, meetings-only Runtime, and server-harness ACS Teams-user exchange work without touching the native ACS branch |
| Native Mentra Call/ACS media | Nicolo | `nicolo/acs-teams-v1`, rebased or merged with current `dev` by its owner | Existing Teams/ACS work is adapted to the direct SoftAP source and qualified on Android/iOS with audio, leave, and recovery |
| Product integration | Alex and Nicolo jointly | Fresh `dev` after both prerequisite lanes merge | Host-owned enterprise credentials replace miniapp token pass-through, the bundled Mentra Call UX invokes the agreed provider-neutral host capability, and the complete enterprise call passes qualification |

- deployment manifest types, resolution, persistence, workspace selection, and
  pre-network policy gating;
- native Microsoft Entra sign-in and deployment-scoped token acquisition;
- the generic Mentra App/Engine seam for a host-provided Runtime token with no
  Core endpoint;
- Runtime module composition and HTTP-only startup;
- direct Entra JWT verification by Runtime;
- the server-side ACS Teams-user exchange behind the Runtime meetings module;
- the Azure template, operator configuration, and server-side qualification
  harness for that reduced Runtime.

That tranche deliberately does not modify:

- `mobile/modules/acs-meeting`;
- native ACS audio/video policy or SoftAP media transport;
- the current Miniapp SDK meeting request or protocol messages;
- `LocalMiniappRuntime` meeting dispatch;
- ACS-specific `PhoneStreamCoordinator` behavior;
- glasses `captureAudio` transport work;
- the Mentra Call ACS controller or its current branch.

The server-side meetings endpoint can be qualified with a test client before it
is connected to the Mentra App. After the native ACS/media branch lands on
`dev`, a separate integration tranche connects the trusted native host to that
endpoint, removes credential pass-through from miniapp JavaScript, and finalizes
the provider-neutral Miniapp SDK call contract with the native implementation's
owner. The current API name and payload are not prerequisites for the unblocked
foundation work.

The merge sequence is explicit:

1. Land the design and enterprise/platform foundation together in this
   Alex-owned PR from current `dev`.
2. Nicolo lands the native ACS/media PR independently; Entra and deployment work
   are not prerequisites for that branch's guest-media checkpoint.
3. After both sets of prerequisites are on `dev`, open a fresh joint integration
   PR. Do not build the enterprise foundation on top of Nicolo's branch and do
   not retrofit the branch's Miniapp SDK spike from a parallel branch.
4. Pin and bundle the corresponding Mentra Call release only after the joint
   integration contract is stable.

The first tranche is complete when a customer-style Azure deployment can resolve
its manifest, sign a user in through Entra, authenticate directly to one reduced
Runtime process, allocate and clean up a managed stream, and complete an ACS
Teams-user token exchange from a server-side harness without Core, Redis, UDP,
audio workers, Runtime WebSockets, or changes to the native ACS branch. It is a
foundation milestone, not yet the end-to-end Teams-call MVP.

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

The first template requires the configured Runtime URL to have the same origin
as the entered workspace URL. Runtime can therefore serve the well-known
manifest itself, while an ingress may still serve static workspace content.
Optional Core, Store, artifact, and content hosts may be different when a future
profile uses them.

Entering a workspace creates a candidate only. The app downloads and validates
the manifest schema and security policy, then shows the deployment display name,
workspace hostname, and declared sign-in type. It persists and activates the
workspace only after the user confirms.

```text
< Cancel

Connect to Example Corp

Workspace: mentra.example-corp.com
Sign-in:   Microsoft organization account

[ Continue to Example Corp ]
[ View connection details ]
```

The manifest, not the end user, selects the authentication provider. The
workspace flow therefore does not show a provider picker or disabled
"coming soon" providers. After activation it renders one action derived from
the selected adapter, such as **Continue with Microsoft** for
`microsoft-entra`; a later OIDC workspace renders its own configured
organization-account action through the same screen.

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
does not create a Core-backed or real-time Runtime session.

This is direct Microsoft Entra authentication, not Supabase SSO and not a claim
of generic SSO support. The app keeps an auth-provider boundary so another
manifest mode can be added later, but V1 implements and qualifies only
`microsoft-entra`. The generic part of this tranche is the Engine seam that
accepts a deployment-provided Runtime token; it does not make every OIDC or SAML
provider work automatically.

`microsoft-entra` is a permanent adapter, not temporary scaffolding that an
existing deployment must later migrate away from. A future `oidc` adapter is an
additive manifest mode backed by a standards-based native OIDC client. Both
implement the same host contract:

```ts
interface WorkspaceIdentity {
  deploymentId: string
  issuer: string
  subject: string
  email?: string
}

interface WorkspaceTokenRequest {
  audience?: string
  scopes: string[]
}

interface DeploymentAuthProvider {
  signIn(): Promise<WorkspaceIdentity>
  getAccessToken(request: WorkspaceTokenRequest): Promise<string>
  signOut(): Promise<void>
}
```

App navigation, Engine, Runtime REST clients, and miniapps consume this contract
and never depend directly on MSAL. Credential storage is namespaced by
deployment and adapter. For Entra, the adapter maps verified tenant id plus
object id into the canonical issuer/subject identity. A future generic OIDC
adapter maps verified `iss` plus `sub`. Mutable email is display metadata only.

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
  -> Entra adapter maps verified tid + oid to WorkspaceIdentity
  -> bundled Mentra Call becomes available
```

The customer's Runtime validates bearer tokens against that exact tenant,
issuer, audience, signature, expiry, and required scopes. The app and Runtime
key users by the canonical deployment, issuer, and provider subject. For the
Entra adapter, the provider subject is derived from stable tenant id plus object
id, not mutable email.

### Reusing the same sign-in for Teams and ACS

Yes: the same Entra account and the same cached MSAL sign-in should become the
Teams identity. It is one interactive login, but it is not one literal bearer
token. MSAL silently obtains separate access tokens for different audiences and
scopes after the user has signed in:

```text
one Entra account/session
  |- ID token / account claims            -> Mentra App workspace identity
  |- Runtime API access token              -> managed streams and meeting services
  `- ACS Teams delegated access token     -> exchanged for ACS Teams-user token
```

For authenticated Teams identity, the Entra registration receives the delegated
ACS permissions `Teams.ManageCalls` and `Teams.ManageChats`. Microsoft currently
requires both for Teams-user token exchange. The app silently acquires that
Entra token for the already-selected MSAL account. The customer-hosted Runtime
then calls ACS `GetTokenForTeamsUser` using its ACS server credential and returns
the short-lived ACS Teams-user token to the native host. The ACS Calling SDK
joins as that employee, subject to the employee's Teams license and policies.

Microsoft recommends performing the exchange on a trusted backend because the
exchange request is signed with an ACS secret or Azure credential. The client
secret, ACS connection string, or managed-identity credential stays in Runtime
and is never placed in the app or manifest. See Microsoft's guides for
[Teams-user token exchange](https://learn.microsoft.com/en-us/azure/communication-services/quickstarts/manage-teams-identity),
[required Entra permissions](https://learn.microsoft.com/en-us/azure/communication-services/concepts/interop/teams-user/azure-ad-api-permissions),
and [Teams interoperability](https://learn.microsoft.com/en-us/azure/communication-services/concepts/teams-interop).

The current `nicolo/acs-teams-v1` branch mints an anonymous ACS communication
user and passes its token through the miniapp. That is useful for internal native
media bring-up, but it joins as a guest and is not the deployable enterprise
identity contract. The self-hosted v1 moves credential acquisition below the
miniapp boundary: the native host obtains the employee's ACS Teams-user token
from Runtime and never exposes Entra or ACS bearer tokens to miniapp JavaScript.

### Future: Creating a Teams meeting

Meeting creation is outside the first enterprise deployment. Joining an existing
Teams URL needs no Microsoft Graph permission, and the v1 manifest requests no
Graph scope. If a later Mentra Call release creates meetings, the preferred
enterprise flow uses the same MSAL account to request delegated
`OnlineMeetings.ReadWrite` and calls
`POST /me/onlineMeetings`. This creates the meeting as the signed-in employee and
removes the current shared licensed service account plus app-only Graph secret.
Microsoft documents that delegated contract in
[Create onlineMeeting](https://learn.microsoft.com/en-us/graph/api/application-post-onlinemeetings?view=graph-rest-1.0).

The native host, not miniapp JavaScript, owns the Graph access token. A host
meeting-creation API may call Graph directly or use the Runtime meetings module.
The miniapp receives only the resulting join URL.

## Manifest v1

The first call-focused template is illustrative:

```json
{
  "schemaVersion": 1,
  "deploymentId": "example-corp",
  "displayName": "Example Corp Mentra",
  "services": {
    "coreUrl": null,
    "runtimeUrl": "https://mentra.example-corp.com"
  },
  "auth": {
    "mode": "microsoft-entra",
    "authorityUrl": "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555",
    "clientId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "runtimeScopes": [
      "api://bbbbbbbb-cccc-dddd-eeee-ffffffffffff/mentra.runtime"
    ],
    "teamsScopes": [
      "https://auth.msft.communication.azure.com/Teams.ManageCalls",
      "https://auth.msft.communication.azure.com/Teams.ManageChats"
    ]
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
    "runtimeRealtimeSession": false,
    "managedStreams": true,
    "nativeMeetings": true,
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
- The resolved Runtime URL equals the entered workspace origin in v1. Runtime or
  its ingress serves the well-known manifest.
- `services.coreUrl` and `services.runtimeUrl` are nullable. Null means the
  service is absent; the app must not substitute embedded Mentra endpoints.
- `features.runtimeRealtimeSession: false` prevents the Runtime WebSocket,
  cloud audio upload, reconnect alarms, and subscription sync. Runtime REST
  capability calls remain available through `services.runtimeUrl`.
- `auth.mode: "microsoft-entra"` selects native MSAL. The authority must name an
  exact tenant for the first pilot; `common`, `organizations`, and consumer
  Microsoft accounts are rejected.
- Tenant authority, client id, and scopes are public configuration. Client
  credentials and provider secrets remain in Runtime's secret store.
- The embedded Mentra profile uses `auth.mode: "mentra-account"` and complete
  Core and Runtime URLs. It retains Google, Apple, email signup, login,
  verification, and recovery.
- Runtime serves the common unauthenticated `GET /api/client/min-version`
  policy. `required` blocks older clients, `recommended` permits continuation
  with an update prompt, and both default to `0.0.0`.
- Manifest `schemaVersion` and Runtime protocol/API versioning govern wire
  compatibility; deployment manifests do not pin one exact mobile release.
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
- `systemMiniapps.configuration` remains available for genuine package-specific
  runtime values, but ACS credentials, Runtime URLs, and Entra scopes are host
  configuration and are not delivered to Mentra Call.
- A non-approved system miniapp is not installed, registered, shown in the
  system miniapp catalog, autostarted, or launched from a primary system-miniapp
  surface even though its code may exist in the shared binary. Comprehensive
  blocking of every secondary shell route to a shared built-in screen is not a
  v1 requirement.
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
  -> resolve and validate the candidate manifest
  -> show workspace and sign-in type for confirmation
  -> atomically persist immutable active deployment
  -> initialize telemetry only when enabled
  -> fetch required/recommended client versions from the selected Runtime
  -> create the selected auth provider
  -> for Microsoft Entra, initialize deployment-scoped MSAL and sign in
  -> configure Engine from the active deployment
  -> supply Entra-backed Runtime token acquisition to Engine
  -> start Runtime REST capabilities without the real-time Runtime session
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
those services are independently optional and Runtime auth may come directly
from the host without Core. The underlying Cloud Client already supports an
optional Core endpoint plus `auth.runtime.getToken`; the Mentra App/Engine host
wiring must expose that production path.

Runtime-only, REST-only startup still brings up:

- Bluetooth and glasses state;
- local pairing and reconnection;
- local settings required by glasses and bundled miniapps;
- the local miniapp registry, launcher, WebView/JS runtime, and display path;
- the phone stream coordinator;
- native ACS meeting services;
- OTA using the selected deployment artifact URL, when configured.

It constructs the authenticated Runtime REST capability surface but does not
start cloud audio uplink, Core-token sync, the Runtime WebSocket, reconnect
alarms, preinstalled registry sync, support-profile sync, cloud reports, or
cloud speech.

The eventual Mentra Call/native-host integration requires:

- Bundle the release-pinned Mentra Call package in the official Mentra App.
- Keep high-rate SoftAP and ACS media entirely native. Runtime is used only for
  authenticated ACS credential exchange and is not a video relay.
- Keep the Miniapp SDK call provider-neutral. `session.meeting.join` is the
  current spike API, not a frozen name or payload.
- Remove provider credentials from the miniapp request. The trusted native host
  obtains and refreshes the ACS Teams-user token from Runtime.
- Keep call state in the native host/phone runtime for ACS calls.
- Join existing Teams URLs without Graph.
- Fail closed when a required Runtime capability or provider is absent.

A provider-neutral Miniapp SDK call capability remains the intended boundary,
but `session.meeting` is the current spike rather than a frozen final contract.
Deployment and Microsoft-specific credential details stay below whichever
request shape is finalized with the native implementation.

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
- Cloud speech is unavailable; the reduced Runtime starts no speech module and
  requires no speech SaaS credentials.
- The only remote call-media destinations are the customer ACS resource and
  Microsoft Teams endpoints; glasses-to-phone traffic remains local over SoftAP.
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
- the existing Runtime image plus an Azure template and administrator runbook
  for its `meetings` module set

Do not create a second mobile build lane.

## MVP acceptance

The first Android-and-iOS call-focused pilot is complete when:

1. The official Mentra App selects a workspace by manual URL and activates only
   after manifest and release validation.
2. An assigned user signs in through the deployment's Microsoft Entra tenant,
   including MFA/Conditional Access, without Mentra Core or Supabase.
3. Engine starts without Core, authenticates directly to the customer Runtime,
   pairs Mentra Live, and launches the approved bundled Mentra Call miniapp
   without opening a Runtime WebSocket or raising cloud connection alarms.
4. Mentra Call presents one primary join action, accepts an existing work/school
   Teams URL, shows clear SoftAP connection/recovery UX, and requires no calendar
   or meeting-creation permission.
5. Mentra Live sends media directly to the phone over SoftAP without a public
   relay, and the customer Runtime exposes no managed-stream route or Cloudflare
   credential.
6. The phone joins a work/school Teams meeting through native ACS raw media on
   Android and iOS, with no Recall bot, using the same employee identity that
   signed into the workspace through Entra.
7. The Teams receiver observes the 1280x720 at 15 fps target and less than two
   seconds of end-to-end video latency under the documented reference network.
   Qualification records negotiated and observed media rather than treating the
   requested ACS format as a guarantee.
8. Leaving, shipped mute behavior, stream recovery, incoming glasses audio, and
   a 30–60 minute device soak pass on both platforms within the native branch's
   supported limits. Leave tears down resources, confirms exit, and returns to
   the Mentra Call home screen.
9. Mentra public Core, Runtime, telemetry, artifacts, content, and miniapp
   services receive no traffic. Only the manifest-declared/customer-approved
   customer Runtime, Microsoft, ACS, and streaming destinations are
   contacted.
10. The embedded Mentra profile still passes ordinary consumer release tests.

## Explicitly later

- Customer-hosted Core, remote miniapps, Core-minted miniapp backend tokens,
  cloud speech, synchronized settings, reports, and customer Store behavior.
- Meeting creation, Graph `OnlineMeetings.ReadWrite`, calendar integration,
  invitations/native sharing, chat, and custom meeting display names.
- Enterprise-qualified Google Meet and Zoom paths. Existing consumer-provider
  behavior is not changed by this deployment work.
- Public WHIP/WHEP relay providers for the enterprise profile.
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
