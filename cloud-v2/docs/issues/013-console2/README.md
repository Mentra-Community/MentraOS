# 013 - Console2 Developer Console

**Status:** Draft.

## Problem

The old developer console is tied to the v1 server-hosted app model and legacy
auth. Cloud v2 needs a new developer console focused on miniapp packages,
bundles, publishing, testing, logs, and CLI authorization.

This surface is distinct from the enterprise/OEM portal and the internal admin
site.

## Product Boundary

```txt
console2.mentraglass.com
console2.dev.mentraglass.com
console2.staging.mentraglass.com
```

Console2 is for miniapp developers. It should not contain OEM runtime issuer
configuration or internal admin review queues except for developer-visible
submission status.

## Goals

- Provide developer login and org management for miniapp teams.
- Authorize `mentra login`.
- Show packages, bundles, versions, channels, signing provenance, and logs.
- Let developers claim package names and submit bundles for review.
- Keep bundle-owned fields read-only: the repo manifest is source of truth.
- Use Cloud Core APIs backed by the miniapp registry.

## Non-goals

- Do not replace the internal admin site.
- Do not manage OEM trusted issuers.
- Do not make web form edits the source of truth for miniapp permissions,
  entrypoints, SDK version, or hardware requirements.

## Auth Direction

Use WorkOS/AuthKit for Console2 auth unless a later spike overturns it. WorkOS is
the identity/session provider; Cloud Core is the product authorization source.

```ts
interface IdentityUser {
  id: string
  workosUserId: string
  email: string
  name?: string
  linkedMentraUserId?: string
}

interface DeveloperOrg {
  id: string
  workosOrgId: string
  displayName: string
  packagePrefix: string
  packagePrefixStatus: "unverified" | "verified" | "rejected"
  createdAt: string
}

interface DeveloperMembership {
  id: string
  developerOrgId: string
  identityUserId: string
  role: "owner" | "admin" | "developer" | "viewer"
}
```

WorkOS can manage login, invitations, and org membership mechanics. Cloud Core
must still check package ownership and publish permissions.

The current implementation starts with a Cloud Core-owned developer org record.
After a developer signs in, `GET /api/console/auth/me` returns
`onboardingRequired=true` until they create an org. The setup flow asks for:

- organization display name
- globally unique package prefix, for example `io.acme`

Core stores this in `developer_orgs` and all miniapp package names must start
with the org's prefix. Reserved prefixes such as `com.mentra` cannot be claimed
by arbitrary accounts. Prefix verification is separate from reservation:
unverified prefixes can be used for development, while public store submission
can later require domain/brand verification.

## Core Screens

1. Sign in.
2. CLI authorization.
3. Home/dashboard.
4. Packages/apps list.
5. Package detail.
6. Bundle versions.
7. Testing channel.
8. Store listing/submission status.
9. Logs/sessions.
10. Tokens and signing keys.

## Package Detail Tabs

The Figma direction has the right mental model: bundle metadata is read-only and
comes from the uploaded artifact.

```txt
Overview
Permissions
Testing
Store listing
Submission
Logs
Versions
```

Read-only bundle-owned data:

- packageName
- version
- permissions
- hardware requirements
- entrypoints
- SDK version
- bundle size/hash
- manifest hash

Console-editable server-side data:

- developer org ownership and member access
- store listing copy/images if we decide not to keep them in bundle
- testing channel assignment
- submission notes
- signing key management

## CLI Authorization Flow

```txt
mentra login
  -> opens Console2 authorize URL
  -> user signs in through WorkOS
  -> user selects DeveloperOrg
  -> user approves CLI scopes
  -> CLI receives short-lived credential / refresh mechanism
```

Scopes:

```txt
packages:read
packages:write
bundles:publish
submissions:write
logs:read
signing_keys:write
```

## User Stories

1. A developer logs into Console2 and creates or joins a developer org.
2. A developer authorizes the CLI from the browser.
3. A developer claims a package name.
4. A developer publishes a bundle from CLI and sees it in Console2.
5. A developer submits a version for store review.
6. A developer sees reviewer feedback and uploads a corrected version.
7. A developer rotates or revokes a local signing key.
8. A developer views runtime logs for their package.

## API Dependencies

Console2 depends on:

- `011-miniapp-registry` package/bundle/submission APIs.
- `012-mentra-cli-v2` auth and signing key APIs.
- Cloud Core identity/session APIs for WorkOS-backed users and orgs.

Current org endpoints:

```txt
GET /api/console/org
PUT /api/console/org
```

`PUT /org` creates or updates the user's primary developer org. Package prefix
changes are rejected after the org has active miniapps, because installed app
identity depends on the prefix remaining stable.

## Open Decisions

- Whether Console2 should be Vite or Next.js.
- Whether store listing metadata is bundle-owned, console-owned, or split.
- Exact WorkOS role mapping for DeveloperOrg roles.
- Whether developers can belong to multiple DeveloperOrgs at MVP.
- Whether package claiming requires email/domain verification for some package
  name patterns.
