# Microsoft Entra setup for a Mentra workspace

The employee signs in once through the official Mentra App. MSAL obtains two
separate tokens from the same cached account:

- a customer Core API token with delegated `mentra.session` scope; and
- an ACS resource token with `Teams.ManageCalls` and `Teams.ManageChats`.

The Mentra App exchanges the first token with customer Core for a
deployment-scoped Mentra session. Runtime accepts only short-lived tokens issued
by that Core. Neither Mentra nor customer services receive the employee's
Microsoft password.

Organization Admins sign in to the [admin portal](#admin-portal-sign-in) in a
browser with the same Entra account. There, Core signs them in itself, as the
Core API app.

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
or groups can sign in (`--employees` for automation). Before deploying Core it
adds a client secret to the Core app, and once Core has its address it registers
the admin portal's redirect URI; see [admin portal sign-in](#admin-portal-sign-in).

When the operator cannot create Entra apps, setup prints a handoff for an
Application Administrator or Cloud Application Administrator, signed in to the
tenant. They download the installer without starting setup (run the install
script as `MENTRA_START=0 bash mentra-install.sh`) and run the printed command:

```bash
~/mentra-install/mentra-private-cloud/scripts/configure-entra.sh \
  --core-name "<Company> Mentra Core (<deployment name>)" --mobile-name "<Company> Mentra Mobile (<deployment name>)" \
  --installer-owner <owner> --core-owner <operator object ID> --grant-admin-consent
```

`--core-owner` makes the operator an owner of the Core app, so setup can add
its admin portal client secret and redirect URI without an Entra role. It prints
`coreApiClientId` and `mobileClientId`. The operator records them,
then runs setup again:

```bash
~/mentra-install/mentra-private-cloud/setup.sh configure-entra \
  --core-client-id CORE_ID --mobile-client-id MOBILE_ID
```

That command only reads the two apps: each must be a single-tenant registration
in the deployment's tenant.

## Consent

Tenant-wide consent for the Mobile app's delegated permissions (Core
`mentra.session`, ACS `Teams.ManageCalls` and `Teams.ManageChats`) and the Core
app's sign-in permissions (Microsoft Graph `openid`, `email` and `profile`) needs
a Global Administrator, Privileged Role Administrator or Cloud Application
Administrator. Setup grants both when the operator has the role. Otherwise the
summary shows a `Still to do - Admin consent` line with both apps' API
permissions pages, where the administrator selects **Grant admin consent**.
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
   For [admin portal sign-in](#admin-portal-sign-in) it also has the `email`
   optional claim on ID tokens and the delegated Microsoft Graph `openid`,
   `email` and `profile` permissions, plus the portal's redirect URI when
   `--admin-portal-url` is given.
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
stack relies on standard Entra OIDC claims and the `email` optional claim on the
Core app's ID tokens.

## Admin portal sign-in

Core serves the admin portal on its own host, `https://<core host>/`. Setup
prints the address. People sign in with their Entra work account. Core is a
confidential OpenID Connect client of the directory and signs them in as the
Core API app. The ID token's audience is therefore the Core API client ID, and
Core recognizes a person by their `oid`, the same as on their phone.

Sign-in is on when the deployment's `adminPortalSignIn` setting is `true`.
Guided setup turns it on once the Core app's client secret is in Key Vault. With
it off, Core still serves the portal, but its sign-in reports that it is not
configured.

Anyone in the directory can complete the Microsoft sign-in, but only
Organization Admins get into the portal. An Organization Admin is a person
whose email is on the deployment's administrator allowlist (`coreAdminEmails`),
and only a verified email counts. Core treats an Entra email as verified only
when its domain is one of the deployment's **email domains**.

### Email domains

Setup asks for the email domains your Entra directory issues, such as
`acme.com`. List each subdomain separately (`acme.com, us.acme.com`). Setup
accepts lowercase domain names with at least one dot and no trailing dot, each
listed once. It refuses `mentra.glass`, `mentraglass.com` and their subdomains.
Unattended setup reads them from `verifiedEmailDomains` in the answers file. To
change them later, run setup with `--email-domains acme.com,us.acme.com`; it
rolls the change out to Core. An email in any other domain, for example a
guest's personal address, never counts as verified.

### The Core app's settings

Setup configures these on the Core API app registration and keeps everything
else on it:

- Redirect URI (Web platform):
  `https://<core host>/interaction/callback/workforce`, where Entra returns
  people to Core's sign-in server. It must match exactly. Setup adds it once
  Core's address exists, after the first deployment.
- The `email` optional claim on ID tokens. Without it, Entra leaves members'
  email out of the token.
- Delegated Microsoft Graph `openid`, `email` and `profile`, with tenant-wide
  consent (see [Consent](#consent)). These are the only permissions sign-in
  needs.
- A client secret. Setup creates it, valid for 2 years, before Core is first
  deployed. The secret goes straight to the deployment's Key Vault as
  `entra-browser-client-secret` and is never printed or stored on disk. Only
  Core can read it. The setup summary shows the expiry date. To rotate it, see
  [operations](./operations.md#customer-configuration-checklist).

The admin portal signs in through Core's sign-in server on Core's own host,
which signs people in with Entra as the Core API app. The portal's signed-out
screen links to the sign-in server's sign-out, `https://<core host>/oidc/session/end`;
Entra keeps its own session.

When the operator cannot change the Core app, setup stops before deploying and
prints an `az ad app owner add` command for an Application Administrator or
Cloud Application Administrator, which makes the operator an owner of the app.
When setup cannot register the redirect URI, the summary shows a `Still to do -
Admin portal sign-in` line with the command for that administrator:

```bash
~/mentra-install/mentra-private-cloud/scripts/configure-entra.sh --admin-portal-only \
  --core-client-id <core-api-client-id> --admin-portal-url https://<core host> --grant-admin-consent
```

Without guided setup, store the client secret in Key Vault (the vault exists
once `scripts/deploy.sh --bootstrap-only` has run), then set
`"adminPortalSignIn": true` in the configuration file and deploy. With it on,
`scripts/deploy.sh` stops if Key Vault has no `entra-browser-client-secret`.
Once Core has its address, run the command above.

```bash
az ad app credential reset --id <core-api-client-id> --append --display-name "Mentra admin portal" \
  --years 2 --query password --output tsv | tr -d '\r\n' |
  az keyvault secret set --vault-name <key-vault> --name entra-browser-client-secret \
    --file /dev/stdin --encoding utf-8 --output none
```

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
allowed Mobile client id. The same provider lists the deployment's
`verifiedEmailDomains` and, with `adminPortalSignIn` on, the admin portal's
`browser` sign-in: the Core API client ID, the scopes `openid email profile`,
the `email` claim, and the client secret in `ENTRA_BROWSER_CLIENT_SECRET`, read
from Key Vault. Core also receives `CLOUD_CORE_ADMIN_PORTAL_URL` (its own
origin) and `CLOUD_CORE_ADMIN_STATIC_DIR` (the portal built into the image),
and, with `adminPortalSignIn` on, its sign-in server's settings:
`CLOUD_CORE_OIDC_ISSUER` (its own origin), `CLOUD_CORE_OIDC_COOKIE_KEYS` and
`CLOUD_CORE_OIDC_ADMIN_PORTAL_CLIENT_SECRET` (generated into Key Vault as
`oidc-cookie-keys` and `oidc-admin-portal-client-secret`), and
`CLOUD_CORE_OIDC_CLIENTS` with the admin portal as its one client. See
[the cloud-neutral contract](../../private-deployment.md).

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

Meeting creation also needs a Teams application access policy, which only Teams
PowerShell can set. `configure-teams` writes the script to
`mentra-state/teams-policy.ps1` and, once the rollout has moved the deployment
to the app, runs it as the operator: in Cloud Shell
Teams PowerShell signs in as the Cloud Shell user (`Connect-MicrosoftTeams
-Identity`); elsewhere setup passes the account's Graph and Teams admin tokens
from the Azure CLI (`Connect-MicrosoftTeams -AccessTokens`). When the operator
isn't a Teams administrator, setup prints a **Still to do** line, and a Teams
administrator runs the same file once in Cloud Shell (Switch to PowerShell) with
`& ./teams-policy.ps1`; outside Cloud Shell it signs in with a device code.

The script creates or updates the `MentraMeetings` policy for the meetings app,
grants it to everyone (`-Global`) and to the guest meeting organizer when one is
configured, and removes the Graph app it replaces after a switch. It never takes
the place of another app's policy: when the tenant already has application
access policies other than Mentra's (including the copy of `MentraMeetings` that
`-Global` makes in `Global`), it stops without changing anything and says which
policy to add the meetings app to. Re-running it is safe.
See the [Runtime API contract](../../private-deployment.md#teams-meeting-creation)
for identity selection and the [deployment inputs](./README.md#teams-meeting-creation)
for secret/configuration wiring.

## Qualification

- Assigned employee sign-in and silent Core/Teams token acquisition.
- Admin portal sign-in as an Organization Admin with an email in a listed
  domain; refusal for a person not on `coreAdminEmails` and for an email in
  another domain.
- Unassigned employee, wrong tenant, wrong audience, and wrong client rejection.
- MFA and Conditional Access browser return.
- Logout and workspace switching without credential crossover.
- Revoked consent and disabled-user behavior.
- Official Android APK/Play and iOS redirect paths.
- Meeting creation as a licensed employee, fallback creation for an unlicensed
  or non-Entra caller, Graph policy rejection without fallback, and retirement
  restricted to the creating caller.
