# Simplified Permissions Manager Design Document

Author: Isaiah Ballah

Status: Implemented

## 1. Overview

### Problem Statement

While we've implemented the permission declaration and display system, there's currently no enforcement mechanism ensuring TPAs (Third-Party Applications) can only access streams they've declared permissions for. This creates several issues:

1. **No Permission Validation**: TPAs can subscribe to any stream regardless of declared permissions
2. **Developer Confusion**: No feedback when TPAs try to access streams without proper permissions
3. **User Trust Gap**: The permissions displayed to users may not match actual TPA behavior

This simplified implementation focuses on enforcing declared permissions at the subscription level:

1. Ensuring TPAs can only subscribe to streams they've declared permissions for
2. Providing clear error messages when permissions are missing
3. Implementing this without the complexity of the full permissions management system

## 2. Goals

**Implementation Targets:**

1. **Create Stream-Permission Mapping**: Define which stream types require which permissions
2. **Add Subscription Validation**: Check permissions when TPAs subscribe to streams
3. **Provide Clear Error Messages**: Return helpful messages when subscriptions are rejected
4. **Keep Current Permission UI**: Continue using the existing permission declaration and display UI

**Non-Goals (Deferred to Full Implementation):**

1. ❌ Phone permission status tracking
2. ❌ Runtime permission changes handling
3. ❌ Required vs. optional permissions distinction
4. ❌ Client-side permission enforcement

## 3. Design

### Stream-Permission Mapping

We'll define a mapping from stream types to the required permissions:

```typescript
// Stream types to permission mapping
const STREAM_TO_PERMISSION_MAP = new Map<string, PermissionType>([
  // Audio-related streams
  ['audio_chunk', PermissionType.MICROPHONE],
  ['transcription', PermissionType.MICROPHONE],
  ['translation', PermissionType.MICROPHONE],
  ['vad', PermissionType.MICROPHONE],
  
  // Location stream
  ['location_update', PermissionType.LOCATION],
  
  // Calendar stream
  ['calendar_event', PermissionType.CALENDAR],
  
  // Notification streams
  ['phone_notification', PermissionType.NOTIFICATIONS],
  ['notification_dismissed', PermissionType.NOTIFICATIONS],
]);
```

We'll also handle language-specific streams (e.g., `transcription:en`) by checking if the stream type starts with a known prefix.

### Implementation Components

#### 1. SimplePermissionChecker

A lightweight service that:
- Checks if a stream type requires a permission
- Verifies if an app has declared a specific permission
- Filters subscriptions based on declared permissions

#### 2. Subscription Service Integration

The subscription service will:
- Use the SimplePermissionChecker to validate subscriptions
- Filter out streams that require undeclared permissions
- Return clear error messages for rejected subscriptions

## 4. Implementation Details

### SimplePermissionChecker Service

Path: `/packages/cloud/src/services/permissions/simple-permission-checker.ts`

```typescript
import { PermissionType } from '@augmentos/sdk';
import { AppI } from '../../models/app.model';

/**
 * Simple Permission Checker
 * 
 * A lightweight service to check if apps have declared the necessary permissions
 * for the streams they're trying to subscribe to.
 */
export class SimplePermissionChecker {
  // Stream types to permission mapping
  private static STREAM_TO_PERMISSION_MAP = new Map<string, PermissionType>([
    // Audio-related streams
    ['audio_chunk', PermissionType.MICROPHONE],
    ['transcription', PermissionType.MICROPHONE],
    ['translation', PermissionType.MICROPHONE],
    ['vad', PermissionType.MICROPHONE],
    
    // Location stream
    ['location_update', PermissionType.LOCATION],
    
    // Calendar stream
    ['calendar_event', PermissionType.CALENDAR],
    
    // Notification streams
    ['phone_notification', PermissionType.NOTIFICATIONS],
    ['notification_dismissed', PermissionType.NOTIFICATIONS],
  ]);

  /**
   * Get the required permission for a stream type
   */
  static getRequiredPermissionForStream(streamType: string): PermissionType | null {
    // Handle language-specific streams
    if (streamType.startsWith('transcription:')) {
      return PermissionType.MICROPHONE;
    }
    if (streamType.startsWith('translation:')) {
      return PermissionType.MICROPHONE;
    }
    
    // Check regular stream types
    return this.STREAM_TO_PERMISSION_MAP.get(streamType) || null;
  }

  /**
   * Check if an app has declared a specific permission
   */
  static hasPermission(app: AppI, permission: PermissionType): boolean {
    // ALL permission is a special case that grants access to everything
    if (app.permissions?.some(p => p.type === PermissionType.ALL)) {
      return true;
    }
    
    return app.permissions?.some(p => p.type === permission) || false;
  }

  /**
   * Filter subscriptions based on declared permissions
   * Returns an object with allowed subscriptions and rejected ones with reasons
   */
  static filterSubscriptions(app: AppI, subscriptions: string[]): {
    allowed: string[];
    rejected: Array<{ stream: string; requiredPermission: PermissionType }>;
  } {
    const allowed: string[] = [];
    const rejected: Array<{ stream: string; requiredPermission: PermissionType }> = [];

    for (const subscription of subscriptions) {
      const requiredPermission = this.getRequiredPermissionForStream(subscription);
      
      // If no permission required or app has the permission, allow
      if (!requiredPermission || this.hasPermission(app, requiredPermission)) {
        allowed.push(subscription);
      } else {
        // Otherwise reject with reason
        rejected.push({
          stream: subscription,
          requiredPermission
        });
      }
    }

    return { allowed, rejected };
  }
}
```

### Integration with Subscription Service

Path: `/packages/cloud/src/services/core/subscription.service.ts`

```typescript
// Add to updateSubscriptions method
updateSubscriptions(
  sessionId: string,
  packageName: string,
  userId: string,
  subscriptions: ExtendedStreamType[]
): void {
  // Get app details
  const app = await App.findOne({ packageName }).lean();
  
  if (!app) {
    throw new Error(`App ${packageName} not found`);
  }
  
  // Filter subscriptions based on permissions
  const { allowed, rejected } = SimplePermissionChecker.filterSubscriptions(app, subscriptions);
  
  // Log rejected subscriptions
  if (rejected.length > 0) {
    logger.warn(
      `Rejected ${rejected.length} subscriptions for ${packageName} due to missing permissions: ` +
      rejected.map(r => `${r.stream} (requires ${r.requiredPermission})`).join(', ')
    );
    
    // Send error message to TPA if connected
    const connection = this.userSession?.appConnections.get(packageName);
    if (connection && connection.readyState === 1) {
      const errorMessage = {
        type: 'permission_error',
        message: 'Some subscriptions were rejected due to missing permissions',
        details: rejected.map(r => ({
          stream: r.stream,
          requiredPermission: r.requiredPermission,
          message: `To subscribe to ${r.stream}, add the ${r.requiredPermission} permission in the developer console`
        })),
        timestamp: new Date()
      };
      
      connection.send(JSON.stringify(errorMessage));
    }
  }
  
  // Continue with allowed subscriptions
  const key = `${sessionId}:${packageName}`;
  this.subscriptions.set(key, new Set(allowed));
  // ... rest of existing code
}
```

## 5. User Experience

### Developer Experience

1. Developers declare permissions in the developer portal as before
2. If they try to subscribe to streams without declaring permissions:
   - Subscription is rejected
   - They receive a clear error message identifying:
     - Which stream was rejected
     - Which permission is required
     - How to fix the issue by adding the permission in the developer console

### User Experience

1. Users continue to see permission requirements in the app store as before
2. Users can trust that the displayed permissions match what the app can actually access
3. No change to the installation or usage flow

## 6. Testing Plan

1. **Positive Tests:**
   - Apps with all required permissions can subscribe to all streams
   - Apps with `ALL` permission can subscribe to any stream
   - Apps can subscribe to streams that don't require permissions

2. **Negative Tests:**
   - Apps without MICROPHONE permission can't subscribe to audio streams
   - Apps without LOCATION permission can't subscribe to location streams
   - Apps receive appropriate error messages for rejected subscriptions

## 7. Future Work

This simplified implementation provides the foundation for the full Permission Manager. Future enhancements will include:

1. **Phone Permission Status Tracking:**
   - Check if OS permissions are actually granted at runtime
   - Block streams when OS permissions are not available

2. **Runtime Permission Changes:**
   - Monitor permission changes during app execution
   - Notify apps when permissions change
   - Remove subscriptions when permissions are revoked

3. **Required vs. Optional Permissions:**
   - Allow apps to specify if permissions are required or optional
   - Implement graceful degradation for optional permissions

4. **Client-Side Enforcement:**
   - Implement permission checks on the client side
   - Show appropriate UI for disabled permissions