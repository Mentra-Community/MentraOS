# Issue 026a: Head-Up View Not Updating When Dashboard Disabled

**Status**: Fixed ✅  
**Priority**: Medium  
**Parent Issue**: [026-mobile-display-processor](./README.md)

## Problem

When the user has `contextual_dashboard` disabled and looks up (head-up position), the main view stops updating even though it should continue to display normally.

### Expected Behavior

With `contextual_dashboard = false`:
- Head down → shows "main" view ✅
- Head up → should STILL show "main" view (dashboard is disabled)
- Main view should continue to update normally

### Actual Behavior (Bug)

With `contextual_dashboard = false`:
- Head down → shows "main" view ✅
- Head up → shows "main" view ✅ (correct)
- BUT: main view **stops updating** while head is up ❌

## Root Cause

In `MantleManager.handle_head_up()`, the view was being set to "dashboard" regardless of whether the contextual dashboard feature was enabled:

```typescript
// BEFORE (buggy)
public async handle_head_up(isUp: boolean) {
  socketComms.sendHeadPosition(isUp)
  useDisplayStore.getState().setView(isUp ? "dashboard" : "main")  // ← Always sets to "dashboard" when head up
}
```

This caused a mismatch in the display store:

1. User looks up → `setView("dashboard")` → internal view state = `"dashboard"`
2. Cloud sends display event with `view: "main"` (because dashboard is disabled on cloud side)
3. In `setDisplayEvent()`:
   ```typescript
   if (event.view === currentView) {  // "main" !== "dashboard"
     updates.currentEvent = event     // ← This never runs!
   }
   ```
4. `currentEvent` never gets updated → UI shows stale content

## Fix

Updated `handle_head_up()` to check the `contextual_dashboard` setting before switching views:

```typescript
// AFTER (fixed)
public async handle_head_up(isUp: boolean) {
  socketComms.sendHeadPosition(isUp)

  // Only switch to dashboard view if contextual dashboard is enabled
  // Otherwise, always show main view regardless of head position
  const contextualDashboardEnabled = await useSettingsStore.getState().getSetting(SETTINGS.contextual_dashboard.key)

  if (isUp && contextualDashboardEnabled) {
    useDisplayStore.getState().setView("dashboard")
  } else {
    useDisplayStore.getState().setView("main")
  }
}
```

## Files Changed

- `mobile/src/services/MantleManager.ts` - Updated `handle_head_up()` method

## Testing

1. Disable contextual dashboard in settings
2. Connect glasses and start an app that sends display events (e.g., captions)
3. Look up (head-up position)
4. Verify that the main view continues to update with new content
5. Look down, verify still updating
6. Enable contextual dashboard
7. Look up, verify dashboard view is shown
8. Look down, verify main view is shown

## Related Code

### Display Store Logic

```typescript
// mobile/src/stores/display.ts
setDisplayEvent: (eventString: string) => {
  const event = JSON.parse(eventString)
  const currentView = get().view

  const updates: any = {
    [event.view === "dashboard" ? "dashboardEvent" : "mainEvent"]: event,
  }

  // Only updates currentEvent if event.view matches currentView
  if (event.view === currentView) {
    updates.currentEvent = event
  }

  set(updates)
}
```

### Settings

```typescript
// mobile/src/stores/settings.ts
contextual_dashboard: {
  key: "contextual_dashboard",
  defaultValue: () => true,
  writable: true,
  saveOnServer: true,
  persist: true,
}
```
