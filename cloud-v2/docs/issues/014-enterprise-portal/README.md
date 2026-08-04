# 014 - Enterprise/OEM Portal

**Status:** First Core API, data models, token-exchange lookup, and portal
website slice are implemented locally. WorkOS org-role hardening, JWKS test
tooling, audit logs, and production portal deployment are next.

## Problem

OEMs and enterprise customers need a portal to manage the identity issuers Cloud
Core trusts for token exchange. This is a B2B admin surface, distinct from
Console2 and from internal admin.

The first portal primitive is not runtime hosting. It is trusted issuer
registration: which HTTPS issuer URLs and JWKS URLs are allowed to sign subject
tokens for an enterprise org.

## Product Boundary

```txt
portal.mentraglass.com
portal.dev.mentraglass.com
portal.staging.mentraglass.com
```

Portal is for enterprise/OEM admins. Console2 is for miniapp developers. A single
human may have access to both, but the DB models and product permissions are
separate.

## Goals

- Use WorkOS/AuthKit for enterprise admin login and org membership.
- Model enterprise orgs separately from developer orgs.
- Let admins register multiple trusted issuer environments.
- Route token exchange on the minted `tenantId` + `env` claims, while keeping `iss`
  a real HTTPS issuer URL that is validated (pinned) at signature time.
- Let Core exchange OEM subject tokens into Cloud Core / Cloud Runtime tokens.
- Leave runtime-hosting controls as a later optional layer.

## Non-goals

- Do not merge enterprise orgs and developer orgs into one all-purpose org.
- Do not make `iss` itself a custom `tenantId/env` string. `iss` stays a standard
  HTTPS issuer URL; routing uses **separate** `tenantId` + `env` claims so one
  issuer URL can serve multiple environments and orgs.
- Do not require an OEM to self-host runtime just to use OEM auth.
- Do not build billing/contract management in MVP.

## Data Models

```ts
interface EnterpriseOrg {
  id: string
  ownerUserId: string
  workosOrgId?: string | null
  tenantId: string
  name: string
  slug: string
  status: "active" | "disabled"
  createdAt: string
  updatedAt: string
}

interface EnterpriseMembership {
  id: string
  enterpriseOrgId: string
  workosUserId: string
  role: "owner" | "admin" | "viewer"
}

interface TrustedIssuer {
  id: string
  enterpriseOrgId: string
  environmentName: string
  issuer: string
  jwksUrl: string
  subjectClaim: "sub" | string
  enabled: boolean
  createdAt: string
  updatedAt: string
}
```

`EnterpriseOrg.tenantId` is our stable internal/customer identifier. It is the value
the enterprise puts in the token's `tenantId` claim — the token-exchange lookup key.
It is not the JWT issuer.

`TrustedIssuer.issuer` is the exact JWT `iss` value. It is **validated** (pinned)
at signature time, not used as the lookup key, so it is **not** globally unique —
the same issuer URL may serve multiple environments and multiple orgs. It should
still follow the OIDC-style shape:

```txt
https://auth.acme.com
https://sandbox-auth.acme.com
https://auth.acme.com/sandbox
```

No query string or fragment.

## JWT Claim Contract

Enterprise subject tokens must carry:

```txt
tenantId  -> EnterpriseOrg.tenantId (the id shown in the portal) — the lookup key
env    -> a registered TrustedIssuer.environmentName (e.g. sandbox, prod)
iss    -> the exact registered TrustedIssuer.issuer URL (validated, not the key)
aud    -> cloud-core or mentra
sub    -> the user id (or whichever claim `subjectClaim` names)
exp, iat, jti
```

## Token Exchange Lookup

```txt
decode JWT without trusting it
  -> read tenantId + env claims
  -> lookup EnterpriseOrg whose tenantId == the tenantId claim; require it to be active
  -> lookup TrustedIssuer by (enterpriseOrgId, environmentName == env); require enabled
  -> verify signature using jwksUrl, pinning iss == TrustedIssuer.issuer
  -> verify aud=cloud-core or mentra
  -> read subjectClaim, usually sub
  -> map (enterpriseOrg.tenantId, trustedIssuer.environmentName, subject) to user
  -> mint normalized cloud-core/cloud-runtime tokens
```

A token carrying `tenantId` is unambiguously an enterprise token: a lookup miss is a
hard `unauthorized_client`, not a fall-through. Tokens **without** a `tenantId`
claim take the legacy path — Core keys on `iss` (which a legacy OEM sets to its own
tenant id) against the older static `OemModel` table — preserving compatibility for
legacy/test OEM IDs.

## Implemented Core API

```txt
GET   /api/portal/health
GET   /api/portal/me
GET   /api/portal/org
PUT   /api/portal/org
GET   /api/portal/trusted-issuers
POST  /api/portal/trusted-issuers
PATCH /api/portal/trusted-issuers/:trustedIssuerId
```

Portal auth reuses the WorkOS sealed session machinery from Console2 for the
first slice, but stores enterprise orgs separately from developer orgs. The
portal lives at:

```txt
cloud-v2/websites/portal
bun run dev:portal   # http://localhost:5175
```

## Portal Screens

1. Sign in. Implemented by redirecting to the shared WorkOS login.
2. Org overview. Implemented.
3. Trusted issuers list. Implemented.
4. Add/update trusted issuer. Implemented.
5. JWKS validation and key preview. Next.
6. Token exchange test tool. Next.
7. Team and roles. Next.
8. Audit log. Next.

## User Stories

1. An enterprise admin signs in with company SSO.
2. An admin sees their `tenantId`.
3. An admin registers `https://sandbox-auth.acme.com` as a sandbox trusted
   issuer with a JWKS URL.
4. An admin validates that Cloud Core can fetch the JWKS and verify a sample JWT.
5. An admin disables a compromised trusted issuer.
6. An owner invites another admin.
7. A viewer can inspect issuer configuration but cannot edit it.

## Future Runtime Hosting Layer

Runtime hosting should be added only when needed:

```ts
interface RuntimeHostingConfig {
  id: string
  enterpriseOrgId: string
  environmentName: string
  mode: "mentra_hosted" | "self_hosted" | "proxy"
  runtimeBaseUrl?: string
  coreProxyBaseUrl?: string
}
```

This is intentionally not the center of the MVP. An enterprise can use its own
issuer and still use Mentra-hosted runtime.

## Open Decisions

- `environmentName` is unique per EnterpriseOrg in the first implementation.
- Whether `tenantId` is chosen by the customer, assigned by Mentra, or both with
  approval.
- Exact WorkOS role mapping.
- Whether portal and Console2 share one WorkOS project or separate projects.
- Whether token exchange test tooling stores sample JWTs or keeps them
  browser-only.

## Verification

Current local checks:

```txt
bun test tests/enterprise-portal.integration.test.ts
```

The integration test creates an enterprise org, adds prod and sandbox trusted
issuers, disables one issuer, verifies issuer listing, confirms the tenant id is
locked after issuers exist, and rejects non-HTTPS issuer URLs.
