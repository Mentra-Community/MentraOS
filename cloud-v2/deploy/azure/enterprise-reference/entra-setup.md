# Microsoft Entra setup for a Mentra workspace

The employee signs in once through the official Mentra App. MSAL obtains two
separate tokens from the same cached account:

- a customer Core API token with delegated `mentra.session` scope; and
- an ACS resource token with `Teams.ManageCalls` and `Teams.ManageChats`.

The Mentra App exchanges the first token with customer Core for a
deployment-scoped Mentra session. Runtime accepts only short-lived tokens issued
by that Core. Neither Mentra nor customer services receive the employee's
Microsoft password.

## Automated setup

Run the idempotent helper while signed into the customer's tenant as an
Application, Cloud Application, or Global Administrator:

```bash
cloud-v2/deploy/azure/enterprise-reference/scripts/configure-entra.sh \
  --core-name "ACME Mentra Core" \
  --mobile-name "ACME Mentra Mobile"
```

Run without `--grant-admin-consent` first, review the two registrations and
permissions, then rerun with the printed ids:

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
`ACS_CONNECTION_STRING`. For ACS exchange, Runtime requires Core's explicit
`providerKind: microsoft-entra` binding and then verifies that the ACS token's
`oid` and `tid` match the same employee and directory.

## Qualification

- Assigned employee sign-in and silent Core/Teams token acquisition.
- Unassigned employee, wrong tenant, wrong audience, and wrong client rejection.
- MFA and Conditional Access browser return.
- Logout and workspace switching without credential crossover.
- Revoked consent and disabled-user behavior.
- Official Android APK/Play and iOS redirect paths.
