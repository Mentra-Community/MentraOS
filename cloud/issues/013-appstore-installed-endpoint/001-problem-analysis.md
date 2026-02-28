# Problem Analysis: App Store Using Mobile Client Endpoint

## Summary

The app store website calls the same `/api/apps/installed` endpoint used by the mobile client. This endpoint includes auto-cleanup logic that deletes "stale" apps. When users browse the app store while their glasses are connected to a non-production server (debug, staging, local), the store still hits production APIs and triggers deletions on the shared database.

## Evidence

From Better Stack logs (2025-12-19):

```
User: isaiahballah@gmail.com
Glasses connected to: cloud-debug
App store webview: hits cloud-prod

18:41:48.075 | optionalUserSession: No session found for isaiahballah@gmail.com
18:41:48.320 | Auth Middleware: User isaiahballah@gmail.com authenticated
18:41:48.367 | Auto-deleted 2 app(s) for user: isaiahballah@gmail.com
18:41:48.416 | GET /api/apps/installed - 304
```

The user has no active session on prod (glasses connected to debug), but the app store API call still triggers the auto-delete logic.

## Data Flow

### Current (Broken)

```
Mobile App (connected to debug)
    │
    ├── WebSocket → cloud-debug (glasses session)
    │
    └── WebView (App Store)
            │
            └── store.augmentos.org (prod website)
                    │
                    └── GET /api/apps/installed → cloud-prod
                            │
                            └── Auto-deletes "stale" apps from shared DB
                                    │
                                    └── Affects user's debug session
```

### The Problem

1. **Shared Database**: All environments use the same MongoDB instance
2. **Shared Endpoint**: App store reuses mobile client endpoint
3. **Destructive Logic**: The endpoint has auto-cleanup that makes sense for mobile, not for browsing

## The Destructive Code Path

Location: `packages/cloud/src/routes/apps.routes.ts` (or similar)

The `/api/apps/installed` endpoint likely does something like:

```typescript
// Pseudocode - actual implementation may vary
router.get("/installed", async (req, res) => {
  const user = req.user
  const installedApps = await getInstalledApps(user)

  // This is the problem - cleanup logic in a GET endpoint
  const staleApps = installedApps.filter((app) => isStale(app))
  if (staleApps.length > 0) {
    await deleteApps(user, staleApps)
    logger.info(`Auto-deleted ${staleApps.length} app(s) for user: ${user.email}`)
  }

  return res.json(installedApps.filter((app) => !isStale(app)))
})
```

**Issues**:

- GET request with side effects (violates REST principles)
- No check for active session on the same server
- App store just needs a read-only list

## Proposed Fix

### Option 1: New Read-Only Endpoint (Recommended)

Create a separate endpoint for the app store:

```typescript
// New endpoint for app store - read only, no side effects
router.get("/api/store/installed", async (req, res) => {
  const user = req.user
  const installedApps = await getInstalledApps(user)

  // No cleanup, no deletions, just return the list
  return res.json(installedApps)
})
```

Update app store website to use `/api/store/installed`.

### Option 2: Require Active Session for Deletions

Add a guard to the existing endpoint:

```typescript
router.get("/installed", async (req, res) => {
  const user = req.user
  const userSession = UserSession.getById(user.email)

  // Only run cleanup if user has active session on THIS server
  if (userSession && !userSession.disposed) {
    // ... cleanup logic
  }

  return res.json(installedApps)
})
```

**Pros**: Minimal changes
**Cons**: Still a GET with side effects, just guarded

### Option 3: Move Cleanup to Separate Process

Remove cleanup from the GET endpoint entirely. Run cleanup:

- On session start
- On explicit user action
- Via background job

## Recommended Approach

**Option 1** is cleanest:

1. Create `GET /api/store/installed` - read-only, for app store website
2. Keep `GET /api/apps/installed` - with cleanup, for mobile client
3. Mobile client already has an active session when calling this endpoint

## Files to Modify

| File                                       | Change                                  |
| ------------------------------------------ | --------------------------------------- |
| `packages/cloud/src/routes/apps.routes.ts` | Add new `/api/store/installed` endpoint |
| `cloud/websites/store/`                    | Update API calls to use new endpoint    |

## Audit: Other Potentially Destructive Endpoints

Should check if these have similar issues:

- `GET /api/apps/available` - probably safe (read-only)
- `POST /api/apps/install` - intentionally destructive, probably fine
- `POST /api/apps/uninstall` - intentionally destructive, probably fine
- Any endpoint with "sync", "cleanup", "refresh" logic

## Open Questions

1. **What triggers "stale" detection?** Need to understand the cleanup criteria
2. **Are there other GET endpoints with side effects?** Should audit
3. **Should store have its own API namespace?** `/api/store/*` vs `/api/apps/*`
4. **Long-term: separate databases per environment?** Would prevent this class of bug entirely

## Timeline Estimate

| Task                     | Estimate |
| ------------------------ | -------- |
| Create new endpoint      | 30 min   |
| Update app store website | 30 min   |
| Test                     | 1 hour   |
| **Total**                | ~2 hours |
