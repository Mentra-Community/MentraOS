---
status: draft
owner: Mentra
---

# Mentra Enterprise self-hosted deployment design

## Outcome

The same official Mentra App binary can run against Mentra's public services or a
customer-controlled deployment. A small deployment manifest selects the Core,
Runtime, Mentra Live OTA, and speech-model locations and disables features that
would otherwise contact public services.

This is an operating mode of the Mentra App and Mentra Engine, not a customer
fork, branded build, or second release pipeline.

The v1 security target is a customer-controlled, restricted-network deployment,
not a literally disconnected network. The Mentra App must not contact Mentra's
public Core, Runtime, telemetry, artifact, or content services after a private
profile is active. The deployment may still reach destinations explicitly
approved by the customer, such as its Microsoft Entra tenant, its configured
speech providers, Apple or Google distribution services, and customer-operated
hosts. This document uses "air-gapped" only for a future zero-egress deployment.

## First supported deployment

The first supported private Mentra App deployment requires:

- The official Mentra App binary from one completed coordinated release.
- Customer-hosted Cloud V2 Core and Runtime services from that release.
- A Microsoft Entra workforce tenant controlled by the deployment operator and
  connected to customer-hosted Core through OIDC for the first pilot.
- The matching self-hosted Mentra Live OTA bundle.
- Customer-hosted copies of the on-device STT and TTS model archives the
  deployment enables.
- A customer deployment manifest reachable by the phone before sign-in.
- Mentra Live as the only glasses model qualified for the first private pilot.
- No unapproved public-network access after device and app provisioning.
  Microsoft Entra and the deployment's configured speech providers are
  explicitly approved dependencies for the first pilot. A strictly disconnected
  identity or speech provider will use the same Core/Runtime boundaries but is
  not claimed as supported until separately qualified.

### Why Core is required

Core is required for this design. It is the customer deployment's control plane:
it owns account login, session refresh and revocation, stable tenant and user
identity, subject-token minting, Runtime and miniapp token exchange, the
minimum-client-version check, the preinstalled miniapp registry, settings, and
reports. Runtime is the real-time execution plane for glasses, audio, and
miniapp sessions; it does not replace those account and control-plane APIs.

Decision: package the required Core and Runtime services with the first private
deployment. Runtime-only support is not a deployment-manifest option and is not
part of this plan. Supporting it would require a separate architecture that
moves or replaces Core's identity, token, registry, settings, version, and
reporting contracts. The manifest keeps the Core boundary deployment-scoped so
that internal service decomposition can happen later without creating a second
Mentra App path.

The standalone Bluetooth SDK deployment remains independent and does not need
Core or Runtime.

## One configuration path

The application always consumes the same typed deployment object, but a new
installation does not need a deployment selected before it can render a local
landing screen.

The landing screen keeps the ordinary Mentra account choices and adds one
visually separate private-deployment action:

- Google
- Apple, where supported
- Email
- Connect to a workspace

The first screen preserves the existing consumer hierarchy rather than
redesigning account creation in this project:

```text
                         Mentra

                 [ Sign up with email ]
                 [ Continue with Google ]
                 [ Continue with Apple  ]   (iOS only)

              Already have an account? Log in

                  -------- or --------

                 [ Connect to a workspace ]
```

Connect to a workspace is visually secondary but always visible. It names the
thing being selected rather than assuming the workspace uses SSO; authentication
policy is learned only after the manifest loads.

Google, Apple, or Email activates the embedded Mentra deployment profile before
starting that authentication flow. Connect to a workspace opens a second local
screen with one field:

```text
< Back

Workspace URL
https://mentra.example-corp.com

[ Continue ]
```

The workspace URL is the human-shareable, externally reachable HTTPS origin for
that deployment's Core. It is not a raw JSON URL and does not need to be the
Runtime host. The app normalizes the origin and fetches the manifest directly
from a fixed unauthenticated path:

```text
GET https://mentra.example-corp.com/.well-known/mentra-deployment.json
```

The private deployment package makes Core, or the ingress immediately in front
of Core, serve the exact manifest JSON at that path from a mounted deployment
file. There is no directory response and no second manifest-URL hop. V1 requires
the resolved `services.coreUrl` origin to equal the entered workspace origin;
Runtime, artifact, and content hosts may remain separate.

Entering a workspace URL creates a candidate deployment; it does not immediately
change active endpoints. The app first downloads the JSON, resolves it over the
embedded defaults, validates the schema and `releaseIdentity`, and shows a local
confirmation screen containing the deployment display name, workspace hostname,
and declared sign-in type. Core/Runtime hosts are available under expandable
connection details rather than shown as primary end-user copy. Only after the
user chooses Continue does the app atomically persist and activate the workspace,
then enter that deployment's authentication flow.

```text
< Cancel

Connect to Example Corp

Workspace: mentra.example-corp.com
Sign-in:   Organization account

[ Continue to Example Corp ]
[ View connection details ]
```

Back or Cancel discards only the candidate and returns to the ordinary Mentra
landing screen. It does not change endpoints, save the workspace, or start a
network service. After a manually selected workspace has been activated but
before login, its organization sign-in screen also offers Use a different
workspace and Return to Mentra. Return to Mentra clears the custom deployment
selection and restores the local landing screen; because the user is not yet
authenticated, no account logout is needed. After login, changing deployments
uses the controlled logout flow described below.

An MDM-managed workspace URL uses the same well-known lookup and takes
precedence over manual selection. Because MDM is authoritative, it can activate
the validated workspace without asking for the URL; an unauthenticated user is
shown the organization-branded sign-in screen rather than having a browser open
unexpectedly. An enforced MDM deployment does not offer Return to Mentra or
manual workspace switching and labels the deployment as managed by the user's
organization. Removing that restriction requires the administrator to remove
the managed configuration. A previously selected custom deployment is restored
on subsequent boots. The embedded Mentra profile is the one complete set of
defaults. A customer manifest uses the same schema as a partial override of that
profile, so the app has one resolution path rather than separate consumer and
enterprise branches.

HTTPS and the device trust store authenticate the workspace server; MDM may
install a private CA where required. V1 rejects URL credentials, query strings,
fragments, invalid TLS, oversized responses, and cross-origin redirects.
Manifest signing is not required for the first implementation.

After activation, a `core-sso` deployment presents a single Continue with
organization account button. It opens `GET /api/account/sso/start` on the
selected Core. `core-sso` is a Mentra manifest mode, not an identity protocol or
a Mentra-hosted identity service. In the first supported version, the customer's
Core has exactly one Microsoft Entra OIDC registration configured by its
administrator. Core therefore redirects to that specific Entra tenant; it does
not dynamically choose among providers or protocols. The first private template
does not expose signup, password, verification-email, or recovery UI.

### Identity rollout

Use "deployment operator" for the organization running the private deployment
and "end user" for the person using the Mentra App and glasses.

The first supported private identity integration is Microsoft Entra:

1. The deployment operator registers MentraOS as a single-tenant application in
   its Microsoft Entra tenant and configures the resulting registration on its
   customer-hosted Core.
2. The end user chooses Connect to a workspace and enters the URL supplied by
   IT, or MDM supplies it automatically.
3. The app fetches and validates the well-known manifest, then asks the end user
   to confirm the resolved organization.
4. The app activates that deployment and presents Continue with organization
   account.
5. The customer's Core redirects the browser to the customer's Entra sign-in,
   validates the callback, and returns a normal deployment-scoped Cloud V2
   session to the app.

The first private template sets `mode: "core-sso"`. It does not ask the
customer to self-host Supabase Auth, build a password service, or administer a
parallel employee directory. Email/password remains a possible future adapter
for deployments that explicitly require local accounts, but it is not the first
private pilot or a prerequisite for the manifest foundation.

### How an enterprise connects Microsoft Entra

There are two separate configuration surfaces:

1. **Microsoft Entra configuration.** The customer's Entra administrator creates
   a new app registration named, for example, "MentraOS Enterprise", selects
   Accounts in this organizational directory only, and adds one Web redirect
   URI:

   ```text
   https://<workspace-host>/api/account/sso/callback
   ```

   The administrator records the Directory (tenant) ID and Application (client)
   ID, creates a client credential for the confidential Core server, requires
   assignment for the Enterprise Application, and assigns the users or groups
   allowed to use MentraOS. The first integration requests only the standard
   `openid profile email` identity scopes; it does not require Microsoft Graph
   access.
2. **Customer Core configuration.** The deployment operator uses the tenant ID
   to form the tenant-specific OIDC issuer URL, then places that URL, the client
   ID, and the client credential in the Core deployment configuration and secret
   store. They are not put in the workspace manifest or Mentra App. An
   illustrative configuration shape is:

   ```yaml
   identity:
     mode: oidc
     issuerUrl: https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0
     clientId: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
     clientCredentialSecretRef: mentra-entra-client-credential
     redirectUri: https://mentra.example-corp.com/api/account/sso/callback
     userProvisioning: just-in-time
   ```

   The packaged deployment validates these values at startup and resolves OIDC
   discovery metadata from that exact issuer. The Core configuration contract is
   standards-based rather than hard-coded to Microsoft, but only Microsoft Entra
   is supported and qualified in v1. A client secret is sufficient for the first
   controlled pilot because it remains on Core; a certificate credential is the
   stronger production option and can be added to the same server-side contract.

The end user never sees any of those identifiers. Continue with organization
account starts this sequence:

```text
Mentra App
  -> customer Core /api/account/sso/start
  -> login.microsoftonline.com/<customer-tenant>/.../authorize
  -> customer Entra login, MFA, and Conditional Access
  -> customer Core /api/account/sso/callback
  -> customer Core validates identity and creates a MentraOS session
  -> Mentra App redeems a one-time PKCE-bound handoff at customer Core
     /api/account/sso/complete
```

Core must validate the Entra issuer, tenant, audience, signature, state, nonce,
and PKCE response. It keys the external identity by verified issuer plus stable
subject, not by mutable email address. Entra remains responsible for employee
authentication, MFA, Conditional Access, account disablement, and group/user
assignment. Core is responsible for mapping an accepted Entra identity to the
customer's MentraOS tenant and issuing the session used by Runtime.

Mentra will qualify this first using a non-production app registration in its
own Microsoft Entra tenant, a dedicated assigned test group, and an isolated
customer-style Core deployment. The test matrix includes assigned and
unassigned users, wrong-tenant users, MFA, disabled users, expired credentials,
callback tampering, session refresh, and logout. The customer-facing Microsoft
Entra setup guide is written from that proven setup before another provider is
claimed as supported.

The guide should link directly to Microsoft's documentation for
[registering an application](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app),
[authorization code flow with OIDC and PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow),
[redirect URI rules](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url),
[application credentials](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials),
and [assigning users or groups](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/assign-user-or-group-access-portal).

The app must resolve the deployment before authentication because it needs the
manifest's Core URL and auth policy to know where to begin SSO. An SSO callback
must not introduce or switch deployment configuration after authentication.

This fits Core's session model. Core already hosts the Google/Apple browser
OAuth flow: the app starts against Core with PKCE, Core redirects to the identity
provider through GoTrue, Core handles the callback and creates a Cloud V2
session, and the app redeems a one-time handoff code against that same Core.
Customer-hosted Core SSO generalizes that existing shape:

1. The resolved manifest selects `coreUrl` before auth begins.
2. The app opens the unauthenticated `/api/account/sso/start` endpoint on that
   Core with a PKCE challenge.
3. Core redirects through its server-configured Microsoft Entra OIDC
   connection. Tenant metadata and client credentials stay in customer-hosted
   Core or its secret store, never in the manifest or public Mentra services.
4. Core validates the IdP callback, maps the external subject to a Core user,
   and creates that user just in time when organization policy permits it.
5. Core deep-links a short-lived handoff code to the app, and the app exchanges
   it with its PKCE verifier for a deployment-scoped Core session.

SSO describes the user experience of using one organization account; it is not
one wire protocol. OIDC and SAML are two common protocols for delivering that
identity. Microsoft Entra is the only provider qualified and documented in the
first implementation, using OIDC because it is the modern fit for a new mobile
browser flow. The Core boundary should remain compatible with adding another
OIDC provider later, but Okta, Google, internal OIDC, and SAML are not claimed as
supported until separately tested and documented. PKCE protects the short-lived
browser-to-app handoff; it is not another login option.

The customer IT administrator does not implement a login screen or give
credentials to Mentra. The current implementation hard-codes Google and Apple
and delegates them to GoTrue, so direct Microsoft Entra OIDC requires
implementation work rather than a schema toggle. The existing browser PKCE
handoff, trusted-issuer verification, external-token exchange, and Core session
model remain reusable.

In a private deployment, the workspace ingress, Core, Runtime, and resulting
MentraOS session are customer-controlled. Microsoft hosts the Entra identity
endpoint, but it operates against the customer's tenant and policy. Mentra's
public Core, Runtime, directory, and Supabase are not in this authentication
path. Neither the workspace manifest nor Mentra infrastructure receives the
user's corporate credential.

MDM can make workspace selection invisible, but does not make login silent
unless the managed environment separately supplies a device identity,
certificate, or platform SSO session.

On subsequent boots, the app loads the saved profile before starting any
network-capable service. It refreshes the configured URL when reachable and can
use the last valid cached copy while disconnected. If a custom profile has never
loaded successfully, boot stops at local deployment setup; it never falls back
to the embedded Mentra profile.

## Manifest v1

```json
{
  "schemaVersion": 1,
  "deploymentId": "example-corp",
  "displayName": "Example Corp Mentra",
  "releaseIdentity": "3.1.0",
  "services": {
    "coreUrl": "https://mentra.example-corp.com",
    "runtimeUrl": "https://runtime.example.internal"
  },
  "auth": {
    "mode": "core-sso"
  },
  "artifacts": {
    "mentraLiveOtaManifestUrl": "https://updates.example.internal/mentra/3.1.0/version.json",
    "sttModelBaseUrl": "https://updates.example.internal/mentra/3.1.0/models/stt/",
    "ttsModelBaseUrl": "https://updates.example.internal/mentra/3.1.0/models/tts/"
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
    "wallpaperUrls": [
      "https://updates.example.internal/mentra/3.1.0/wallpapers/landscape1.jpeg"
    ]
  },
  "links": {
    "privacyPolicyUrl": "https://portal.example.internal/privacy",
    "termsOfServiceUrl": "https://portal.example.internal/terms",
    "documentationUrl": "https://docs.example.internal/mentra",
    "supportUrl": "https://support.example.internal/mentra"
  },
  "systemMiniapps": {
    "approvedPackageNamesOverride": [
      "com.mentra.camera",
      "com.mentra.gallery",
      "com.mentra.settings"
    ]
  },
  "glasses": {
    "allowedModelsOverride": ["mentra-live"]
  },
  "features": {
    "cloudSpeech": true,
    "onDeviceSpeech": true,
    "navigation": false
  },
  "telemetry": false
}
```

Rules:

- `deploymentId` is stable and namespaces credentials, caches, and settings.
- The resolved `services.coreUrl` origin must equal the workspace origin in v1,
  so configuration discovery and authentication cannot silently move the user
  to a different host. A customer can place Core behind its workspace ingress.
- `auth.mode: "core-sso"` makes the app open the selected Core's fixed
  `/api/account/sso/start` route. Protocol, issuer, client credentials, claim
  mapping, and IdP secrets are server-side Core configuration, not manifest
  fields.
- The complete embedded Mentra profile uses `auth.mode: "mentra-account"` and
  retains its existing Google, Apple, email signup, login, verification, and
  recovery surfaces. V1 customer manifests may select `core-sso`; they do not
  compose an arbitrary list of login buttons.
- `releaseIdentity` must exactly match the installed coordinated Mentra release.
  This prevents an app, Engine, SDK, and OTA bundle from different release sets
  being combined accidentally.
- URLs must be absolute HTTPS URLs outside development builds.
- The OTA URL points at the `version.json` generated from the matching portable
  OTA bundle.
- Model base URLs preserve the existing model archive filenames so a customer
  can mirror the files without a new model protocol in v1.
- `content.wallpaperUrls` is the complete preset-wallpaper catalog. An empty
  array means no remote presets; the app does not fall back to Mentra wallpaper
  hosts. Choosing a local photo remains available independently.
- Privacy and terms URLs belong to the active deployment and remain available
  wherever the app presents legal text. Documentation and support URLs are
  deployment-specific rather than controlled by a blanket external-links flag.
- Mobile distribution-store and review URLs belong to `appUpdates`, not to the
  system-miniapp policy. Null review URLs suppress review prompts. Managed mode
  uses administrator-provided update instructions instead of a public store.
  The Mentra Miniapp Store is a separate in-app system entry and is governed by
  its package name in the system-miniapp policy.
- `systemMiniapps.approvedPackageNamesOverride` is either `null` or a complete
  allowlist of stable miniapp package names. `null` means use the app release's
  full built-in system-miniapp catalog and automatically includes future
  additions; the embedded Mentra profile uses `null`. An array activates the
  override: `[]` approves no system miniapps, while a populated array approves
  only those packages. Customer manifests should use an explicit array so a
  future Mentra App release cannot expose a newly added system miniapp without
  customer approval.
- A system miniapp outside the active approved set is not registered in
  user-visible catalogs, menus, or deep-link launch routes, although its code
  remains present in the common app binary.
- `glasses.allowedModelsOverride` contains stable model identifiers from the
  common glasses registry. When present, the pairing UI shows only those
  models. When omitted, the normal supported-model list is shown. This is a UI
  catalog override, not a security boundary, and does not add model checks to
  scanning, deep links, or reconnection. It also does not make a model's vendor
  services air-gap compatible.
- The manifest never exposes model-specific switches such as
  `ar99VendorServices`. Vendor-specific transports and update behavior remain
  behind each glasses adapter. A deployment that permits only selected hardware
  customizes the pairing catalog through the general model override.
- The embedded Mentra profile is complete. A customer manifest is recursively
  merged over it: omitted fields inherit the Mentra value, arrays replace the
  inherited array, and an explicit `null` disables fields documented as
  nullable. Validation runs on the resolved profile. Strictly air-gapped
  deployments must inspect that resolved profile and override or null every
  inherited public-network destination before qualification.
- The document contains no passwords, bearer tokens, private keys, or provider
  secrets. Those remain in MDM secret delivery or server configuration.
- The pre-deployment landing screen always exposes the supported consumer
  choices and Connect to a workspace. Once a custom deployment is selected,
  only that manifest's auth mode and supporting flow are shown.
- `appUpdates.mode: "managed"` replaces public App Store/Play Store links with
  an administrator-managed update message. The embedded Mentra profile uses
  store mode and contains the normal public store and review URLs.
- `telemetry` is one master switch. `false` prevents Sentry, PostHog, and
  Firebase Analytics from initializing; v1 does not expose independent vendor
  switches.

The embedded Mentra profile must stop fetching speech archives directly from
the upstream Sherpa-ONNX GitHub release. Mentra will mirror the exact approved
archives into a Mentra-owned Cloudflare R2 bucket behind a custom domain such as
`models.mentra.glass`, preserving the existing filenames and recording the
upstream source and license. Customer deployments can mirror those same files
without changing the app's download protocol. The schema can later replace the
two base URLs with a checksum-bearing model catalog; that is valuable because
STT downloads currently have no archive hash verification, but it does not need
to block the configuration foundation or the move to Mentra-owned hosting.

## Boot sequence

```text
load local settings
  -> resolve MDM workspace / previously enrolled deployment, if present
  -> otherwise render the local consumer-or-enterprise landing screen
  -> consumer choice activates embedded Mentra deployment
  -> Connect to a workspace accepts an HTTPS workspace origin
  -> fetch /.well-known/mentra-deployment.json from that origin
  -> resolve and validate candidate schema and release identity
  -> show workspace identity and sign-in type for confirmation
  -> atomically persist and expose immutable active deployment
  -> initialize telemetry only when the resolved master switch is true
  -> create the deployment-scoped auth provider
  -> run the configured Core version check
  -> present the active deployment's configured authentication action
  -> after authentication succeeds, obtain the deployment-scoped session
  -> engine.configure({ auth, config: deployment })
  -> engine.start()
```

Changing deployment is a controlled logout operation:

1. Stop Engine and auth refresh.
2. Clear or switch to the new deployment's credential namespace.
3. Save and activate the new manifest.
4. Restart through the normal boot route.

Credentials must not be shared across deployment ids. Today account tokens and
the cloud client's secure state use global keys; they must be namespaced or
cleared before endpoint switching.

## Engine contract

Core and Runtime URL injection already exists through
`engine.configure({config: {coreUrl, runtimeUrl}})`. Extend the Engine config with:

- `otaManifestUrl`
- `sttModelBaseUrl`
- `ttsModelBaseUrl`
- The feature flags the Engine itself enforces

Manifest selection for modern Mentra Live becomes:

1. Super Mode developer override.
2. Active deployment's OTA manifest URL.
3. The embedded coordinated-release pin from the embedded Mentra profile.

The customer profile therefore drives both the phone-side OTA check and the
existing Engine hotspot relay. The Bluetooth SDK continues to accept only the
resolved Mentra Live manifest URL and remains unaware of the larger deployment
manifest.

The STT and TTS managers replace their hard-coded upstream GitHub base URLs with
values from Engine configuration. The embedded Mentra profile points to the
Mentra-owned R2 custom domain, while customer profiles may point to an internal
mirror. Existing filenames and extraction flow remain unchanged in v1.

## Network-capable app behavior

The deployment must be resolved before these existing call sites run:

- `SentrySetup()` in the root layout.
- The PostHog provider in `AllProviders`.
- Firebase Analytics initialization.
- `AuthProvider`, whose account client calls Core during mount.
- The minimum-client-version request in the initial route.
- `engine.start()`, which constructs and connects Cloud Client.

For the same binary to be safe in a restricted deployment, native Firebase
analytics collection should default off in the binary and be enabled only after
the embedded Mentra profile is active. Sentry and PostHog should likewise be
started only after profile resolution.

The resolved profile controls optional network-capable behavior:

- Mapbox directions/geocoding and native navigation are unavailable when
  `navigation` is false.
- Preset wallpapers come only from `content.wallpaperUrls`; no compiled public
  wallpaper list is appended.
- Legal, documentation, support, app-store, and review destinations come from
  their resolved manifest fields. An omitted customer override inherits the
  embedded Mentra value; an explicit null suppresses a nullable destination.
  There is no global `externalLinks` switch.
- System miniapps outside an active approval override cannot be discovered or
  launched, including through direct routes. The common binary still contains
  their implementation.
- The pairing model picker shows only `glasses.allowedModelsOverride` when that
  override is present; otherwise it shows the normal supported-model catalog.
- The first private template exposes only Mentra Live. A different model may be
  added only after its adapter has been qualified with public internet blocked
  and any required vendor endpoints have been removed, disabled, or made
  customer-configurable. AR99's current public OTA/vendor-service calls are
  therefore outside the first private deployment rather than controlled by an
  AR99-specific manifest switch.
- Google, Apple, and Email on the initial landing screen select the embedded
  Mentra profile. Connect to a workspace resolves a candidate manifest from the
  workspace origin before activating it. After activation, the app displays the
  selected deployment name and the flow for that profile's auth mode. The first
  private template exposes only Continue with organization account through
  customer-hosted Core.
- Miniapp package and media URLs supplied by customer-hosted Core remain the
  customer's responsibility.
- Runtime speech-provider egress is server-side configuration. A private Runtime
  may use Soniox or ElevenLabs when the customer explicitly approves them. A
  future customer may instead require Azure Speech, AWS speech services, or an
  on-premises provider; adding those Runtime adapters is customer-driven work,
  not part of manifest v1. When no approved cloud provider exists, the
  deployment can disable cloud speech and use the supported on-device path. The
  phone manifest does not configure or proxy server-side speech credentials.

The official binary will still contain optional vendor SDK code and public
tokens used by the Mentra profile. Runtime policy prevents egress; it does not
remove those bytes. A customer whose policy prohibits the presence of that code
would need a different native build, which is outside this same-binary design.

## Distribution

The coordinated release is already the correlation mechanism. Its completed
`mentra-release-<identity>.json` records the exact Android app, iOS app, Engine,
Bluetooth SDK, OTA bundle, hashes, and provenance.

For an Android private deployment, a customer can import the exact Mentra-signed
APK from the completed GitHub release and install or update it through MDM. This
is the same app binary produced by the normal coordinated release.

For iOS, use the normal App Store app through Apple Business Manager/MDM and
deliver the workspace URL as managed app configuration. The current App Store IPA
is not a generally sideloadable offline package. Strictly disconnected first
installation would require a separately provisioned in-house distribution and
periodic Apple certificate validation, so the same-binary promise should be
stated as disconnected operation after Apple/MDM provisioning on iOS.

Apple documents [managed app configuration](https://support.apple.com/guide/deployment/distribute-managed-apps-dep575bfed86/web),
[Custom App distribution through Apple Business Manager](https://support.apple.com/guide/deployment/distribute-custom-apps-dep0113f6e18/web),
and the additional provisioning/certificate requirements for
[self-hosted in-house IPA distribution](https://support.apple.com/guide/deployment/distribute-proprietary-in-house-apps-depce7cefc4d/web).

Add two release artifacts after the runtime work exists:

- `mentra-deployment-template-<identity>.json`
- `mentra-speech-models-<identity>.zip` (or a separately versioned model bundle)

Do not create a second mobile build lane. The template, speech models, existing
Mentra Live OTA bundle, app binaries, and completed release record all attach to
the same coordinated release.

## MVP acceptance

The first Android-and-iOS private pilot is complete when:

1. The official Android and iOS release artifacts start on a restricted customer
   network where Mentra public services are blocked and only deployment-approved
   customer and SaaS destinations are reachable.
2. Google, Apple, or Email selects the embedded Mentra profile. Connect to a
   workspace or MDM resolves the customer manifest from the workspace's
   well-known endpoint before private SSO.
3. Login, refresh, Runtime connection, cloud STT/TTS, settings, registry, and
   enabled miniapps use customer-hosted Core and Runtime. Any cloud speech egress
   is limited to the provider explicitly approved for that deployment.
4. Mentra Live OTA works through the existing Engine hotspot flow using the
   customer-hosted OTA bundle.
5. On-device STT and TTS download from the customer mirror.
6. Preset wallpapers, resolved legal/support links, system-miniapp visibility,
   and the pairing model list follow the active deployment override.
7. Mentra public Core, Runtime, telemetry, artifact, and content services receive
   no traffic. Sentry, PostHog, Firebase, Mapbox, GitHub, and any other
   destination not explicitly approved for the deployment receive no traffic
   during a packet-capture test.
8. The embedded Mentra profile still passes the normal coordinated release and
   consumer app tests.

## Explicitly later

- Local email/password accounts, end-user self-service signup, internal
  verification/password-reset email, and a supported no-email enrollment mode.
- Okta, Google, internal OIDC providers, SAML, and any identity integration
  beyond the first qualified Microsoft Entra OIDC implementation.
- Optional workspace discovery by verified work-email domain or organization
  code. It resolves to the same workspace URL and is not required for private
  deployment or SSO.
- Separating account, registry, settings, version-check, and reporting APIs from
  Core into a smaller control-plane service.
- Local-only Engine startup with no Core, Runtime, or auth seam.
- Signed deployment manifests or customer-managed signing keys.
- Dynamic private certificate pinning.
- Customer branding or bundle identifiers.
- A standalone public hotspot OTA coordinator in the raw Bluetooth SDK.
- Restricted-network qualification and endpoint configuration for non-Mentra
  glasses adapters, including AR99 vendor services.
