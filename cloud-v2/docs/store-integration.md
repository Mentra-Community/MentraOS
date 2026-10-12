# Store integration: Core's service API

The Mentra Miniapp Store is a separate service with its own database. It asks
Core who someone is and which workspaces they belong to, through a signed
service API at `/api/internal/workspaces/*`. Core never calls the Store and needs
no Store address. Workspaces, roles and keys are described in
[Workspaces and keys](workspaces.md).

The client is `createCoreWorkspaceClient` from
`@mentra/workspace-contract/server`; the request and response types are in
`@mentra/workspace-contract`.

## Signing

Every request carries:

- `x-mentra-service`: `store`;
- `x-mentra-service-timestamp`: Unix milliseconds, digits only, within 60
  seconds of Core's clock;
- `x-mentra-service-signature`: HMAC-SHA256, base64url, over
  `<timestamp>\n<METHOD>\n<path with query>\n<sha256 hex of the body>`.

Core accepts any secret in its list for the service, so a secret rotates by
listing the new one beside the old one. A missing header, a wrong signature, an
unknown service or a stale timestamp all answer
`401 {"error": "service_unauthorized"}`. A malformed `CLOUD_CORE_SERVICE_SECRETS`
answers `503 {"error": "service_auth_misconfigured"}` to every call. No request
or answer names an organization: the Store knows which Core it talks to from the
URL it is configured with, and the shared secret proves both sides.

Core's `CLOUD_CORE_SERVICE_SECRETS` is `{"store": ["<newest>", "<older>"]}`; the
Store holds one value from that list. Keep both in the secret manager.

## Routes

| Route | Answers |
| --- | --- |
| `POST /authorize` | `AuthorizeResponse`: may this principal do `capability` in `workspaceId`, for `packageName`? |
| `POST /principal` | `PrincipalResponse`: the principal behind a bearer token and its workspaces, or `401 invalid_token`. |
| `POST /memberships/check` | `{memberships}`: one person's role and capabilities in up to 100 workspaces, `null` where they are not a member. |
| `GET /workspaces/:workspaceId` | `WorkspaceSummary` (name, status, authorization revision), or `404 workspace_not_found`. |
| `POST /credentials` | `{credentialId, token}`: a workspace key limited to the named packages, minted for the Store on behalf of a staff member (`issuedBy.actorEmail`). The token is returned once. |
| `POST /users/resolve-email` | `{mentraUserId}` of the Mentra account whose confirmed email this is (the Core user is created on first use), or `404 user_not_found`. |

- **Principals.** A bearer credential is what a person or a key presented to the
  Store: a Core access token from the Core's sign-in server (issued to the
  Developer Console or the CLI, first-party clients in
  `CLOUD_CORE_OIDC_CLIENTS`; see [`signin.md`](signin.md)) or a Core key. Phone
  Core tokens, ID tokens, Supabase tokens and another environment's tokens are
  refused. A `mentra_user` credential is the Store vouching for a
  person it already authenticated; that person is never an Organization Admin
  here.
- **Package scope.** A key limited to some packages is refused
  (`package_out_of_scope`) for any other package, but only when `packageName`
  is sent: without it the capability is granted workspace-wide. Send
  `packageName` on every route that reads or changes one package, and filter
  package lists by the principal's `packageNames`.
- **Denials** never throw: `allowed` is false and `reason` says why
  (`unauthenticated`, `not_a_member`, `capability_missing`,
  `workspace_not_found`, `workspace_deleted`, `package_out_of_scope`,
  `credential_invalid`). A key that does not validate is `credential_invalid`.
- **Outages.** When the identity provider cannot be asked, `/authorize` and
  `/principal` answer `503 {"error": "temporarily_unavailable"}`. Treat it as
  retryable; never as an allow.

Authorization decisions use current state. Display data (workspace names) may
be cached for up to five minutes; a cached answer never authorizes a write.
