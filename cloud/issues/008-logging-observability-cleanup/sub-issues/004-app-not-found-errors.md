# Sub-Issue 008.4: App Not Found Errors

**Status**: Open  
**Priority**: Low (~186 errors in 6 hours)  
**Component**: AppManager

## Problem

Apps that were deleted or renamed are still in users' installed/running lists, causing "App not found" errors.

## Error Breakdown

| Package Name                     | Count | Status  |
| -------------------------------- | ----- | ------- |
| `dev.augmentos.livetranslation`  | 80    | Deleted |
| `com.augmentos.livetranslation`  | 32    | Deleted |
| `cloud.augmentos.recorder`       | 30    | Deleted |
| `com.augmentos.calendarreminder` | 30    | Deleted |
| `com.mentra.teleprompter`        | 14    | Deleted |

## Fix

App not found = deleted app. Downgrade to `warn` and remove from user's running apps list.

```typescript
// In AppManager.startApp()
const app = await App.findOne({packageName})
if (!app) {
  this.logger.warn({packageName, userId}, "App not found - likely deleted")

  // Remove from running apps list to prevent future attempts
  this.removeFromRunningApps(packageName)

  return {error: "APP_NOT_FOUND"}
}
```

## Files

- `cloud/packages/cloud/src/services/session/AppManager.ts`

## Success Criteria

- No more `error` level logs for deleted apps
- Apps auto-removed from running list when not found
