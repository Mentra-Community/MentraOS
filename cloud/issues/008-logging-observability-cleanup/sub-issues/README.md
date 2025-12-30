# Issue 008: Sub-Issues Summary

**Last Analysis**: 2025-12-16  
**Total Errors Analyzed**: ~250K+ in 6-hour window

## Error Landscape Overview

| Category                   | Error Count (6h) | Priority    | Status                             |
| -------------------------- | ---------------- | ----------- | ---------------------------------- |
| Dashboard app timer errors | 130,685 (~52%)   | 🔴 Critical | Open - SDK fix needed              |
| Soniox latency warnings    | 15,396/hr        | 🔴 Critical | Fixed - removed unreliable logging |
| Display validation errors  | 25,148 (~10%)    | 🟠 High     | Code fixed, needs deploy           |
| Hardware validation errors | 25,171 (~10%)    | 🟠 High     | Code fixed, needs deploy           |
| Location API 400s          | ~6,381/hr        | 🟠 High     | Open - data format mismatch        |
| No active session warnings | ~2,621/hr        | 🟡 Medium   | Open - mobile polling issue        |
| API auth errors (401)      | 971              | 🟡 Medium   | Open                               |
| Unrecognized message type  | 1,025            | 🟡 Medium   | Open - SDK version mismatch        |
| App not found errors       | 186              | 🟢 Low      | Open - deleted apps                |

## Sub-Issues

### [001-dashboard-app-timer-errors.md](./001-dashboard-app-timer-errors.md)

**Priority**: 🔴 Critical | **Impact**: 130K+ errors/6h (52% of all errors)

Dashboard app timers continue running after user disconnect, logging errors every minute per disconnected user. SDK needs to check `isConnected` before sending and clear timers on disconnect.

---

### [002-display-validation-errors.md](./002-display-validation-errors.md)

**Priority**: 🟠 High | **Impact**: 25K+ errors/6h

Apps sending display requests when glasses disconnected. Code already fixed in repo (using `debug` instead of `error`), needs deployment. One user (`pikulik83@gmail.com`) generated 12K+ errors from teleprompter app alone.

---

### [003-unrecognized-message-type.md](./003-unrecognized-message-type.md)

**Priority**: 🟡 Medium | **Impact**: ~1K errors/6h

Apps sending `capabilities_update` messages to cloud, but this is a `CloudToAppMessageType` (cloud→app), not `AppToCloudMessageType`. Likely old SDK versions or app bug echoing messages back.

---

### [004-app-not-found-errors.md](./004-app-not-found-errors.md)

**Priority**: 🟢 Low | **Impact**: ~186 errors/6h

Requests for deleted/renamed apps. Should downgrade to `warn` and optionally remove from user's running apps list.

---

### [005-api-auth-errors.md](./005-api-auth-errors.md)

**Priority**: 🟡 Medium | **Impact**: ~971 errors/6h

Apps receiving 401 Unauthorized. May be token expiration handling issues or session lifecycle problems.

---

### [006-session-reconnection-apps-not-restarting.md](./006-session-reconnection-apps-not-restarting.md)

**Priority**: 🟠 High | **Impact**: User experience

When UserSession disconnects (phone WebSocket drops for >60s), apps stop. On reconnection, apps don't auto-restart - user must reopen mobile client. This is currently expected behavior but causes confusion.

**Grace Periods**:

- UserSession (phone WebSocket): 60 seconds
- AppSession (individual app): 5 seconds

---

### [007-location-api-400s.md](./007-location-api-400s.md)

**Priority**: 🟠 High | **Impact**: ~6.4K errors/hr

Data format mismatch: Mobile sends raw Expo `LocationObject` but API expects `{ location: {...} }` wrapper. Cloud fix: accept both formats.

---

### [008-no-active-session-warnings.md](./008-no-active-session-warnings.md)

**Priority**: 🟡 Medium | **Impact**: ~2.6K warnings/hr

Mobile continues polling REST APIs after WebSocket disconnects. One user polled for 1+ hour without session. Need better logging (include endpoint URL) and clearer response for mobile to handle.

---

## Completed Work

### Soniox Latency Logging (Removed)

The Soniox latency warnings were spamming ~15K/hr due to unreliable calculation. Removed from:

- `SonioxTranscriptionProvider.ts` - Per-token latency warnings
- `TranscriptionManager.ts` - `logLatencyMetrics()` now no-op

Metrics still tracked internally via `getMetrics()` for debugging.

### Code Fixes Already in Repo (Need Deploy)

- `ConnectionValidator.ts` - Changed validation failures from `error` to `debug`
- `DisplayManager6.1.ts` - Changed display validation failures from `error` to `debug`
- `sdk/src/app/session/index.ts` - Disconnect errors downgraded to `debug`

**Expected impact when deployed**: ~70% error reduction

## Users Generating Most Errors

| User                           | Error Count (6h) | Primary Issue                            |
| ------------------------------ | ---------------- | ---------------------------------------- |
| (no userId)                    | 66,647           | Various validation errors                |
| pikulik83@gmail.com            | 24,980           | Teleprompter + glasses disconnected      |
| alex.henson.official@gmail.com | 1,561/hr         | No session warnings (polling without WS) |
| josiahwarren256@gmail.com      | 2,480            | Dashboard app + pong timeouts            |

## Architecture Issues Identified

1. **Dashboard app timer cleanup** - Timers not cleared on disconnect, generating errors for 14+ minutes after user gone

2. **Mobile REST polling without WebSocket** - Background tasks continue after session disposed

3. **Data format inconsistency** - Location API expects different format than mobile sends

4. **Session state visibility** - Mobile doesn't know when to stop polling; 401 response could be more informative

5. **Subscription state intermittent** - Observed "no subscribed apps" appearing intermittently even when app connected (may be fixed in newer SDK)

## Next Steps

1. **Deploy existing fixes** - Validation error downgrades already in code
2. **Fix location API** - Accept both data formats
3. **Improve middleware logging** - Include endpoint URL in "no active session" warnings
4. **Notify mobile team** - Location format issue, polling without session issue
5. **Dashboard app fix** - Clear timers on disconnect, check `isConnected` before send

## Related Documentation

- [../README.md](../README.md) - Parent issue overview
- [../logging-standards.md](../logging-standards.md) - Logging standards
- [../quick-wins.md](../quick-wins.md) - Quick win implementation details
