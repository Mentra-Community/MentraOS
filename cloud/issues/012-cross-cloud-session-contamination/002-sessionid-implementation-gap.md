# sessionId Implementation Gap Analysis

## Overview

The `sessionId` is supposed to uniquely identify a session, but the current implementation makes it deterministic and reusable, causing cross-cloud contamination when users switch environments.

## Current Implementation

### How sessionId is Generated (Cloud)

```typescript
// packages/cloud/src/services/session/AppManager.ts
// In triggerAppWebhookInternal()
sessionId: this.userSession.userId + "-" + packageName;
```

**Result**: `"isaiah@mentra.glass-com.mentra.captions.beta"`

This is the **same** for:

- Session on `cloud-dev`
- Session on `cloud-debug`
- Session on `cloud-prod`
- Any future session for this user/app combination

### How sessionId is Used (SDK)

```typescript
// packages/sdk/src/app/server/index.ts
this.activeSessions: Map<sessionId, AppSession>
this.activeSessionsByUserId: Map<userId, AppSession>
```

When a new webhook arrives with the same `sessionId`, the map entry is **overwritten**:

```typescript
// New session creation overwrites old entry
this.activeSessions.set(sessionId, newSession);
// Old session reference is lost, but its WebSocket may still be open!
```

### How sessionId is Used (Apps like Captions)

```typescript
// packages/apps/captions/src/app/session/UserSession.ts
static readonly userSessions: Map<string, UserSession> = new Map()

constructor(appSession: AppSession) {
  UserSession.userSessions.set(this.userId, this)  // Keyed by userId, not sessionId!
}

static getUserSession(userId: string): UserSession | undefined {
  return UserSession.userSessions.get(userId)
}
```

The Captions app doesn't even use `sessionId` for lookups—it uses `userId`, which makes it even more susceptible to cross-cloud contamination.

## The Gap

### What sessionId Should Be

| Property                            | Current | Required |
| ----------------------------------- | ------- | -------- |
| Unique per session instance         | ❌ No   | ✅ Yes   |
| Different across cloud environments | ❌ No   | ✅ Yes   |
| Survives reconnection               | ✅ Yes  | ✅ Yes   |
| Identifies user+app combination     | ✅ Yes  | ✅ Yes   |

### What We Need

```typescript
// Option 1: UUID per session
sessionId: crypto.randomUUID();
// = "a1b2c3d4-5678-90ab-cdef-1234567890ab"

// Option 2: Include cloud instance ID
sessionId: `${userId}-${packageName}-${cloudInstanceId}`;
// = "isaiah@mentra.glass-com.mentra.captions.beta-cloud-debug-12345"

// Option 3: Include timestamp/nonce
sessionId: `${userId}-${packageName}-${Date.now()}`;
// = "isaiah@mentra.glass-com.mentra.captions.beta-1702345678901"
```

## Impact Analysis

### Where sessionId is Used

| Location                                 | Usage                      | Impact of Change               |
| ---------------------------------------- | -------------------------- | ------------------------------ |
| `AppManager.triggerAppWebhookInternal()` | Generates sessionId        | Must generate unique IDs       |
| `AppServer.activeSessions`               | Keyed by sessionId         | No change needed (already Map) |
| `AppSession.sessionId`                   | Stored for reference       | No change needed               |
| `WebSocket messages`                     | Included in messages       | No change needed               |
| `onStart/onStop callbacks`               | Passed to app              | Apps need to handle unique IDs |
| `Captions UserSession`                   | **NOT used** (uses userId) | Must start using sessionId     |

### Files to Modify

**Cloud (Generate Unique sessionId)**:

```
packages/cloud/src/services/session/AppManager.ts
  - triggerAppWebhookInternal(): Generate UUID instead of deterministic string
```

**SDK (Handle Unique sessionId)**:

```
packages/sdk/src/app/server/index.ts
  - handleSessionRequest(): No change needed (Map handles unique keys)
  - cleanupDisconnect(): Pass sessionId to onStop (already does)
```

**Captions App (Use sessionId for Lookup)**:

```
packages/apps/captions/src/app/index.ts
  - onStop(): Check sessionId matches before disposing

packages/apps/captions/src/app/session/UserSession.ts
  - Store and expose sessionId from AppSession
  - Add getUserSessionIfMatches(userId, sessionId) helper
```

## Backward Compatibility

### Breaking Changes

1. **sessionId format changes**: Any code that parses `userId-packageName` format breaks
2. **Session restoration**: Can't restore sessions by reconstructing sessionId from userId+packageName

### Non-Breaking Changes

1. **SDK AppServer**: Already uses sessionId as map key, unique IDs work fine
2. **SDK AppSession**: Stores sessionId as string, doesn't care about format
3. **Cloud messages**: Include sessionId as opaque string
4. **Webhook payload**: sessionId is just a string field

### Migration Strategy

**Phase 1**: Short-term fix (no sessionId change)

- Add sessionId check to `onStop()` in apps
- Store sessionId in app-side UserSession
- Only dispose if sessionId matches

**Phase 2**: Generate unique sessionIds

- Cloud generates UUID-based sessionIds
- SDK handles them transparently
- Apps already using sessionId checks work correctly

## Concrete Fix: Short-term (Captions App)

### Step 1: Store sessionId in UserSession

```typescript
// packages/apps/captions/src/app/session/UserSession.ts
export class UserSession {
  public readonly sessionId: string;

  constructor(appSession: AppSession) {
    this.userId = appSession.userId;
    this.sessionId = appSession.sessionId; // Store it!
    // ...
  }

  static getUserSessionIfMatches(userId: string, sessionId: string): UserSession | undefined {
    const session = UserSession.userSessions.get(userId);
    if (session && session.sessionId === sessionId) {
      return session;
    }
    return undefined;
  }
}
```

### Step 2: Guard onStop with sessionId check

```typescript
// packages/apps/captions/src/app/index.ts
protected async onStop(sessionId: string, userId: string, reason: string): Promise<void> {
  const userSession = UserSession.getUserSessionIfMatches(userId, sessionId)
  if (userSession) {
    userSession.dispose()
  } else {
    this.logger.info(
      { sessionId, userId, reason },
      `Ignoring stop for non-matching session (likely stale cross-cloud stop)`
    )
  }
}
```

## Concrete Fix: Medium-term (Cloud + SDK)

### Cloud: Generate Unique sessionId

```typescript
// packages/cloud/src/services/session/AppManager.ts
async triggerAppWebhookInternal(packageName: string, appInfo: AppInfo) {
  const sessionId = crypto.randomUUID()  // Unique per session instance

  const webhookPayload = {
    type: 'SESSION_REQUEST',
    sessionId,
    userId: this.userSession.userId,
    packageName,
    // ...
  }
}
```

### SDK: No Changes Required

The SDK already treats sessionId as an opaque string. As long as:

- Webhook provides sessionId
- AppSession stores it
- onStart/onStop pass it through

...the SDK doesn't care if it's a UUID or `userId-packageName`.

## Open Questions

1. **Should sessionId survive reconnection?**
   - Current: Yes (same deterministic ID)
   - With UUID: No (new webhook = new UUID)
   - **Decision needed**: Should we include a "reconnection token" separate from sessionId?

2. **What about session restoration on cloud restart?**
   - Current: Can reconstruct sessionId from DB (userId + runningApps)
   - With UUID: Need to persist sessionId in DB
   - **Decision needed**: Store sessionId in user.runningApps or separate field?

3. **Logging and debugging**
   - Current: Easy to read `isaiah@mentra.glass-com.mentra.captions.beta`
   - With UUID: Harder to trace `a1b2c3d4-5678-90ab-cdef-1234567890ab`
   - **Suggestion**: Include userId and packageName in log context, use UUID for uniqueness

## Recommendation

1. **Immediate**: Apply short-term fix (sessionId check in `onStop()`) to Captions app
2. **Next sprint**: Generate unique sessionIds in Cloud
3. **Follow-up**: Update external apps (captions-beta.mentraglass.com) with same guards

The short-term fix is low-risk and prevents cross-cloud contamination without changing the sessionId format. The medium-term fix makes the system more robust by ensuring sessionIds are truly unique.
