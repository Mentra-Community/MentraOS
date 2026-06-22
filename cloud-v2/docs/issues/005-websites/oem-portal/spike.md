# Cloud v2 OEM Portal Spike

**Status:** In progress. Surfaces what's known and what still needs
team input before a spec can be written.

## Why this spike

We're building OEM auth (specified in
[`../../001-cloud-core/auth/oem-auth.md`](../../001-cloud-core/auth/oem-auth.md)) and OEMs need somewhere to:

- Sign up and log in
- Manage their account
- Register/rotate the public key Mentra uses to verify their JWTs
- View active sessions and revoke when needed
- Invite teammates

That "somewhere" is a portal — a web app with its own auth surface
for OEM employees. It's distinct from the runtime OEM auth specced
in 001 (which is server-to-server, no user UI), and distinct from
the Mentra mobile app login (consumer auth on Supabase).

This spike captures research on auth providers, prior-art portal
designs, and decisions still pending before we can spec the portal.

## Concepts primer

- **B2B SaaS auth.** Auth for business customers' admin users.
  Typical patterns: SSO from the customer's existing IdP (Google
  Workspace, Okta, Microsoft Entra), email+password fallback, MFA,
  audit logging. Different from consumer auth (B2C) where the user
  is the customer.
- **Organization / tenant.** A logical grouping of users in a B2B
  product. In our case, an "organization" is an OEM (e.g., "Acme
  Glasses"). Members of the org are OEM admin employees.
- **Member.** A user belonging to an organization. Multiple members
  per org (admin team), with roles (owner, admin, viewer, etc.).
- **Identity Provider (IdP).** The system that actually verifies the
  user's identity (Google, Okta, etc.). The portal trusts the IdP's
  attestation that "this user is alice@acme-oem.com."
- **AuthKit (WorkOS).** WorkOS's product for adding B2B auth to
  applications. Provides hosted login UI, IdP connection management,
  organization model, session management. Drop-in replacement for
  rolling your own B2B auth.

Cross-reference: auth jargon used in this spike that's also in 001
(JWT, JWK, etc.) is glossed in
[`../../001-cloud-core/auth/oem-auth.md`](../../001-cloud-core/auth/oem-auth.md).

## What the portal needs to do

Roughly in order of importance:

1. **OEM signup + login.** A new OEM creates an org, an admin logs
   in. Returning admins log in.
2. **Manage the runtime public key.** Upload a static public key,
   or register a JWK Set URL. This is the bridge from the portal UI
   to 001's `/api/oem/jwks` endpoint.
3. **View active sessions.** List sessions issued under this OEM.
   Useful for diagnostics ("user X says they can't connect — let's
   see if they have an active session").
4. **Revoke sessions.** Per-session (the OEM might want to log a
   user out for support reasons) or per-OEM (when terminating an
   integration).
5. **Invite teammates and manage roles.** Add other OEM admins;
   assign them roles. Owner can do anything, admin can manage
   integration config, viewer can only see.
6. **View account info.** OEM ID, display name, contact info,
   plan/tier (future), etc.

What's not in scope for v1 of the portal:

- Billing / payment flows
- Usage analytics beyond simple session counts
- Customer support ticketing
- Multi-org membership (one user belongs to multiple OEMs at once)

## Prior art surveyed

The four products most directly relevant to our case: WorkOS, Clerk
(B2B variant), Stytch (B2B), Auth0. All sell hosted B2B identity
infrastructure. All have organization/member models, SSO support,
hosted login UIs, and SDK integrations.

| Product | Strengths for our case | Weaknesses |
| --- | --- | --- |
| **WorkOS** | Purpose-built for B2B admin SSO. AuthKit gives a complete login UI out of the box. Strong SSO connector library. Org/member model is first-class. Pricing scales by org, not by login. | Less polished SDK ergonomics than Clerk. UI customization is more limited than self-hosted. |
| **Clerk** | Best DX of the bunch. Polished SDKs (React, Next.js especially). Great UI components for in-app account management. | More B2C-flavored historically; the B2B "Organizations" feature is newer. UI components are tightly coupled to React. |
| **Stytch B2B** | API-first, more flexibility for custom UIs. Good docs. | More work to integrate (less drop-in than WorkOS AuthKit or Clerk). Smaller community. |
| **Auth0** | Most mature, biggest community, most features. Used widely in enterprise. | Pricing escalates quickly. Overkill for our scale and use case. Their B2B "Organizations" model is layered on a B2C-first base. |

### Why WorkOS leads my list

- **AuthKit is genuinely drop-in.** A small React app + a server-side
  callback handler gets you a working portal login in hours, not days.
- **SSO connectors are first-class.** When an OEM says "we use Google
  Workspace" or "we use Okta," WorkOS lets the OEM admin configure
  the connection from a guided UI without us writing protocol code.
- **Pricing aligns with our shape.** Cheap for low-volume B2B login
  (which we are — dozens to hundreds of OEMs total). Per-org or
  per-MAU model rather than per-login.
- **Org/member is the data model, not a feature retrofit.** WorkOS
  built around organizations; many features (audit logs, SCIM, RBAC)
  assume them.

Open question: does **Clerk's better DX** outweigh WorkOS's B2B fit?
For a portal that's a small piece of the overall product, the answer
is probably no — AuthKit handles the boring 80% and we spend our DX
budget on the cloud, mobile app, and miniapp SDK instead.

### What about not using a vendor?

Rolling our own B2B portal auth would mean: building SSO connectors
(SAML, OIDC, Microsoft Entra, Google Workspace), org/member/role
data model, hosted login UI, session management, MFA, audit logs.
Probably 3-6 person-weeks for a basic version, ongoing maintenance,
and security surface area we own forever.

For the volume we expect (dozens to hundreds of OEMs), the
build-yourself math doesn't work. Vendor is right.

### Why we're not using Supabase for this

Supabase is fine for B2C consumer auth (Mentra mobile app) but
isn't built for the B2B admin patterns. Specifically:

- Org/member as first-class concepts: not native
- SSO connectors to enterprise IdPs: limited
- Audit logging at the level B2B admins expect: not built-in
- Pricing model fits consumer scale, not B2B scale

The cleaner story: keep Supabase for the consumer side (where it
fits), use a B2B-native tool for the portal.

## Portal architecture (working sketch)

Based on the WorkOS-as-auth-provider direction. Subject to change
when we write the spec.

```
                Browser (OEM admin)
                       │
                       ▼
                Portal Web App (Next.js or similar)
                       │
              ┌────────┴────────┐
              ▼                 ▼
     WorkOS AuthKit        Portal Backend
       (hosted UI)          (Bun/Hono?)
                                │
              ┌─────────────────┼──────────────┐
              ▼                 ▼              ▼
         WorkOS API         Mentra DB     Mentra /api/oem/*
         (org/member/    (portal data:   (managing OEM
          session/SSO)    org metadata,   runtime config)
                          audit logs)
```

Plain English of each piece:

- **Browser.** The OEM admin opens `portal.mentra.glass` in their
  browser.
- **Portal web app.** Static + dynamic UI. Probably Next.js since
  it's the ecosystem for AuthKit integration. Routes for login,
  account home, key management, sessions, team, etc.
- **WorkOS AuthKit.** Hosted by WorkOS. Handles the actual login UI
  (email/password, SSO redirects, MFA prompts, etc.). Returns a
  signed session token to our portal backend.
- **Portal backend.** Our service. Verifies WorkOS sessions,
  manages portal-specific data (member roles, audit logs), proxies
  calls to the cloud's `/api/oem/*` endpoints with the OEM's
  authority.
- **WorkOS API.** What we call to manage orgs, members, sessions,
  invitations.
- **Mentra DB.** Stores portal-specific things WorkOS doesn't track
  (e.g., audit logs we want, custom fields).
- **Mentra `/api/oem/*`.** The runtime cloud's OEM endpoints
  (specified in 001). The portal calls these on behalf of the
  authenticated admin to manage public keys, list sessions, revoke
  sessions, etc.

## Data model (working sketch)

Some lives in WorkOS, some in our DB.

In WorkOS:

```
Organization
  - id (WorkOS org ID)
  - name ("Acme Glasses")
  - SSO connections (WorkOS-managed)

Member (User)
  - id (WorkOS user ID)
  - email
  - organization_id
  - role (WorkOS roles)
```

In Mentra's DB:

```
oems (already in 001)
  - tenantId                       (stable, used in 001's auth path)
  - workosOrgId                  (link to WorkOS org)
  - displayName
  - createdAt
  - ...

portalAuditLog                  (new for the portal)
  - timestamp
  - workosUserId (member who took the action)
  - tenantId
  - action (e.g., "rotated public key", "revoked session", "invited member")
  - details (JSON blob)
```

The link between an OEM (Mentra-side) and a WorkOS Organization is
the `workosOrgId` field. When a new OEM signs up, we create a
WorkOS org and a Mentra `oems` document, link them.

## Open questions

These are the things that need team input before the spec can land.

1. **WorkOS or alternative?** I'm leading toward WorkOS based on the
   prior art comparison, but Clerk's DX is real. Worth a team
   vote with the trade-offs in front of them.

2. **Portal stack.** Next.js feels natural for the WorkOS path
   (AuthKit has a Next.js library). Alternatives: Bun + Hono with a
   light React UI; SvelteKit; etc. Lean: Next.js for the AuthKit
   integration, even though we use Bun on the cloud side.

3. **Portal deployment.** Same monorepo (`cloud-v2/portal/`) or
   separate? Same Porter app or its own? Lean: same monorepo,
   separate Porter app for deploy isolation.

4. **OEM signup flow.** Who gates new OEM signups?
   - Open self-serve: anyone can sign up, gets sandbox limits, must
     contact us to get production access.
   - Invite-only: we manually create OEM orgs as we sign deals.
   - Lean: invite-only for v1 (we're not handling self-serve
     volume yet); revisit if/when we want public signup.

5. **Multi-OEM membership.** Can one human be an admin of multiple
   OEM orgs? (E.g., a consultant working for two OEMs.)
   - Lean: no, for v1. Adds complexity without clear demand. Two
     separate accounts if they need both.

6. **Role granularity.** Owner / admin / viewer is the working
   sketch. What can each role do?
   - Owner: everything (manage members, change keys, view billing).
   - Admin: manage runtime config (keys, sessions), invite admins,
     can't change billing.
   - Viewer: read-only on everything.
   - Probably good enough; revisit if real customers want
     fine-grained permissions.

7. **Portal audit logging.** What do we audit?
   - Every key rotation, session revocation, member invitation /
     removal / role change.
   - Logged to MongoDB (`portalAuditLog` collection), retained how
     long?
   - Open: retention policy (90 days hot, archive after?).

8. **Mentra admin access to OEM portal.** Mentra internal admins
   need to be able to see and act on OEM data (for support, for
   terminating OEMs that violate terms).
   - How does Mentra admin auth into the portal? Via the same
     WorkOS, with a special Mentra-org role? Or a separate admin
     surface entirely?
   - Lean: separate `/admin` surface with Mentra-internal SSO
     (probably the same SSO we use for everything else internal),
     calling the same `/api/oem/*` endpoints with admin auth.

9. **Where the OEM provides the public key.** UI-wise: paste a PEM
   string, or upload a `.pem` file? Both? Lean: paste, with a
   visible "show me the openssl commands to generate this" helper.

10. **JWK Set URL validation.** When OEM enters a JWK Set URL, do
    we fetch it once at registration to confirm validity? Lean:
    yes, with a clear error if the URL isn't reachable or doesn't
    return a valid JWKS document.

## What feeds into the spec

Once the open questions above land, the spec will cover:

- The chosen auth provider (almost certainly WorkOS)
- Portal architecture and stack
- Signup / login flow
- Org / member / role data model
- Audit logging design
- Portal-to-cloud API integration (which `/api/oem/*` endpoints get
  called and when)
- Out-of-scope items (billing, fine-grained permissions, public
  self-serve signup)

## Related work

- [`../../001-cloud-core/auth/oem-auth.md`](../../001-cloud-core/auth/oem-auth.md) — runtime OEM auth. The
  portal manages config consumed by 001.
- Future audit / observability work — likely surfaces in the portal.
