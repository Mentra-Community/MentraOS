# Mentra Private Deployment customer setup

This is the administrator runbook for connecting the official Mentra App to a
customer-controlled Microsoft 365/Azure deployment. It is intended for the
customer's Microsoft Entra administrator and Azure operator.

The first supported profile uses:

- the normal, Mentra-signed Android and iOS Mentra App binaries;
- two app registrations in the customer's Microsoft Entra tenant;
- one customer-owned Azure Communication Services (ACS) resource;
- one customer-hosted, meetings-only Cloud V2 Runtime container; and
- direct SoftAP media from Mentra Live to the phone, followed by native ACS media
  from the phone to Microsoft Teams.

It does **not** require Mentra Core, Supabase, MongoDB, Redis, Cloudflare Stream,
a Mentra Call backend, or credentials for Mentra-hosted infrastructure.

```text
Mentra Live --SoftAP--> Mentra App --ACS media--> Microsoft Teams
                              |
                              +--Entra token--> customer Runtime
                                                   |
                                                   +--ACS token exchange
```

Runtime handles authentication and the short-lived ACS Teams-user token. It is
not in the audio/video media path.

## Information to collect

The deployment operator needs:

- Azure subscription and resource-group names;
- Microsoft Entra tenant id;
- Runtime API application client id;
- Mentra App public-client application client id;
- exact Android and iOS redirect URIs for the distributed Mentra App binaries;
- optional minimum and recommended Mentra App version policy; and
- the Runtime container image tag or digest supplied for that release.

Tenant ids, application client ids, scopes, redirect URIs, and workspace URLs
are identifiers, not secrets. Do not put connection strings, bearer tokens, or
client secrets in the deployment manifest.

## 1. Register the customer Runtime API

In **Microsoft Entra admin center → App registrations**:

1. Create an app registration such as `ACME Mentra Runtime`.
2. Select **Accounts in this organizational directory only**.
3. Under **Expose an API**, set the Application ID URI to
   `api://<runtime-application-client-id>`.
4. Add a delegated scope named `mentra.runtime`.
5. Configure the registration to issue v2 access tokens.
6. Record the tenant id, application client id, and full scope:
   `api://<runtime-application-client-id>/mentra.runtime`.

The Runtime container validates the token issuer, tenant, signature, audience,
scope, authorized mobile client, expiry, and employee object id on every
protected request.

## 2. Register the Mentra App public client

Create a second single-tenant app registration such as `ACME Mentra Mobile`.
This is a native public client and must not have a client secret.

Register these mobile redirects:

- iOS: `msauth.com.mentra.mentra://auth`
- Android: `msauth://com.mentra.mentra/<base64-signing-certificate-hash>`

The Android value is tied to the certificate used to sign the exact APK/AAB.
A locally signed test build and the official Mentra-signed release generally
have different hashes. Mentra supplies the official redirect with the release
artifact; do not copy a developer redirect into production.

For the current Mentra-signed binaries, register both distribution redirects:

- downloadable APK:
  `msauth://com.mentra.mentra/q%2FZbvbReOLgD1T6V3o1PK%2Fzjwz0%3D`;
- Google Play installation:
  `msauth://com.mentra.mentra/Pwi%2FLvF9HHWTAMonaqwan%2BeIX6A%3D`.

Add delegated permissions for:

- the Runtime registration's `mentra.runtime` scope;
- Azure Communication Services `Teams.ManageCalls`; and
- Azure Communication Services `Teams.ManageChats`.

Grant tenant-wide administrator consent. These permissions allow joining an
existing work/school Teams meeting as the signed-in employee. The join-only
profile does not need Microsoft Graph calendar or meeting-creation permissions.

From the Mobile app registration's **Overview** page, select **Managed
application in local directory** to open its service principal. This path works
even when the service principal is not visible in the default **Enterprise
applications** list. If the registrations were created with Microsoft Graph or
Azure CLI, add the `WindowsAzureActiveDirectoryIntegratedApp` tag to both the
Mobile and Runtime service principals so administrators can find them normally
under **Enterprise applications**. The tag affects portal visibility only; it
does not change authentication or authorization.

On the Mobile service principal:

1. Set **Assignment required** to **Yes**.
2. Assign only the pilot users or groups.
3. Apply the customer's normal MFA and Conditional Access policy.

Do not assign employees to the Runtime service principal. The Mobile public
client requests the delegated Runtime scope on each employee's behalf. Do not
configure custom token-signing keys or custom **Attributes & Claims** for either
registration; Runtime uses the standard OIDC claims emitted by Entra.

The user signs in once through Microsoft's supported browser or broker. Mentra
never receives the user's password.

For the detailed token and claim contract, see [entra-setup.md](./entra-setup.md).

## 3. Deploy the customer-owned Azure resources

Create a resource group and deploy [bootstrap.bicep](./bootstrap.bicep) to create
a uniquely named Azure Container Registry. Import or build the release-matched
Runtime image into that registry.

Deploy [main.bicep](./main.bicep) with:

- the Runtime image reference;
- registry name;
- tenant id;
- Runtime API client id; and
- mobile public-client id.

The template creates:

- an Azure Container Apps environment;
- a single-replica, HTTP-only Runtime with `RUNTIME_SERVICES=meetings` and
  `MEETING_PROVIDERS=acs-teams`;
- a customer-owned ACS resource;
- a managed identity for private ACR image pulls; and
- an ACS connection-string Container App secret.

No Cloudflare account or API token is required. The mobile public client also
requires no secret. See [README.md](./README.md) for complete Azure CLI commands.

Before production use, replace [privacy.html](./privacy.html) and
[terms.html](./terms.html) with the customer's approved documents and rebuild
the Runtime image.

Replace `assets/logo-light.png` and `assets/logo-dark.png` with the customer's
approved transparent PNG marks before building the customer Runtime image. Keep
each image under 512 KiB and use the same aspect ratio. The light variant must remain
legible on a light app background and the dark variant on a dark app background.
If one mark works on both, use the same PNG for both image inputs. Runtime serves
them from the workspace origin; the phone does not fetch branding from a
third-party host.

## 4. Verify the generated workspace manifest

The deployed Runtime serves:

```text
https://<customer-workspace>/.well-known/mentra-deployment.json
```

Verify that:

- `services.coreUrl` is `null`;
- `services.runtimeUrl` is the same workspace origin;
- both `branding.logoUrls` resolve from the workspace origin;
- `auth.authorityUrl` names the exact customer tenant, never `common` or
  `organizations`;
- the Runtime and ACS delegated scopes match the registrations;
- `features.managedStreams` is `false`;
- `features.nativeMeetings` is `true`;
- telemetry is set to the customer's approved value; and
- the approved miniapp and glasses lists contain only the qualified products.

Runtime refuses to start when the manifest advertises modules that are not
actually enabled.

Runtime also serves `GET /api/client/min-version` before authentication. Its
`required` and `recommended` values come from `CLOUD_CLIENT_MIN_VERSION` and
`CLOUD_CLIENT_RECOMMENDED_VERSION`; both default to `0.0.0`. Use a real floor
only when older app versions are genuinely unsupported.

## 5. Configure network policy

Allow the phone and Runtime to reach the customer-approved Microsoft Entra,
ACS, and Teams endpoints required by the customer's Microsoft cloud. Allow the
phone to reach the workspace origin over HTTPS.

There is no required Mentra Core, Mentra Runtime, Sentry, Firebase Analytics,
PostHog, Supabase, Cloudflare Stream, Soniox, ElevenLabs, or Recall destination
in this profile. Microsoft publishes the authoritative endpoint list for its
cloud; sovereign clouds use different authorities and require separate
qualification.

## 6. Distribute and enroll the Mentra App

Distribute the normal release-matched Mentra App through the customer's chosen
channel:

- Android: import the Mentra-signed APK/AAB into the customer's MDM; or
- iOS: use the App Store app through Apple Business Manager/MDM.

For the first release, the employee taps **Connect to organization** and enters
the workspace origin. The app downloads and confirms the manifest, then shows
one Microsoft organization sign-in action. The workspace URL does not sign the
employee in and contains no credential.

Managed-app configuration can supply the same workspace origin automatically in
a later release without changing the manifest or authentication architecture.

## 7. Qualification checklist

Before pilot use, verify:

- assigned employee login on Android and iOS;
- unassigned and wrong-tenant rejection;
- MFA and Conditional Access browser/broker return;
- silent token renewal, disabled-user behavior, and revoked consent;
- logout and workspace switching without account crossover;
- Runtime health, manifest, legal-document, and ACS exchange endpoints;
- direct SoftAP glasses-to-phone media with no Cloudflare fallback;
- Teams lobby, join, incoming/outgoing audio, video, leave, and recovery;
- a 30–60 minute call on both platforms; and
- a packet capture showing no Mentra-hosted service or telemetry traffic while
  the telemetry-disabled customer workspace is active.

The meetings-only template intentionally cannot qualify the call-media path
until the native SoftAP and ACS integration has landed. Deployment discovery and
Microsoft sign-in can be qualified earlier, but that is not a substitute for an
end-to-end call test.

## Troubleshooting

| Symptom | Most likely cause |
|---|---|
| Microsoft reports a redirect mismatch | The Android signing-certificate hash or iOS redirect does not match the installed binary |
| An employee cannot open the Microsoft login | They or their group are not assigned to the Enterprise Application |
| Runtime returns 401 | Wrong issuer, audience, Runtime scope, authorized mobile client, or expired token |
| ACS exchange returns 403 | Missing ACS delegated permission/admin consent, wrong tenant/client, or mismatched employee object id |
| Workspace is rejected before login | Manifest schema, origin, or TLS policy is invalid |
| Login works but a Teams call cannot start | SoftAP/native ACS integration is absent, ACS configuration is invalid, or Teams policy/license blocks the employee |
