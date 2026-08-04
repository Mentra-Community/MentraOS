# Cloud v2 Enterprise/OEM Portal

**Status:** Draft. Spike exists; current proposal is in
[`../../014-enterprise-portal/`](../../014-enterprise-portal/).

## Problem

Enterprise and OEM admins need a way to log in to Mentra, manage their account,
register trusted JWT issuers/JWKS URLs, test token exchange, invite teammates,
and handle other administrative tasks.

This is a B2B admin surface, distinct from:

- **The runtime OEM auth path** (specified in
  [`../../001-cloud-core/auth/oem-auth.md`](../../001-cloud-core/auth/oem-auth.md)). That doc covers how an
  OEM's backend authenticates its *users* to Mentra cloud. This doc
  is about how OEM employees log in to manage their company's
  Mentra integration.
- **The Mentra mobile app login**. That's consumer auth (currently
  Supabase) for the end users of glasses. Different security
  posture, different scale, different concerns.

## Files

- `README.md` — this doc
- [`spike.md`](./spike.md) — research, prior art on B2B admin auth
  platforms (WorkOS, Clerk B2B, Stytch B2B, Auth0), portal scope
  considerations, decisions still to make
- [`../../014-enterprise-portal/`](../../014-enterprise-portal/) — current draft
  spec based on the latest model
- `spec.md` — not yet written in this folder; superseded for now by 014
- `design.md` — not yet written; follows spec

## tl;dr (as of spike)

Working assumption: **use WorkOS for the OEM portal auth layer.**
WorkOS's AuthKit product is purpose-built for B2B admin SSO: OEMs
can plug in their own Identity Provider (Google Workspace, Okta,
Microsoft Entra, generic SAML/OIDC) once, their admins use their
existing corporate login. Email + password is also supported for
OEMs without an IdP.

The latest model intentionally keeps the portal lean:

```txt
EnterpriseOrg
EnterpriseMembership
TrustedIssuer
```

`TrustedIssuer.issuer` is the exact JWT `iss` value and should be a standards-
aligned HTTPS issuer URL, not a custom `tenantId/env` string.

The portal itself is a small web app with surfaces for:

- Login (handled by WorkOS AuthKit)
- Account info (the enterprise org's `tenantId`, display name, etc.)
- Trusted issuer / JWK Set URL management
- Token exchange test tool
- Team management (invite admins, role assignment)
- Audit log
- Usage and observability surfaces (future)

The portal data model is separate from Console2's developer org model. A user
may have access to both products, but the portal models enterprise/OEM auth
administration, not miniapp package ownership.

Full reasoning, alternatives considered, and open questions in
[`spike.md`](./spike.md). Current draft proposal:
[`../../014-enterprise-portal/`](../../014-enterprise-portal/).

## Scope boundary

What's in scope:
- OEM admin login flow
- Portal web app (the screens, routes, role-based access)
- Enterprise org / member / role data model
- Trusted issuer and JWKS URL management
- Token exchange test tool

What's not in scope:
- The runtime token-exchange endpoint (in 001)
- Mentra mobile app user auth (separate, Supabase for now)
- Dev console / Console2 (separate developer surface)
- Internal admin site (separate Mentra operator surface)
- Miniapp store (separate; consumer surface)

## Cross-references

- [`../../014-enterprise-portal/`](../../014-enterprise-portal/) — current
  draft spec.
- [`../../001-cloud-core/auth/oem-auth.md`](../../001-cloud-core/auth/oem-auth.md) — runtime OEM auth. The
  portal's trusted issuer UI manages the configuration used by this exchange
  path.
- Future: audit logging, usage analytics, billing surfaces all
  attach to the portal eventually.
