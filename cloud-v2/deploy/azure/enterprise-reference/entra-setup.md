# Microsoft Entra setup for a Mentra workspace

The employee signs in once through the official Mentra App. MSAL obtains two
separate tokens from the same cached account:

- a customer Core API token with delegated `mentra.session` scope; and
- an ACS resource token with `Teams.ManageCalls` and `Teams.ManageChats`.

The Mentra App exchanges the first token with customer Core for a
deployment-scoped Mentra session. Runtime accepts only short-lived tokens issued
by that Core. Neither Mentra nor customer services receive the employee's
Microsoft password.

## Guided setup

Guided setup (`setup.sh`) changes nothing in Entra until the operator confirms
the Azure preview, which names the two apps it will register:
`<Company> Mentra Core (<deployment name>)` and `<Company> Mentra Mobile (<deployment name>)`. It then runs the helper
below with `--installer-owner <owner>`, which tags the registrations it creates.
A same-named app is reused only when it carries that tag; any other same-named
app stops setup with `Entra already has an app registration named ... that this
setup did not create`. Rename or delete that app, or configure the existing apps
by client ID as shown below.

After the apps exist, setup offers tenant-wide consent and asks which employees
or groups can sign in (`--employees` for automation).

When the operator cannot create Entra apps, setup prints a handoff for an
Application Administrator or Cloud Application Administrator, signed in to the
tenant. They download the installer without starting setup (run the install
script as `MENTRA_START=0 bash mentra-install.sh`) and run the printed command:

```bash
~/mentra-install/mentra-private-cloud/scripts/configure-entra.sh \
  --core-name "<Company> Mentra Core (<deployment name>)" --mobile-name "<Company> Mentra Mobile (<deployment name>)" \
  --installer-owner <owner> --grant-admin-consent
```

It prints `coreApiClientId` and `mobileClientId`. The operator records them,
then runs setup again:

```bash
~/mentra-install/mentra-private-cloud/setup.sh configure-entra \
  --core-client-id CORE_ID --mobile-client-id MOBILE_ID
```

That command only reads the two apps: each must be a single-tenant registration
in the deployment's tenant.

## Consent

Tenant-wide consent for the Mobile app's delegated permissions (Core
`mentra.session`, ACS `Teams.ManageCalls` and `Teams.ManageChats`) needs a
Global Administrator, Privileged Role Administrator or Cloud Application
Administrator. Setup grants it when the operator has the role. Otherwise the
summary shows a `Still to do - Admin consent` line with the app's API
permissions page, where the administrator selects **Grant admin consent**.
Setup rechecks consent on every run and keeps showing the line until it is
granted. The meetings app's Microsoft Graph application permission
(`OnlineMeetings.ReadWrite.All`) needs a Global Administrator or Privileged
Role Administrator; see [meeting creation](#meeting-creation).

## Standalone helper

Run the idempotent helper while signed into the customer's tenant as an
Application, Cloud Application, or Global Administrator:

```bash
cloud-v2/deploy/azure/enterprise-reference/scripts/configure-entra.sh \
  --core-name "ACME Mentra Core" \
  --mobile-name "ACME Mentra Mobile"
```

Without `--installer-owner`, the helper only creates apps whose names are not
taken; it never adopts a same-named registration. Run without
`--grant-admin-consent` first, review the two registrations and permissions,
then rerun with the printed ids:

```bash
cloud-v2/deploy/azure/enterprise-reference/scripts/configure-entra.sh \
  --core-client-id <core-api-client-id> \
  --mobile-client-id <mobile-public-client-id> \
  --grant-admin-consent
```

The helper creates or reconciles:

1. A single-tenant Core API registration with identifier URI
   `api://<core-api-client-id>`, v2 tokens, and delegated `mentra.session`.
2. A single-tenant public mobile client with the Core and ACS delegated
   permissions and official binary redirect URIs.
3. Integrated-app service-principal tags so both apps appear normally in the
   Entra portal.
4. `Assignment required` on the Mobile enterprise application.

Assign approved users/groups to the Mobile enterprise application. Do not
assign employees to Core. Core still validates the issuer, audience, scope,
authorized mobile client, directory tenant, expiry, and employee object id.

## Official Mentra App redirects

The public mobile client has no client secret. Register:

- iOS: `msauth.com.mentra.mentra://auth`
- Mentra-signed Android APK:
  `msauth://com.mentra.mentra/q%2FZbvbReOLgD1T6V3o1PK%2Fzjwz0%3D`
- Google Play App Signing:
  `msauth://com.mentra.mentra/Pwi%2FLvF9HHWTAMonaqwan%2BeIX6A%3D`

These certificate hashes are public application identifiers, not private keys.
Add another redirect only when qualifying a differently signed binary.

`scripts/configure-entra.sh` (`IOS_REDIRECT`, `APK_REDIRECT`, `PLAY_REDIRECT`)
is the authoritative source for these values; the list above mirrors it for
review. When the release signing certificate or Google Play App Signing key
changes, update the script and this section together, and do not copy the
hashes into other runbooks.

Do not configure custom signing keys or custom Attributes & Claims. The private
stack relies on standard Entra OIDC claims.

## Manifest

```json
{
  "auth": {
    "mode": "microsoft-entra",
    "authorityUrl": "https://login.microsoftonline.com/<tenant-id>",
    "clientId": "<mobile-public-client-id>",
    "sessionScopes": ["api://<core-api-client-id>/mentra.session"],
    "teamsScopes": [
      "https://auth.msft.communication.azure.com/Teams.ManageCalls",
      "https://auth.msft.communication.azure.com/Teams.ManageChats"
    ]
  }
}
```

The Mentra App accepts an exact tenant only—not `common`, `organizations`, or
`consumers`.

## Core and Runtime

Core receives `CLOUD_CORE_OIDC_PROVIDERS` with the Entra issuer/JWKS, Core API
audience, `oid` subject, `tid` directory, `mentra.session` requirement, and
allowed Mobile client id. See [the cloud-neutral contract](../../private-deployment.md).

Runtime receives the Core issuer/JWKS as `CLOUD_RUNTIME_AUTH_ISSUERS`, plus
`ENTRA_TENANT_ID`, the Mobile `ENTRA_CLIENT_ID`, and secret
`ACS_CONNECTION_STRING`. When the app supplies a delegated Teams token, Runtime
requires Core's explicit `providerKind: microsoft-entra` binding and verifies
that the token's `oid` and `tid` match the same employee and directory before
exchanging it. Without a delegated token, the same endpoint issues a guest
credential from this deployment's ACS resource.

## Meeting creation

Joining does not require Graph meeting-creation permissions. To enable creation,
run `setup.sh configure-teams` (guided setup offers it after installation). It
creates a confidential Graph application, `<Company> Mentra Meetings (<deployment name>)`, in the
same tenant with application permission `OnlineMeetings.ReadWrite.All`, tagged
with the installer owner, and reuses only the app it created. It grants the
permission when the operator is a Global Administrator or Privileged Role
Administrator; otherwise it prints the app's API permissions page, where one of
them selects **Grant admin consent**, and the summary keeps a `Still to do`
line until it is granted. Its client secret goes straight to Key Vault and only
Runtime reads it. To use an existing application, pass `--teams-client-id` and
`--teams-secret-stdin`; setup checks a supplied secret with a Microsoft sign-in
before storing it.

The client secret setup creates expires after 2 years, and setup prints the
date. Before then, add a new client secret to the app in Entra and run
`setup.sh configure-teams` (it asks for the secret, hidden) or
`setup.sh configure-teams --teams-secret-stdin`.

A Teams administrator then authorizes organizers in Microsoft Teams PowerShell,
for example in Cloud Shell (Switch to PowerShell). `configure-teams` prints these
with the IDs filled in and saves them to `mentra-state/teams-policy.ps1`:

```powershell
Install-Module MicrosoftTeams -Scope CurrentUser -Force   # first time only
Connect-MicrosoftTeams -TenantId <tenant-id> -UseDeviceAuthentication
# Create the MentraMeetings policy, or add this app to it:
if (Get-CsApplicationAccessPolicy -Identity MentraMeetings -ErrorAction SilentlyContinue) { Set-CsApplicationAccessPolicy -Identity MentraMeetings -AppIds @{Add='<graph-client-id>'} } else { New-CsApplicationAccessPolicy -Identity MentraMeetings -AppIds <graph-client-id> }
Set-CsApplicationAccessPolicy -Identity MentraMeetings -AppIds @{Remove='<previous-graph-client-id>'}   # the Graph app it replaces
# Let employees create meetings as themselves. This replaces any policy already granted to everyone;
# if your tenant has one, add the app to that policy instead (Set-CsApplicationAccessPolicy with @{Add=...}).
Grant-CsApplicationAccessPolicy -PolicyName MentraMeetings -Global
Grant-CsApplicationAccessPolicy -PolicyName MentraMeetings -Identity <organizer-object-id>
# Policy changes can take up to 30 minutes to apply.
```

The `@{Remove=...}` line appears only after switching from another Graph app,
and the `-Identity` grant only when a guest meeting organizer is configured.
`-Global` replaces any application access policy already granted to everyone in
the tenant; a tenant with one adds the app to that policy instead.
See the [Runtime API contract](../../private-deployment.md#teams-meeting-creation)
for identity selection and the [deployment inputs](./README.md#teams-meeting-creation)
for secret/configuration wiring.

## Qualification

- Assigned employee sign-in and silent Core/Teams token acquisition.
- Unassigned employee, wrong tenant, wrong audience, and wrong client rejection.
- MFA and Conditional Access browser return.
- Logout and workspace switching without credential crossover.
- Revoked consent and disabled-user behavior.
- Official Android APK/Play and iOS redirect paths.
- Meeting creation as a licensed employee, fallback creation for an unlicensed
  or non-Entra caller, Graph policy rejection without fallback, and retirement
  restricted to the creating caller.
