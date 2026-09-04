---
status: draft
owner: Mentra
---

# Mentra Private Deployment design

## Outcome

The same official Mentra App binary can run against Mentra's public services or
as part of a Mentra Private Deployment. A deployment manifest is
resolved before sign-in and selects the authentication, services, artifacts,
content, hardware catalog, and network-capable behavior for that workspace.

The first customer deployment is deliberately narrower than a customer-hosted
copy of the complete MentraOS cloud. It supports the bundled Mentra Call miniapp,
Mentra Live, Microsoft Entra sign-in, and direct Microsoft Teams participation
through Azure Communication Services (ACS). It deploys the existing Cloud V2
Core and Runtime as two customer-hosted processes from one coordinated Mentra
Cloud image. Core owns workspace identity, sessions, Runtime-token minting, and
miniapp-token minting. Runtime runs only the services selected for that
deployment. The first template does not require Store or a dedicated Mentra Call
backend.

This is an operating mode of the Mentra App and Mentra Engine, not a customer
fork, branded build, or second release pipeline.

The v1 network posture is customer-controlled and restricted, not literally
air-gapped. The app must not contact Mentra's public Core, Runtime, telemetry,
artifact, content, or miniapp services after a Private Deployment profile is
active. It may reach destinations explicitly approved by the deployment
operator, including the customer's Microsoft Entra tenant, customer Runtime,
customer Core, ACS resource, and Microsoft Teams.

## Terminology

- **Mentra Private Deployment** is the deployment offering.
- **Customer-hosted deployment** means its required server components run in
  infrastructure controlled by the customer, including the customer's Azure or
  AWS account.
- **Mentra Cloud image** is the public coordinated OCI artifact at
  `ghcr.io/mentra-community/mentra-cloud`. It contains the existing Cloud V2
  packages. The deployment starts Core and Runtime as separate services from
  the same immutable image digest; it does not combine them into one process.
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

Use **customer-hosted** to describe ownership of the server components and
**restricted-network** to describe the permitted network posture. Do not call
this profile air-gapped or on-premises unless it meets those stricter meanings.

## First supported deployment

The first Mentra Private Deployment requires:

- The official Android and iOS Mentra App binaries from one coordinated release.
- The bundled, phone-hosted Mentra Call miniapp.
- Mentra Live as the only glasses model qualified for the first pilot.
- A customer workspace URL and deployment manifest reachable before sign-in.
- Native Microsoft Entra sign-in against the deployment operator's tenant.
- One customer-hosted Core process and Mongo-compatible persistent database.
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

| Concern                 | First integrated deployment                                                                                                                                                                                                 | Later evolution                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Product experience      | Join an existing work/school Teams meeting by pasting its URL; one primary **Join Teams call** action; clear SoftAP connection, joining, in-call, failure, and leave states; leaving returns to the Mentra Call home screen | Create/invite/end meetings, calendar discovery, chat, custom display names, native sharing, and additional in-call controls |
| Media transport         | Mentra Live sends video directly to the phone over the local SoftAP transport; the native phone host sends ACS raw media to Teams and returns incoming voice to the glasses                                                 | Additional local transport optimization and qualified media/audio modes                                                     |
| Identity and deployment | Nicolo's branch first proves the media path with an ACS guest identity; the enterprise integration replaces that credential source with the same employee Entra identity used to enter the workspace                        | Other IdPs, non-Entra deployments, and other meeting-provider identity models                                               |
| Meeting providers       | Microsoft 365 work/school Teams through ACS                                                                                                                                                                                 | Google Meet, Zoom, and any consumer Recall-backed compatibility remain separate Mentra Call roadmap work                    |

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
Mentra Call capability consumed by the first Mentra Private Deployment.

### Why Core is required and the deployment remains small

Customer deployments will need miniapps with authenticated backends. Core is
therefore part of the first supported Private Deployment rather than a later
identity migration. It validates the customer's OIDC identity, creates the
stable Mentra user and session, mints short-lived Runtime tokens, and mints
package-scoped miniapp tokens. This keeps provider identity out of ordinary
Runtime ownership and gives the existing Miniapp SDK backend-auth contract one
durable issuer from the first deployment.

The first deployment still does not use Core's consumer-account system,
Supabase, reporting, Store, or general tenant-management UI. It does not depend
on a future Store extraction. Private Deployment clients use only the workspace
identity surface described below; unused Core integrations remain unconfigured
and must not initiate outbound connections merely because their code is present
in the image. V1 does not add a Core module system or `CORE_SERVICES` switch.

Runtime still owns the trusted server half of the ACS identity capability. For
the first deployment that means only ACS Teams-user token exchange. It does not
sit in the media path or run Runtime's speech pipeline or real-time
audio/WebSocket session.

The Mentra App uses the existing Core-backed Engine shape:

- MSAL obtains a customer-Core session token for the selected account.
- The Cloud Client exchanges that OIDC token at customer Core, persists the
  rotated Core refresh token in deployment-scoped secure storage, and obtains a
  short-lived Core-issued Runtime token.
- It uses Runtime REST capabilities without opening the Runtime WebSocket or
  starting cloud audio.
- Core's opaque `mentraUserId` is the normal user namespace. Verified upstream
  identity is carried separately only for provider integrations that require it.
- It installs and launches only bundled SYSTEM miniapps and manifest-managed
  userland miniapps approved by the active manifest.
- Core-minted miniapp backend auth is available. Reports, speech, registry
  synchronization, and Store discovery remain unavailable in the first
  template.
- Mentra Call requests the native-meeting host capability. The native host owns
  the local SoftAP media transport and does not call an app-specific backend for
  ACS mode.

Core and Runtime URLs remain independently nullable in the common manifest
contract, but the first Private Deployment template requires both. Missing or
null service URLs must never fall back to Mentra's public endpoints.

Core and Runtime remain separate processes because Core holds persistent
identity state and signing keys while Runtime handles higher-volume device and
provider capabilities. They are delivered and deployed together as one stack,
not combined into one server.

## Customer-hosted Core

Private Deployment runs the ordinary Core process from the coordinated release.
V1 does not introduce `CORE_SERVICES`, a private Core fork, or another Core image.
When no consumer account, reporting, portal, or internal-administration client
calls those routes, their lazily configured integrations remain unused. The
customer deployment supplies only the dependencies exercised by workspace
identity:

- a Mongo-compatible persistent database;
- a persistent refresh-token pepper;
- persistent access/Runtime and miniapp signing keys;
- the deployment-unique Core issuer;
- one or more explicitly trusted OIDC provider configurations; and
- its canonical HTTPS origin.

Private Core sets one deployment-wide issuer, for example:

```text
CLOUD_CORE_ISSUER=https://core.mentra.example-corp.com
```

Core uses that value for its access, Runtime, and miniapp token families unless
an existing token-family-specific compatibility override is set. Mentra Cloud
leaves it unset and retains `cloud-core`. This gives the customer one durable
issuer to configure in Runtime and miniapp backends rather than three unrelated
issuer values.

The first workspace flow uses:

```text
GET  /healthz
GET  /ready
GET  /.well-known/jwks.json
POST /api/client/auth/exchange
POST /api/client/auth/refresh
POST /api/client/auth/revoke
POST /api/client/auth/runtime-token
POST /api/client/auth/miniapp-token
```

`revoke` is the provider-neutral Core-session logout endpoint. Workspace logout
revokes the Core refresh session, clears deployment-scoped client credentials,
signs out of the selected auth provider, and clears the selected deployment as
specified below. It does not call Mentra consumer account routes.

The customer may run more than one Core replica against the same database and
keys. Signing keys must never be generated independently at replica startup.

### One image, two processes

The coordinated release publishes one public image:

```text
ghcr.io/mentra-community/mentra-cloud@sha256:<digest>
```

The customer pins that immutable digest and starts it twice with separate
commands, configuration, secrets, network policy, and scaling:

| Service | Command | Required service selection |
| ------- | ------- | -------------------------- |
| Core | `bun packages/core/src/index.ts` | None; Core starts with its existing behavior |
| Runtime | `bun packages/runtime/src/index.ts` | `RUNTIME_SERVICES=meetings` for the first template |

This is one release artifact, not one combined Core/Runtime process. Core alone
receives the database connection, refresh-token pepper, and private token-signing
keys. Runtime receives only the public material required to verify Core-issued
tokens plus its own ACS credentials. An SBOM and build-provenance attestation
cover the complete `mentra-cloud` image filesystem, including every Cloud V2
package present in that digest; runtime service selection controls what starts,
not what the SBOM describes.

## Modular Runtime Services

The first deployment starts the existing Runtime package from the coordinated
Mentra Cloud image. One Runtime process exposes:

```text
GET    /.well-known/mentra-deployment.json
GET    /healthz
GET    /ready
GET    /api/client/min-version
POST   /api/meetings/acs/teams-user-token
```

The reduced Runtime:

- validates short-lived Runtime API tokens issued by the customer Core;
- authorizes the user or assigned group before exchanging credentials;
- holds an ACS server credential, or uses Azure managed identity/RBAC, to mint or
  exchange short-lived ACS credentials;
- never receives the user's Microsoft password;
- does not itself require Supabase, MongoDB, Recall, Soniox, ElevenLabs, the
  Mentra Miniapp Store, or Mentra public infrastructure in the reduced profile.

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

| Lane                            | Owner                   | Starting point                                                           | Exit condition                                                                                                                                                                                              |
| ------------------------------- | ----------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enterprise/platform foundations | Alex                    | One implementation branch from current `dev`                             | Workspace resolution, Entra sign-in, Core-backed Engine auth, customer-hosted Core, meetings-only Runtime, and server-harness ACS Teams-user exchange work without touching the native ACS branch           |
| Native Mentra Call/ACS media    | Nicolo                  | `nicolo/acs-teams-v1`, rebased or merged with current `dev` by its owner | Existing Teams/ACS work is adapted to the direct SoftAP source and qualified on Android/iOS with audio, leave, and recovery                                                                                 |
| Product integration             | Alex and Nicolo jointly | Fresh `dev` after both prerequisite lanes merge                          | Host-owned enterprise credentials replace miniapp token pass-through, the bundled Mentra Call UX invokes the agreed provider-neutral host capability, and the complete enterprise call passes qualification |

- deployment manifest types, resolution, persistence, workspace selection, and
  pre-network policy gating;
- native Microsoft Entra sign-in and deployment-scoped token acquisition;
- generic OIDC verification and exchange at customer Core;
- Core-backed Mentra App/Engine authentication and deployment-scoped token
  storage;
- Core-issued Runtime tokens carrying the signed federated-identity binding
  required by provider integrations;
- Core-minted package-scoped miniapp tokens and customer-Core JWKS discovery;
- package-scoped manifest configuration through Engine and the Mentra Miniapp
  SDK, independent of how the package was installed;
- Runtime module composition and HTTP-only startup;
- the server-side ACS Teams-user exchange behind the Runtime meetings module;
- the Azure template, Mongo-compatible persistence, persistent signing keys,
  operator configuration, and server-side qualification harness for Core plus
  the reduced Runtime.

That tranche deliberately does not modify:

- `mobile/modules/acs-meeting`;
- native ACS audio/video policy or SoftAP media transport;
- the current Miniapp SDK meeting request or protocol messages;
- `LocalMiniappRuntime` meeting dispatch;
- ACS-specific `PhoneStreamCoordinator` behavior;
- glasses `captureAudio` transport work;
- the Mentra Call ACS controller or its current branch.

The generic `session.configuration` path belongs to the Alex-owned foundation
and can land without Nicolo's branch. Mentra Call's consumption of
`backendUrl` belongs to the later Mentra Call integration change, because it
touches that miniapp's provider controller but does not change the native media
contract.

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
its manifest, sign a user in through Entra, exchange that identity at customer
Core, obtain a Core-issued Runtime token, mint and verify a package-scoped
miniapp token, and complete an ACS Teams-user token exchange from a server-side
harness without Redis, UDP, audio workers, Runtime WebSockets, or changes to the
native ACS branch. It is a foundation milestone, not yet the end-to-end
Teams-call MVP.

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
Core is required but may use a different customer-controlled origin. Store,
artifact, and content hosts may also be different when enabled.

Entering a workspace creates a candidate only. The app downloads and validates
the manifest schema and security policy, then shows the deployment display name,
workspace hostname, and declared sign-in type. It persists and activates the
workspace only after the user confirms.

```text
< Back

Connect to Example Corp

Workspace: mentra.example-corp.com
Sign-in:   Microsoft organization account

[ Continue ]
```

The manifest, not the end user, selects the authentication provider. The
workspace flow therefore does not show a provider picker or disabled
"coming soon" providers. After activation it renders one action derived from
the selected adapter, such as **Continue with Microsoft** for
`microsoft-entra`; a later OIDC workspace renders its own configured
organization-account action through the same screen.

Back returns to the ordinary Mentra landing screen without changing endpoints
or saving the candidate. A selected but unauthenticated workspace also
offers Use a different workspace and Return to Mentra. Returning clears the
selection and restores the local landing screen.

V1 supports manual workspace entry only. The selected workspace is restored on
subsequent boots. Enrollment records `source: "manual"`; a future MDM adapter can
supply the same origin and mark it enforced without changing manifest discovery
or validation. QR enrollment and a Mentra-hosted workspace directory are not in
v1.

HTTPS and the device trust store authenticate the workspace server. A device
administrator may install a private CA. The end-user field accepts a bare
hostname, homepage URL, or complete well-known manifest URL and derives the
workspace origin by discarding any path, query, or fragment. V1 rejects URL
credentials, non-HTTPS origins, invalid TLS, oversized responses, and
cross-origin redirects. Manifest signing is not required initially.

## Microsoft Entra is the main workspace sign-in

The first call-focused profile uses `auth.mode: "microsoft-entra"`. The Mentra
App uses the native Microsoft Authentication Library (MSAL) on Android and iOS
with Authorization Code + PKCE. MSAL obtains a token for the customer Core's
session scope; the app exchanges it at Core for a deployment-scoped Core
session. Core never receives the employee's Microsoft password and does not
host the Entra login UI.

Microsoft Entra is an OIDC provider. Core uses one generic OIDC verifier for
Entra and future standards-compatible providers. The configured
`providerKind: "microsoft-entra"` is capability metadata, not a separate token
protocol: it tells Runtime that the verified upstream identity has Microsoft
`oid`/`tid` semantics and may be bound to an ACS Teams token. Generic OIDC
identities must not be inferred to be Entra from an email, issuer substring, or
claim shape.

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

Core configures each accepted identity provider explicitly. The first reference
provider is semantically:

```json
{
  "id": "workforce",
  "protocol": "oidc",
  "providerKind": "microsoft-entra",
  "issuer": "https://login.microsoftonline.com/<entra-tenant-id>/v2.0",
  "jwksUrl": "https://login.microsoftonline.com/<entra-tenant-id>/discovery/v2.0/keys",
  "audience": "<core-api-client-id>",
  "subjectClaim": "oid",
  "directoryTenantClaim": "tid",
  "requiredScopes": ["mentra.session"],
  "allowedClientIds": ["<mobile-client-id>"]
}
```

`id` is a stable deployment-local provider identifier. `protocol` selects the
generic verifier. `providerKind` enables an explicit provider integration.
Core's durable identity key is the deployment tenant plus provider id plus the
verified provider subject; it never uses mutable email. For Entra the provider
subject is `oid`, not the audience-dependent OIDC `sub`.

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
  -> MSAL returns the verified account and customer-Core session token
  -> customer Core verifies issuer, key, audience, client, scope, tid, and oid
  -> Core creates/restores the stable Mentra user and Core session
  -> Core mints the short-lived Runtime token
  -> bundled Mentra Call becomes available
```

The customer's Runtime trusts the customer Core as its ordinary session-token
issuer. Runtime keys normal ownership and media state by the opaque Mentra user
id, not by an Entra object id.

### Core-issued Runtime identity

Core-issued Runtime tokens carry the stable Mentra identity plus a narrowly
scoped, signed copy of the verified upstream identity for integrations that
require it:

```json
{
  "iss": "https://core.mentra.example-corp.com",
  "aud": "cloud-runtime",
  "sub": "mu_01...",
  "tenant_id": "example-corp",
  "session_id": "sess_01...",
  "federated_identity": {
    "provider_id": "workforce",
    "provider_kind": "microsoft-entra",
    "issuer": "https://login.microsoftonline.com/<tenant>/v2.0",
    "subject": "<entra-oid>",
    "directory_tenant_id": "<entra-tid>"
  }
}
```

The deployment tenant id and the Entra directory tenant id are distinct
namespaces. `sub` remains the only identifier used for ordinary Runtime
ownership. Runtime never guesses the provider kind. The ACS provider accepts
the separate Teams token only when `provider_kind` is `microsoft-entra`, then
requires the Teams token's `oid` and `tid` to match the signed federated
identity, its issuer to match the configured directory, its `azp`/`appid` to
match the approved mobile client, and all required Teams scopes to be present.
A generic OIDC identity cannot use this path without an explicit account-linking
contract.

Miniapp tokens deliberately omit `federated_identity`. Miniapps receive only an
opaque Mentra user id, the deployment tenant, their package audience, and token
metadata.

### Reusing the same sign-in for Teams and ACS

Yes: the same Entra account and the same cached MSAL sign-in should become the
Teams identity. It is one interactive login, but it is not one literal bearer
token. MSAL silently obtains separate access tokens for different audiences and
scopes after the user has signed in:

```text
one Entra account/session
  |- customer-Core session access token   -> exchanged for a Core session
  |- Core-issued Runtime token             -> Runtime capabilities
  `- ACS Teams delegated access token     -> exchanged for ACS Teams-user token
```

For authenticated Teams identity, the Entra registration receives the delegated
ACS permissions `Teams.ManageCalls` and `Teams.ManageChats`. Microsoft currently
requires both for Teams-user token exchange. The app silently acquires that
Entra token for the already-selected MSAL account. The request to customer
Runtime is authorized by the separate Core-issued Runtime token. Runtime binds
the two identities as specified above, then calls ACS `GetTokenForTeamsUser`
using its ACS server credential and returns the short-lived ACS Teams-user token
to the native host. The ACS Calling SDK joins as that employee, subject to the
employee's Teams license and policies.

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
identity contract. The Private Deployment v1 moves credential acquisition below
the miniapp boundary: the native host obtains the employee's ACS Teams-user
token from Runtime and never exposes Entra or ACS bearer tokens to miniapp
JavaScript.

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
  "branding": {
    "logoUrls": {
      "light": "https://mentra.example-corp.com/branding/logo-light.png",
      "dark": "https://mentra.example-corp.com/branding/logo-dark.png"
    }
  },
  "services": {
    "coreUrl": "https://core.mentra.example-corp.com",
    "runtimeUrl": "https://mentra.example-corp.com"
  },
  "auth": {
    "mode": "microsoft-entra",
    "authorityUrl": "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555",
    "clientId": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    "sessionScopes": ["api://bbbbbbbb-cccc-dddd-eeee-ffffffffffff/mentra.session"],
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
    "approvedPackageNamesOverride": ["com.mentra.settings"]
  },
  "miniapps": {
    "managed": [
      {
        "packageName": "com.example.remoteassist",
        "version": "1.2.0",
        "bundleUrl": "https://mentra.example-corp.com/miniapps/remoteassist-1.2.0.zip",
        "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
      }
    ],
    "configuration": {
      "com.example.remoteassist": {
        "backendUrl": "https://mentra.example-corp.com/miniapps/remoteassist/api"
      }
    }
  },
  "glasses": {
    "allowedModelsOverride": ["mentra-live"]
  },
  "features": {
    "runtimeRealtimeSession": false,
    "managedStreams": false,
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
- `branding` is optional. When present, both PNG logo variants are required and
  must use the workspace origin. `light` is rendered on the app's light
  background and `dark` on its dark background, so transparent PNGs are
  recommended; the resolver validates the URL origin and Runtime validates the
  PNG MIME type, neither checks alpha. A deployment may use the same PNG URL
  for both. A failed or omitted logo falls back to the organization
  icon and `displayName`; branding never blocks enrollment or sign-in.
- The resolved Runtime URL equals the entered workspace origin in v1. Runtime or
  its ingress serves the well-known manifest.
- `services.coreUrl` and `services.runtimeUrl` are nullable in the common
  schema. The first Private Deployment requires both. Null means the service is
  absent; the app must not substitute embedded Mentra endpoints.
- `features.runtimeRealtimeSession: false` prevents the Runtime WebSocket,
  cloud audio upload, reconnect alarms, and subscription sync. Runtime REST
  capability calls remain available through `services.runtimeUrl`.
- `auth.mode: "microsoft-entra"` selects native MSAL. The authority must name an
  exact tenant for the first pilot; `common`, `organizations`, and consumer
  Microsoft accounts are rejected.
- Tenant authority, client id, and scopes are public configuration. Client
  credentials and provider secrets remain in the customer deployment's secret
  store.
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
- Approval by package name is necessary but not sufficient for SYSTEM
  authority. The Mentra App keeps a private host list of SYSTEM package names
  (`SYSTEM_MINIAPP_PACKAGE_SET` in `LocalMiniappRuntime`) and grants host-only capabilities
  such as inter-miniapp control only when the package is on that list, is
  approved by the active manifest, and the installed release's recorded source
  is `bundled_asset` (or it is an offline built-in). A downloaded, dev-snapshot,
  or manifest-managed copy that reuses an approved package name runs without
  SYSTEM authority. Engine's install policy applies the same rule: a
  workspace-approved SYSTEM package is allowed only from a `bundled_asset`
  release, and any other local release must match a `miniapps.managed` entry by
  package, version, digest, deployment id, and origin.
- ACS credentials, Core/Runtime URLs, and Entra scopes are host configuration.
  Provider credentials are not delivered to Mentra Call or another miniapp.
- `miniapps.managed` contains customer-managed userland miniapps. It is not a
  list of SYSTEM miniapps, and the resolver rejects a manifest whose managed
  entries name any built-in SYSTEM package. Each entry pins a package name,
  semantic version, same-origin ZIP URL, and SHA-256 digest. The Mentra App
  verifies the digest and the ZIP's declared package/version before activating
  it.
- `miniapps.configuration` is independent of installation. It maps a package
  name to that package's optional read-only runtime configuration, so it works
  for both bundled SYSTEM miniapps and downloaded userland miniapps in
  `miniapps.managed`. Configuration is never copied into
  or covered by the miniapp ZIP; the same immutable ZIP can run against a
  different customer-hosted backend in each deployment.
- Each package configuration permits at most 32 entries. Keys match
  `[A-Za-z][A-Za-z0-9._-]{0,63}`, values are strings no longer than 2,048 UTF-8
  bytes, and the complete serialized map is at most 16 KiB. A manifest update
  replaces the package's complete map. A missing package entry means an empty
  map.
- When `systemMiniapps.approvedPackageNamesOverride` is non-null, every package
  named by `miniapps.configuration` must either be present in that SYSTEM
  allowlist or in `miniapps.managed`. This rejects misspelled and orphaned
  package configuration in customer manifests. An embedded profile whose
  SYSTEM allowlist is `null` may configure any bundled package known to that
  release.
- Manifest miniapp configuration is public policy, not secret storage. A
  customer-specific API secret, signing key, or bearer token must never appear
  in it. A configured URL may use another operator-approved HTTPS origin, but
  the customer must include that origin in its network policy. The Mentra App
  does not infer or grant network access from an opaque configuration value.
- Configuration is a small optional override surface, not automatic dependency
  injection or a new backend-discovery architecture. Most miniapps continue to
  hard-code their normal backend and never read this API. An override has an
  effect only when both the active host deployment supplies a value for that
  exact package and the miniapp explicitly reads and validates that key.
  Otherwise the miniapp's compiled behavior is unchanged. First-party Mentra
  miniapps opt in selectively where one signed bundle must target
  customer-hosted infrastructure.
- Runtime may serve these pinned ZIPs from its existing deployment-asset
  surface under `/miniapps/`; this does not enable another Runtime module or
  add a service/container. Runtime verifies image-bundled ZIP hashes at boot.
- A successful version change replaces the prior version owned by the same
  deployment. Removing an entry uninstalls the version previously installed by
  that deployment. An empty list therefore means no managed userland miniapps.
  A failed download or install leaves the prior working version active, and the
  reconciler never adopts or removes installs it does not own.
- Ownership is recorded twice: in a JSON state file and in each installed
  release's identity (`deployment_manifest` source, deployment id, origin, and
  digest). Cleanup unions both. The reconciler asks the registry for every
  deployment-owned release, so an install that landed before the state file
  was written is still discovered and removed when its entry disappears, the
  workspace changes, or the app returns to the consumer deployment. New
  ownership is persisted before the older version is uninstalled, so an
  interrupted upgrade leaves both releases discoverable rather than orphaned.
- V1 reconciles the validated manifest snapshot on activation and boot.
  Concretely, `MantleManager.initMiniapps()` calls
  `deploymentManagedMiniappSync.sync()` with the active deployment right after
  bundled miniapps are installed and before local miniapps autostart. That
  path runs from `mantle.init()` on every app boot, and a deployment change
  tears Mantle down and re-enters the same boot route, so activation is
  covered by the same call. A customer manifest change is picked up when the
  workspace is selected again; background manifest refresh is explicitly later
  work.
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

## Miniapp backend authentication

Core's existing `/api/client/auth/miniapp-token` and public JWKS contract remain
the backend-auth boundary for Private Deployments. The Mentra App host obtains a
token audience-pinned to the calling package and injects only that token through
`session.auth`; neither the Core session token nor the federated identity enters
miniapp JavaScript.

A customer-hosted miniapp backend uses the ordinary `@mentra/auth` package and
explicitly pins its customer Core:

```text
MENTRA_AUTH_JWKS_URL=https://core.mentra.example-corp.com/.well-known/jwks.json
MENTRA_AUTH_ISSUER=https://core.mentra.example-corp.com
MENTRA_PACKAGE_NAME=com.example.remoteassist
```

With those settings the backend fetches only the customer Core's public keys;
it does not try Mentra-hosted JWKS endpoints. Private Core uses a unique,
configured issuer, normally its canonical HTTPS origin. Mentra Cloud retains
the legacy `cloud-core` issuer for compatibility.

The existing `@mentra/auth` API already supports this single-Core shape through
its `jwksUrl` and `issuer` options and the corresponding environment variables.
No V1 API change to `@mentra/auth` is required for a backend dedicated to one
Private Deployment. Core's miniapp-token issuer already follows the
deployment-wide `CLOUD_CORE_ISSUER` setting and falls back to `cloud-core` only
for compatibility. Customer deployment templates must configure the same exact
issuer on Core and the backend, alongside the customer Core JWKS URL and
package name.

A backend serving multiple independent deployments must configure paired trust
records, not independent issuer and JWKS lists. Before Mentra supports that
shared-backend topology, `@mentra/auth` will add an explicit `trustedCores` list
whose entries bind `issuer`, `jwksUrl`, and allowed deployment tenant ids. The
existing independent `issuer[]` and `jwksUrls[]` fallback is suitable for
Mentra-hosted environments that intentionally share `cloud-core`; it must not
be used as an unpaired trust matrix for unrelated customer Cores. The verifier
must never discover or trust a JWKS URL from an unverified request or token.

Core signing keys are durable customer secrets. Deployment templates generate
them once into the customer's secret manager and reuse them across upgrades,
rollbacks, and container replacement. Future key rotation publishes current and
previous public keys concurrently until every token signed by the previous key
has expired, including clock-skew allowance.

## Package-scoped miniapp runtime configuration

Deployment-owned miniapp configuration is a host capability, not part of a
miniapp's own `miniapp.json`. The latter describes the immutable bundle's
identity, entries, permissions, hardware requirements, and actions. Putting a
customer backend URL there would require a customer-specific build and would
incorrectly make deployment policy part of the bundle digest.

The Mentra App passes the complete `miniapps.configuration` map into Engine at
startup through its existing host configuration boundary. Engine retains the
map separately from the installed miniapp manifest. When a package completes
the existing phone-to-miniapp handshake, `LocalMiniappRuntime` looks up exactly
that package name and adds an optional configuration snapshot to
`CONNECT_ACK`:

```ts
interface ConnectAckPayload {
  // Existing fields omitted.
  configuration?: Readonly<Record<string, string>>
}
```

This is an additive wire change. An older host omits `configuration`; a current
host sends `{}` when the active deployment has no values for the package. A
miniapp that requires this capability declares the corresponding
`minHostVersion`. No new request type, HTTP call, Core endpoint, Runtime
endpoint, or permission is introduced.

The Mentra Miniapp SDK exposes the snapshot to background JavaScript as:

```ts
const backendUrl = await session.configuration.get("backendUrl")
const requiredUrl = await session.configuration.require("backendUrl")
const allConfiguration = await session.configuration.getAll()
```

`get()` resolves to `string | undefined`; `require()` rejects with a typed
configuration error when the key is absent; and `getAll()` returns a defensive,
read-only copy. These methods wait for the session's existing `CONNECT_ACK`, so
they are safe inside an async `registerMiniapp()` handler and create no second
wire round trip. Calls made after the session is ready resolve from memory.

Configuration has the following lifecycle and isolation rules:

- A package receives only the map keyed by its exact package name. It cannot
  enumerate or request another package's configuration.
- Configuration cannot override Core, Runtime, auth, permissions, native
  capability policy, or another platform-level manifest field. Those remain
  trusted host configuration outside miniapp JavaScript.
- The snapshot is immutable for one miniapp session. There is no V1 update
  event or subscription API.
- A newly activated manifest takes effect when Engine restarts and miniapps are
  relaunched. An already-running miniapp is never silently switched to another
  backend.
- Workspace switching stops every miniapp before Engine is configured with the
  next deployment, so configuration cannot cross deployment ids.
- The background miniapp owns host interaction. If its UI WebView needs a
  derived value, the background sends that value through the miniapp's normal
  typed UI channel; the UI does not receive a second privileged configuration
  surface.
- Engine and crash diagnostics may record package and configuration key names,
  but not configuration values. Values are non-secret by contract, but may
  still reveal private customer hostnames.
- Mock transport accepts an optional package configuration snapshot so SDK and
  miniapp tests do not require a deployment manifest or running Mentra App.

The initial implementation remains deliberately string-only. This covers
endpoints and simple policy values without inventing an untyped remote-settings
system. Most miniapps will never use this module. A future typed schema can be
additive if real miniapps require booleans, numbers, arrays, or structured
values.

### Mentra Call backend selection

Mentra Call keeps its compiled consumer backend URL as the default and checks
for a deployment override after startup:

```ts
const configuredBackendUrl = await session.configuration.get("backendUrl")
const backendUrl =
  configuredBackendUrl === undefined
    ? DEFAULT_MENTRA_CALL_BACKEND_URL
    : validateBackendUrl(configuredBackendUrl)
```

The ordinary consumer Mentra App therefore does not need to enumerate
`backendUrl` overrides for every first-party miniapp. Existing consumer behavior
is unchanged. A customer profile supplies a customer-hosted URL only when it
wants to redirect that first-party miniapp's backend traffic. If an override is
present but invalid, Mentra Call reports invalid workspace configuration rather
than silently reverting to the consumer backend.

The first Private Deployment's native ACS path has no Mentra Call backend and
does not need to configure `com.mentra.call.backendUrl`. That path talks only to
the provider-neutral native meeting capability; the trusted native host talks
to customer Runtime for ACS credentials, so the compiled consumer backend is
never used on that path. A future Private Deployment that enables a
backend-dependent Mentra Call path must supply its override and include the
destination in its qualified network policy. When present, Mentra Call validates
`backendUrl` as an absolute HTTPS URL, normalizes trailing slashes, and uses
`session.auth.fetch()` for authenticated backend requests.

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
  -> supply a fresh customer-Core session token to Cloud Client
  -> exchange at Core and persist the rotated Core refresh token securely
  -> obtain a short-lived Core-issued Runtime token
  -> start Runtime REST capabilities without the real-time Runtime session
  -> install/launch only approved bundled miniapps
  -> reconcile customer-managed userland miniapps by version and digest
     (MantleManager.initMiniapps -> deploymentManagedMiniappSync.sync)
  -> pass each launched package only its deployment configuration snapshot
```

Changing deployment is controlled logout:

1. Leave any call and stop Engine.
2. Revoke the active customer-Core refresh session when reachable.
3. Clear the active deployment's Core tokens, MSAL/account state, and local
   runtime identity even if server revocation could not complete.
4. Select, validate, and persist the new deployment.
5. Restart through the normal boot route.

Credentials and app state must not cross deployment ids.
Signing out of a workspace clears its cached manifest and returns the app to
the neutral Mentra/workspace landing screen, including after an app restart.
Keeping a workspace selected while changing employees is a distinct future
account-switching action, not logout behavior.

## Engine and Mentra Call contract

Core and Runtime URL injection already exists through `engine.configure()`.
Private Deployment extends that same host boundary rather than importing mobile
deployment state into Engine:

```ts
engine.configure({
  config: {
    coreUrl,
    runtimeUrl,
    miniappConfiguration: manifest.miniapps.configuration,
  },
})
```

Private Deployment uses the Cloud Client's existing Core-backed shape: a
host-provided OIDC subject-token callback for Core and
`auth.runtime.source: "core"`. The subject-token callback uses the selected
deployment auth provider and its `sessionScopes`; it never falls back to a
Mentra account provider.

Core-backed, Runtime-REST-only startup still brings up:

- Bluetooth and glasses state;
- local pairing and reconnection;
- local settings required by glasses and bundled miniapps;
- the local miniapp registry, launcher, WebView/JS runtime, and display path;
- the phone stream coordinator;
- native ACS meeting services;
- OTA using the selected deployment artifact URL, when configured.

It creates the Core session and authenticated Runtime REST capability surface
but does not start cloud audio uplink, the Runtime WebSocket, reconnect alarms,
preinstalled registry sync, support-profile sync, cloud reports, or cloud
speech. Core-backed miniapp token minting remains available.

The Profile and debug surfaces read display identity from the selected auth
provider and stable identity from the Core session. They do not call Mentra
consumer-account APIs in a Private Deployment. Consumer-only password,
email-change, export, and account-deletion controls are hidden. Local and
manifest-managed miniapps may use Core-backed backend auto-auth.

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
- the canonical public `ghcr.io/mentra-community/mentra-cloud` image pinned by
  digest, with signed SPDX SBOM and build-provenance attestations; the same
  digest starts separate Core and Runtime processes; and
- cloud-specific deployment adapters, beginning with the Azure template and
  administrator runbook for Core, Mongo-compatible persistence, durable signing
  keys, and the Runtime `meetings` module set. Customer ACR/ECR/private
  registries mirror the canonical digest rather than rebuilding it.

Do not create a second mobile build lane.

## MVP acceptance

The first Android-and-iOS call-focused pilot is complete when:

1. The official Mentra App selects a workspace by manual URL and activates only
   after manifest and release validation.
2. An assigned user signs in through the deployment's Microsoft Entra tenant,
   including MFA/Conditional Access, and exchanges that identity at the
   customer-hosted Core without Supabase or Mentra public infrastructure.
3. Core restores a stable Mentra user/session, issues a Runtime token with the
   signed Entra federated-identity binding, and mints a package-scoped miniapp
   token that verifies against only the customer Core's configured JWKS and
   issuer.
4. Engine authenticates to customer Runtime using the Core-issued token, pairs
   Mentra Live, and launches the approved bundled Mentra Call miniapp without
   opening a Runtime WebSocket or raising cloud connection alarms.
5. The same digest-pinned first-party test miniapp ZIP can run in two test
   deployments and receive a different package-scoped `backendUrl` in each through
   `session.configuration`, without reading another package's values. Omitting
   the override preserves the miniapp's compiled consumer default, while an
   explicitly invalid override fails as a configuration error.
6. Mentra Call presents one primary join action, accepts an existing work/school
   Teams URL, shows clear SoftAP connection/recovery UX, and requires no calendar
   or meeting-creation permission.
7. Mentra Live sends media directly to the phone over SoftAP without a public
   relay, and the customer Runtime exposes no managed-stream route or Cloudflare
   credential.
8. The phone joins a work/school Teams meeting through native ACS raw media on
   Android and iOS, with no Recall bot, using the same employee identity that
   signed into the workspace through Entra.
9. The Teams receiver observes the 1280x720 at 15 fps target and less than two
   seconds of end-to-end video latency under the documented reference network.
   Qualification records negotiated and observed media rather than treating the
   requested ACS format as a guarantee.
10. Leaving, shipped mute behavior, stream recovery, incoming glasses audio, and
   a 30–60 minute device soak pass on both platforms within the native branch's
   supported limits. Leave tears down resources, confirms exit, and returns to
   the Mentra Call home screen.
11. Mentra public Core, Runtime, telemetry, artifacts, content, and miniapp
   services receive no traffic. Only the manifest-declared/customer-approved
   customer Core, customer Runtime, Microsoft, ACS, miniapp backends, and
   streaming destinations are contacted.
12. The embedded Mentra profile still passes ordinary consumer release tests.

## Explicitly later

- Cloud speech, synchronized settings, reports, and customer Store behavior.
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
- Custom color themes or bundle identifiers beyond the manifest logo pair.
- Restricted-network qualification of vendor services for any allowlisted
  glasses model, including AR99. `glasses.allowedModelsOverride` controls which
  models may pair; allowing a model does not implicitly authorize its public
  vendor APIs.
