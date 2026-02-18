# Client Apps Last Active & Install Date

Add `installedDate` and `lastActiveAt` fields to the `/api/client/apps` endpoint response so the mobile app can identify "new" apps (installed but never run).

## Problem

The mobile frontend wants to show a "new" badge on apps that have been installed but never run. The data exists in MongoDB but isn't being returned by the API.

**MongoDB `User.installedApps` has:**

```typescript
{
  packageName: "com.mentra.merge",
  installedDate: "2025-05-09T00:19:05.237Z",
  lastActiveAt: "2026-01-28T18:27:12.202Z"  // Only present if app has been run
}
```

**Current `/api/client/apps` response:**

```typescript
{
  packageName: "com.mentra.merge",
  name: "Merge",
  logoUrl: "...",
  type: "background",
  permissions: [...],
  running: false,
  healthy: true,
  hardwareRequirements: []
  // Missing: installedDate, lastActiveAt
}
```

## Solution

1. Update `AppletInterface` in `@mentra/types` to include optional `installedDate` and `lastActiveAt`
2. Update `ClientAppsService.getAppsForHomeScreen()` to include these fields from `user.installedApps`

## Frontend Logic

```typescript
// App is "new" if it has never been run
const isNewApp = !app.lastActiveAt
```

## Status

- [x] Issue documented
- [x] Update `AppletInterface` type
- [x] Update `ClientAppsService` to include dates
- [ ] Testing

## Files to Change

| File                                                       | Change                                                                        |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `cloud/packages/types/src/applet.ts`                       | Add `installedDate?: string` and `lastActiveAt?: string` to `AppletInterface` |
| `cloud/packages/cloud/src/services/client/apps.service.ts` | Include dates from `user.installedApps` in response                           |

## API Response (After)

```typescript
{
  packageName: "com.mentra.merge",
  name: "Merge",
  logoUrl: "...",
  type: "background",
  permissions: [...],
  running: false,
  healthy: true,
  hardwareRequirements: [],
  installedDate: "2025-05-09T00:19:05.237Z",
  lastActiveAt: "2026-01-28T18:27:12.202Z"  // undefined if never run
}
```
