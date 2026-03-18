# Spike: Console Organization Creation Infinite Loop

## Overview

**What this doc covers:** Root cause analysis of the bug where new developer console users get stuck on the Organization Settings page with cycling "created" / "failed" toast messages and a permanent loading spinner.

**Why this doc exists:** Multiple users reported being unable to create their first app because organization creation loops forever. Production logs show 7,000+ duplicate-key errors from a single user session on Feb 21, 2026.

**Who should read this:** Anyone working on the cloud console, developer portal auth, or the organization system.

## Background

When a user signs into the developer console (`console.mentra.glass`) for the first time, the system needs to create a "personal organization" for them. Organizations own apps — you can't publish without one.

The org creation is attempted from **five independent code paths** that can all fire concurrently on a single page load:

```
Browser loads console
  ├─ GET /api/console/account/me  → getConsoleAccount()      → createPersonalOrg()  [1]
  ├─ findOrCreateUser()           → (inside account fetch)    → createPersonalOrg()  [2]
  ├─ validateSupabaseToken()      → (dev portal middleware)   → createPersonalOrg()  [3]
  ├─ OrganizationContext           → loadOrganizations()      → ensurePersonalOrg()  [4]
  └─ OrganizationSettings          → useEffect                → ensurePersonalOrg()  [5]
```

Each org gets a URL slug derived from its name. The `slug` field has a **unique index** in MongoDB.

## Findings

### 1. Slug generation has no uniqueness handling

Two separate `generateSlug` functions exist:

**`organization.service.ts` (async, used by `createPersonalOrg` and `createOrg`):**

```ts
// packages/cloud/src/services/core/organization.service.ts
async function generateSlug(name: string): Promise<string> {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  if (!slug) slug = "org"
  return slug // No uniqueness check
}
```

**`organization.model.ts` (sync static, used by console `orgs.service.ts`):**

```ts
// packages/cloud/src/models/organization.model.ts
OrganizationSchema.statics.generateSlug = function (name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  // No uniqueness check, can't do DB lookup (synchronous)
}
```

Neither checks if the slug already exists. Two users both named "alex" both get slug `alex-s-org` → the second one gets `E11000 duplicate key error` every time.

### 2. `createPersonalOrg` is not idempotent

```ts
// packages/cloud/src/services/core/organization.service.ts
public static async createPersonalOrg(user: UserI): Promise<Types.ObjectId> {
  const personalOrgName = `${user.profile?.company || user.email.split("@")[0]}'s Org`;
  const slug = await generateSlug(personalOrgName);
  const org = new Organization({ name: personalOrgName, slug, ... });
  await org.save();  // No check for existing org, no catch for E11000
  return org._id;
}
```

No guard to check "does this user already have an org?" before creating. No handling of the duplicate key error if the slug collides. Every call blindly attempts to insert.

### 3. Frontend `useEffect` creates an infinite retry loop

```tsx
// websites/console/src/pages/OrganizationSettings.tsx
useEffect(() => {
  const createPersonalOrg = async () => {
    if (!currentOrg && !orgLoading && !isCreatingOrg) {
      setIsCreatingOrg(true)
      try {
        await ensurePersonalOrg()
        toast.success("A personal organization has been created for you.")
      } catch (err) {
        toast.error("Failed to create a personal organization.")
      } finally {
        setIsCreatingOrg(false)
      }
    }
  }
  createPersonalOrg()
}, [currentOrg, orgLoading, ensurePersonalOrg, isCreatingOrg])
//                          ^^^^^^^^^^^^^^^^^   ^^^^^^^^^^^^^^
//                          new ref every render  toggles on fail → retrigger
```

Two problems in the dependency array:

- **`ensurePersonalOrg`** — defined as a plain arrow function in `OrganizationContext.tsx`, not wrapped in `useCallback`. New reference every render → effect re-fires every render.
- **`isCreatingOrg`** — flips `true → false` after each failed attempt. Since `currentOrg` is still `null` (no org was created), the guard passes again → immediate retry.

This creates a tight loop: ~500ms per attempt × thousands of attempts per hour.

### 4. `user.save()` causes Mongoose VersionError under concurrency

Every org-bootstrap path does this pattern:

```ts
user.organizations.push(personalOrgId)
user.defaultOrg = personalOrgId
await user.save() // Mongoose optimistic concurrency check
```

When two paths modify the same user document concurrently, the second `save()` fails with:

```
No matching document found for id "69993ff54c75011ea9b10b84" version 369 modifiedPaths "organizations"
```

This was confirmed in the production logs for user "chris" on the same day.

### 5. Production logs confirm the full chain

Queried Better Stack logs for Feb 21, 2026:

| Slug                   | Error count | First | Last           | Duration       |
| ---------------------- | ----------- | ----- | -------------- | -------------- |
| `alex-s-organization`  | 7,015       | 11:10 | next day 12:18 | ~25 hours      |
| `alex-s-org`           | 8           | 11:10 | 15:26          | (intermittent) |
| `chris-s-organization` | 1,175       | 05:17 | 21:01          | ~16 hours      |
| `david-s-organization` | 56          | 04:53 | 04:54          | ~1 min         |
| `mail-s-organization`  | 42          | 23:18 | 23:19          | ~1 min         |

The timeline for Alex at 11:10:47–48 (within 1 second of first login):

```
11:10:47.869  GET  /api/orgs                  → 200  (listed 0 orgs)
11:10:47.877  GET  /api/console/account/me    → 500  (E11000: slug "alex-s-org" exists)
11:10:48.201  GET  /api/orgs                  → 200  (listed 0 orgs — still no org created)
11:10:48.529  POST /api/orgs                  → 500  (E11000: slug "alex-s-organization" exists)
11:10:48.537  GET  /api/console/orgs          → 200  (listed 0 orgs)
```

**Both slug variants** (`alex-s-org` from the backend, `alex-s-organization` from the frontend) were already taken by a different user also named "alex." Neither path handles the collision. The user gets stuck with zero orgs, and the frontend retries forever.

Peak error rate: **4,014 errors in a single hour** (15:00–16:00, exactly when the user's screenshot was taken at 15:29).

### 6. Frontend doesn't recover even when backend succeeds concurrently

In `OrganizationContext.tsx`, `ensurePersonalOrg` calls `api.orgs.create()`. If that fails (slug collision), the catch block immediately errors out. It does **not** re-list orgs to check if another concurrent backend path (e.g. `getConsoleAccount`) successfully created an org in the meantime.

## Conclusions

| Problem                                      | Severity                                                                  | Scope                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `generateSlug` has no uniqueness handling    | **Critical** — blocks any user whose name prefix matches an existing slug | Both backend slug generators                                                                    |
| `createPersonalOrg` not idempotent           | **Critical** — 5 concurrent callers all try to create blindly             | `organization.service.ts`                                                                       |
| Frontend `useEffect` infinite retry loop     | **Critical** — produces thousands of errors/hour, DoS-like load           | `OrganizationSettings.tsx` + `OrganizationContext.tsx`                                          |
| `user.save()` VersionError under concurrency | **High** — intermittent failures when concurrent paths race               | `user.model.ts`, `developer.routes.ts`, `console.account.service.ts`, `console.apps.service.ts` |
| Frontend doesn't re-list after failed create | **Medium** — misses orgs that were created concurrently by backend        | `OrganizationContext.tsx`                                                                       |

Every issue compounds the others. The slug collision triggers the retry loop, the retry loop amplifies the VersionError, and the lack of recovery prevents the user from ever getting unstuck.

## Next Steps

Fixes implemented on branch `cloud/org-bug` (branched from `dev`). Eight files changed:

**Backend (slug uniqueness + idempotency):**

- `organization.service.ts` — `generateSlug()` checks DB + appends random suffix on collision; `createPersonalOrg()` checks for existing org first + catches E11000; `createOrg()` catches E11000 + retries with suffix
- `console/orgs.service.ts` — `createOrg()` checks slug uniqueness before save + catches E11000 with retry

**Backend (VersionError → atomic updates):**

- `user.model.ts` — `findOrCreateUser()` and `ensurePersonalOrg()` use `this.updateOne({ $addToSet, $set })` instead of `user.save()`
- `console.account.service.ts` — `getConsoleAccount()` uses `User.updateOne()` + try/catch around org bootstrap
- `developer.routes.ts` — `validateSupabaseToken` uses `User.updateOne()`
- `console.apps.service.ts` — `resolveOrgForWrite()` uses `User.updateOne()`

**Frontend (infinite loop + recovery):**

- `OrganizationContext.tsx` — `ensurePersonalOrg` wrapped in `useCallback` + ref-based mutex; catch block re-lists orgs before erroring
- `OrganizationSettings.tsx` — `orgCreationAttemptedRef` ensures single attempt per mount; removed unstable deps from useEffect
