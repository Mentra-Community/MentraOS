# Cloud v2 OEM Portal

**Status:** Spike in progress. Spec and design pending.

## Problem

OEM admins need a way to log in to Mentra, manage their account,
register and rotate their public key, view runtime usage and active
sessions, invite teammates, and handle other administrative tasks.

This is a B2B admin surface, distinct from:

- **The runtime OEM auth path** (specified in
  [`../001-oem-auth/`](../001-oem-auth/)). That doc covers how an
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
- `spec.md` — not yet written; pending team review of spike findings
- `design.md` — not yet written; follows spec

## tl;dr (as of spike)

Working assumption: **use WorkOS for the OEM portal auth layer.**
WorkOS's AuthKit product is purpose-built for B2B admin SSO: OEMs
can plug in their own Identity Provider (Google Workspace, Okta,
Microsoft Entra, generic SAML/OIDC) once, their admins use their
existing corporate login. Email + password is also supported for
OEMs without an IdP.

The portal itself is a small web app with surfaces for:

- Login (handled by WorkOS AuthKit)
- Account info (the OEM's `oemId`, display name, etc.)
- Public-key / JWK Set URL management (calls into
  [`../001-oem-auth/`](../001-oem-auth/) endpoints under
  `/api/oem/jwks`)
- Active sessions view (calls
  [`../001-oem-auth/`](../001-oem-auth/) endpoints for listing /
  revoking)
- Team management (invite admins, role assignment)
- Usage and observability surfaces (future)

The portal data model: OEMs have **organizations** (the OEM
company), with **members** (admin users) belonging to roles
(owner, admin, viewer). Each member belongs to exactly one OEM.

Full reasoning, alternatives considered, and open questions in
[`spike.md`](./spike.md).

## Scope boundary

What's in 002:
- OEM admin login flow
- Portal web app (the screens, routes, role-based access)
- Org / member / role data model
- UI for managing the OEM's runtime config (calls the 001 APIs)

What's not in 002:
- The runtime token-exchange endpoint (in 001)
- Mentra mobile app user auth (separate, Supabase for now)
- Dev console (separate; consumer auth surface)
- Miniapp store (separate; consumer surface)

## Cross-references

- [`../001-oem-auth/`](../001-oem-auth/) — runtime OEM auth. The
  portal's "manage public key" UI calls 001's endpoints.
- Future: audit logging, usage analytics, billing surfaces all
  attach to the portal eventually.
