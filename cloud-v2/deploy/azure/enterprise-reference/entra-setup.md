# Microsoft Entra setup for a Mentra workspace

Deployment schema v1 uses one single-tenant Microsoft Entra public client. The
same cached employee account supplies two separate access tokens:

- a Runtime API token with `mentra.runtime`;
- an ACS resource token with `Teams.ManageCalls` and `Teams.ManageChats`.

The employee signs in once. The Mentra App never receives their password, and
the customer does not provide credentials to Mentra.

## 1. Register the Runtime API

The supported setup helper performs sections 1–2 idempotently and prints the
tenant id, both client ids, Runtime scope, and Mobile service-principal id:

```bash
cloud-v2/deploy/azure/enterprise-reference/scripts/configure-entra.sh \
  --runtime-name "ACME Mentra Runtime" \
  --mobile-name "ACME Mentra Mobile"
```

Run it without `--grant-admin-consent` first so the administrator can review the
registrations and requested permissions. Then rerun with the printed
`--runtime-client-id`, `--mobile-client-id`, and `--grant-admin-consent`.
Employee/group assignment remains an explicit administrator action.

Create an app registration in the customer's tenant for the customer-hosted
Runtime:

1. Select **Accounts in this organizational directory only**.
2. Set the Application ID URI to `api://<runtime-application-client-id>`.
3. Request v2 access tokens.
4. Expose the delegated scope `mentra.runtime`.
5. Record the tenant id, Runtime application client id, and full scope string.

Runtime validates the exact tenant issuer, Microsoft JWKS signature, Runtime
application audience, `mentra.runtime` scope, employee object id, and approved
mobile client id on every protected request.

## 2. Register the Mentra App public client

Create a second, single-tenant app registration as a mobile/desktop public
client. It has no client secret.

Add platform redirects for the exact official binary being distributed:

- iOS: `msauth.com.mentra.mentra://auth`;
- Android: `msauth://com.mentra.mentra/<base64-signing-certificate-hash>`.

Android debug and release certificates produce different redirects. Customer
qualification must register the hash of the Mentra-signed release APK or AAB;
the reference tenant also contains a local debug redirect for development.
The current official redirects are:

- Mentra-signed downloadable APK:
  `msauth://com.mentra.mentra/q%2FZbvbReOLgD1T6V3o1PK%2Fzjwz0%3D`;
- Google Play App Signing:
  `msauth://com.mentra.mentra/Pwi%2FLvF9HHWTAMonaqwan%2BeIX6A%3D`.

These certificate hashes are public application identifiers, not private keys.

Add delegated API permissions for:

- the Runtime registration's `mentra.runtime` scope;
- Azure Communication Services `Teams.ManageCalls`;
- Azure Communication Services `Teams.ManageChats`.

Grant tenant-wide admin consent. No Microsoft Graph meeting-creation or
calendar permission is required for the join-only deployment.

From the Mobile app registration's **Overview** page, select **Managed
application in local directory** to open the resulting service principal. This
path works even if the default **Enterprise applications** list does not show
it. Service principals created through Microsoft Graph or Azure CLI should have
the `WindowsAzureActiveDirectoryIntegratedApp` tag so they appear normally in
that list. Apply the tag to both the Mobile and Runtime service principals; it
is portal metadata and does not affect tokens.

On the Mobile service principal, enable **Assignment required** and assign only
the users or groups authorized for the Mentra workspace. Do not assign employees
to the Runtime service principal. Runtime still validates token claims;
assignment to the Mobile application is the tenant-side enrollment gate.

Leave custom token-signing keys and custom **Attributes & Claims** unconfigured.
Runtime relies on Entra's standard OIDC claims, including issuer, tenant,
audience, scope, authorized client, expiry, and employee object id.

## 3. Configure the deployment manifest

Use the exact tenant and public-client registration:

```json
{
  "auth": {
    "mode": "microsoft-entra",
    "authorityUrl": "https://login.microsoftonline.com/<tenant-id>",
    "clientId": "<mobile-public-client-id>",
    "runtimeScopes": ["api://<runtime-application-client-id>/mentra.runtime"],
    "teamsScopes": [
      "https://auth.msft.communication.azure.com/Teams.ManageCalls",
      "https://auth.msft.communication.azure.com/Teams.ManageChats"
    ]
  }
}
```

The Mentra App accepts an exact tenant authority only. It does not accept
`common`, `organizations`, `consumers`, redirects, or an identity-provider
picker after the workspace has been selected.

## 4. Configure Runtime

Set:

- `CLOUD_RUNTIME_AUTH_AUDIENCE` to the Runtime application client id;
- `CLOUD_RUNTIME_AUTH_ISSUERS` to the exact tenant v2 issuer and discovery JWKS,
  with `userIdClaim: "oid"`, the fixed tenant id, `requiredScopes:
  ["mentra.runtime"]`, and `allowedClientIds` containing the mobile public
  client id;
- `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID` to the same tenant and mobile client;
- `ACS_CONNECTION_STRING` through the deployment secret store.

Never place the ACS connection string, a user token, or a client secret in the
manifest. The mobile app sends the ACS-scoped employee token only to the
configured Runtime over TLS. Runtime verifies that its tenant, client, and
employee object id match the authenticated Runtime identity before exchanging
it for a short-lived ACS Teams-user token.

## 5. Qualification

Before customer use, verify at least:

- assigned employee sign-in and silent Runtime/Teams token acquisition;
- unassigned and wrong-tenant rejection;
- MFA and Conditional Access browser return;
- logout and workspace switching without account crossover;
- revoked consent and disabled-user behavior;
- both official Android and iOS redirect URIs.

The reference Runtime exposes the same minimum-client-version policy used by
Mentra's public deployment. It is independent of the Entra registration and
defaults to allowing every workspace-capable Mentra App release.
