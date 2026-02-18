# Timezone & Datetime Cleanup Spec

## Overview

Fix calendar time display by adding proper timezone support. Remove the broken `userDatetime` and `custom_message` system that was a poor solution to this problem.

## Problem

### 1. Calendar Times Display Wrong

Example from [OS-285](https://linear.app/mentralabs/issue/OS-285/dashboard-calendar-time-incorrect):

- Google Calendar: "Co-founder work session" at **8:30 - 11pm**
- Dashboard displays: **"Co-foun... @ 11:30AM"** (12 hours off!)

Root cause: Dashboard tries to extract timezone from ISO offset string, which doesn't work:

```typescript
// Dashboard/src/index.ts:31-45
function extractTimezoneFromISO("2025-08-01T15:05:00+08:00")
// Returns: "+08:00"

// Then tries to use it:
new Date().toLocaleString("en-US", { timeZone: "+08:00" })
// ❌ FAILS - JavaScript requires IANA names like "America/New_York"
```

### 2. userDatetime is Architecturally Wrong

Current flow:

```
Mobile ──► POST /api/user-data/set-datetime { datetime: "2025-08-01T15:05:00+08:00" }
              │
              ▼
Cloud stores: userSession.userDatetime = datetime
              │
              ▼
Relays via:   CloudToAppMessageType.CUSTOM_MESSAGE
              { action: "update_datetime", payload: { datetime, section: "topLeft" } }
              │
              ▼
Dashboard:    session.events.on("custom_message", ...) → sessionInfo.userDatetime = ...
```

**CRITICAL FINDING: Nothing actually calls this endpoint!**

Grep results show:

- No call in `mobile/src/services/RestComms.ts`
- No call in native Kotlin/Swift/Java code
- No call anywhere in the mobile codebase

The entire system is **dead code** - endpoints exist, cloud stores it, Dashboard listens... but no client sends it.

Problems:

- **Stale immediately**: The moment it's sent, it's already wrong
- **Wasteful**: Constant network traffic for something that rarely changes (timezone)
- **Wrong abstraction**: Invented `custom_message` instead of using settings system
- **SDK pollution**: Added `StreamType.CUSTOM_MESSAGE`, `CloudToAppMessageType.CUSTOM_MESSAGE`, `onCustomMessage()` just for this

### 3. custom_message Only Used for This (And It's Not Even Working)

Grep results show `custom_message` is **only** used by Dashboard for datetime:

```
apps/Dashboard/src/index.ts:
  session.events.on("custom_message", (message: any) => {
    if (message.action === "update_datetime") { ... }
  });
```

No other apps use it. It exists solely for this bad design that **isn't even being used**.

## Constraints

- **SDK backward compatibility**: Can't remove `CUSTOM_MESSAGE` types from SDK immediately (third-party apps might use it)
- **Mobile coordination**: Need mobile team to send timezone setting
- **Gradual rollout**: Dashboard needs to handle both old (no timezone) and new (has timezone) cases

## Goals

1. **Add `timezone` to UserSettings** - IANA timezone name like "America/New_York"
2. **Flow timezone through settings system** - mentraosSettings in CONNECTION_ACK, bridge for live updates
3. **Fix Dashboard calendar/time display** - Use timezone properly
4. **Remove datetime cruft from cloud** - userDatetime, set-datetime endpoint, custom_message relay
5. **Deprecate custom_message in SDK** - Mark for removal, don't break existing apps

## Non-Goals

- Removing `CUSTOM_MESSAGE` from SDK types (breaks third-party apps)
- Auto-detecting timezone from GPS (already exists as fallback via tz-lookup)
- Handling users who travel frequently (timezone setting is good enough)

## What to Remove

### Cloud

| File                                  | What to Remove                                           |
| ------------------------------------- | -------------------------------------------------------- |
| `UserSession.ts`                      | `userDatetime?: string` property                         |
| `api/hono/routes/user-data.routes.ts` | `/set-datetime` endpoint entirely                        |
| `routes/user-data.routes.ts`          | `/set-datetime` endpoint (legacy express)                |
| `handlers/app-message-handler.ts`     | Lines 235-248: cached userDatetime relay on subscription |

### Dashboard App

| File                          | What to Remove                                     |
| ----------------------------- | -------------------------------------------------- |
| `apps/Dashboard/src/index.ts` | `extractTimezoneFromISO()` function                |
| `apps/Dashboard/src/index.ts` | `userDatetime` in session info interface           |
| `apps/Dashboard/src/index.ts` | `custom_message` event handler for update_datetime |
| `apps/Dashboard/src/index.ts` | All `sessionInfo.userDatetime` usage               |

### SDK (Deprecate, Don't Remove)

| File                     | Action                                                 |
| ------------------------ | ------------------------------------------------------ |
| `types/message-types.ts` | Add `@deprecated` JSDoc to `CUSTOM_MESSAGE`            |
| `types/streams.ts`       | Add `@deprecated` JSDoc to `StreamType.CUSTOM_MESSAGE` |
| `app/session/events.ts`  | Add `@deprecated` JSDoc to `onCustomMessage()`         |

## What to Add

### Cloud

| File                     | What to Add                                                          |
| ------------------------ | -------------------------------------------------------------------- |
| `UserSession.ts`         | `userTimezone?: string` property                                     |
| `UserSettingsManager.ts` | `buildMentraosSettings()` - single source of truth for key mapping   |
| `UserSettingsManager.ts` | `broadcastSettingsUpdate()` - sends full snapshot to subscribed apps |
| `SubscriptionManager.ts` | `getAllAppsWithAugmentosSubscriptions()` - helper for broadcast      |
| `AppManager.ts`          | Use `userSettingsManager.buildMentraosSettings()` for CONNECTION_ACK |

### Dashboard App

| File                          | What to Add                                                       |
| ----------------------------- | ----------------------------------------------------------------- |
| `apps/Dashboard/src/index.ts` | `userTimezone` in session info                                    |
| `apps/Dashboard/src/index.ts` | Read timezone from `session.settings.getMentraOS("userTimezone")` |
| `apps/Dashboard/src/index.ts` | Subscribe to timezone changes via settings                        |

### Mobile (Coordinate with mobile team)

```typescript
// On app start / timezone change:
POST / api / client / user / settings;
{
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone;
}
// e.g., { timezone: "America/New_York" }
```

## Key Insight

ISO date strings are already absolute time references:

```javascript
const event = new Date("2025-08-01T20:30:00-07:00"); // 8:30 PM Pacific

// To display in user's timezone, just format it:
event.toLocaleString("en-US", { timeZone: "America/New_York" });
// Output: "8/1/2025, 11:30:00 PM" ✅ Correctly shows Eastern time
```

We don't need to "convert" anything. We just need to know the user's timezone for formatting.

## Open Questions

1. **What if mobile doesn't send timezone?**
   - Fallback: GPS location → tz-lookup (already exists in Dashboard)
   - Fallback: Server timezone with warning log

2. **Should we remove the express routes file entirely?**
   - `routes/user-data.routes.ts` only has set-datetime
   - Check if anything else uses it before removing

3. **When should mobile send timezone?**
   - On login/session start
   - When device timezone changes (rare)
   - Not constantly like userDatetime was doing
