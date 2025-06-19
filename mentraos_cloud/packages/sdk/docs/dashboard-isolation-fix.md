# Dashboard Cross-User Data Leak: Analysis and Fix

## Issue Overview

A critical bug has been identified in the AugmentOS system where users can see other users' calendar events and notifications in their dashboard display. This represents a serious data privacy issue that must be addressed before moving to production.

## Root Cause Analysis

After extensive investigation, we've identified that the dashboard module in the SDK has a fundamentally flawed design that breaks session isolation:

1. **Static Session ID**: The SDK's dashboard module uses a static method to set the current session ID:
   ```typescript
   dashboard.TpaSession.setSessionId(sessionId);
   ```
   This means all TPA sessions share the same "current" session ID, leading to cross-talk between users.

2. **Session Identity Management**: The TpaSession class has a design flaw where the session is created first, then its identity is established later via the `connect(sessionId)` method. This separation creates the risk of connecting with the wrong session ID.

3. **Instance Isolation**: The dashboard module lacks proper per-instance state, instead relying on module-level shared state.

## Proposed Fix

We will modify the SDK to ensure proper session isolation:

1. **Dashboard as Instance Property**: Make the dashboard object an instance property of each TpaSession, ensuring each session has its own isolated dashboard state.

2. **Remove Static Methods**: Eliminate the static `setSessionId` method and any other static state in the dashboard module.

3. **Dashboard Class Design**: Implement a proper DashboardManager class that takes a reference to its parent session and uses that for all operations.

### Implementation Details

```typescript
// In packages/sdk/src/tpa/session/index.ts
import { DashboardManager } from './dashboard';

class TpaSession {
  private _dashboard: DashboardManager;
  
  constructor(config: TpaSessionConfig) {
    // Other initialization...
    
    // Create a dashboard instance specific to this session with the bound send function
    this._dashboard = new DashboardManager(this, this.send.bind(this));
  }
  
  get dashboard(): DashboardManager {
    return this._dashboard;
  }
  
  // Rest of class...
}
```

```typescript
// In packages/sdk/src/tpa/session/dashboard.ts
export class DashboardManager {
  private session: TpaSession;
  
  constructor(session: TpaSession, send: (message: TpaToCloudMessage) => void) {
    this.session = session;
  }
  
  // Implement dashboard APIs using the parent session for context
  // ...
}
```

## Other Suspicious Areas to Address Later

1. **TpaSession.connect Method**: This method takes a sessionId parameter, which creates the risk of connecting with the wrong ID. This should be refactored to establish identity at creation time.

2. **Dashboard TPA Shared Map**: The Dashboard TPA uses a class-level map to store session data:
   ```typescript
   private _activeSessions: Map<string, {...}>
   ```
   This needs proper instance isolation and user validation.

3. **WebSocketService Message Routing**: The way messages are routed between users and TPAs should be audited for proper session validation.

4. **DisplayManager Implementation**: The DisplayManager should be checked to ensure it properly isolates user sessions when handling display requests.

5. **SubscriptionService Caching**: The calendar event and location caches in SubscriptionService use only sessionId as keys. These should be audited for proper user validation.

## Implementation Priority

1. **Immediate Fix**: Implement the DashboardManager class solution in the SDK to address the root cause of cross-user data leakage.

2. **Secondary Fixes**: Address the remaining suspicious areas after thorough testing of the primary fix.

## Testing Strategy

1. **Multi-User Scenario**: Set up multiple concurrent users and verify data isolation
2. **Session Reconnection**: Test disconnection/reconnection scenarios to ensure persistent isolation
3. **Load Testing**: Verify isolation holds under high system load with many users
4. **Regression Testing**: Ensure existing dashboard functionality continues to work with the new implementation

## Conclusion

The core issue is a fundamental architectural flaw in how the SDK manages dashboard sessions. By making the dashboard an instance property of each session rather than using static/shared state, we can ensure proper isolation between users while maintaining the current API.

This issue underscores the importance of proper instance isolation in multi-user systems and the risks of using static/shared state across user contexts.