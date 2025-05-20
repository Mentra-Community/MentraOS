# Permissions Manager Design Document

## 1. Overview

### Problem Statement

The AugmentOS Cloud platform currently lacks a permissions system for Third-Party Applications (TPAs). This creates several issues:

1. **Lack of Transparency**: Users have no visibility into what data TPAs can access
2. **Confusing User Experience**: When phone permissions are disabled, TPAs fail without clear error messages
3. **Missing Developer Guidance**: Developers lack a structured way to declare required permissions

Currently, any authenticated TPA can subscribe to any data stream without restrictions. This includes potentially sensitive data like audio, location, and transcription. The system only validates if subscription types are syntactically correct, not if the phone has granted the necessary OS-level permissions.

## 2. Goals

**Implementation Targets:**

1. **Add Permission Schema**: Extend the App model with permission declarations
2. **Create Permission Managers**:
   - SDK-side manager for checking and monitoring permissions
   - Cloud-side manager for enforcing permissions at runtime
3. **Implement Stream-Permission Mapping**: Map stream types to OS permission requirements
4. **Add Permission Enforcement**:
   - Validate permissions during TPA startup
   - Filter subscription requests based on available permissions
   - Handle runtime permission changes
5. **Develop Clear Error Handling**: Create user-friendly error messages for permission issues
6. **Update Developer Experience**: Add permission configuration UI in the developer console
7. **Enhance App Store**: Display permission requirements in app listings
8. **Modify Client Applications**:
   - Track and report OS permission changes to cloud via WebSocket
   - Display user-friendly error messages received from cloud
   - Provide guidance on enabling required permissions

## 3. Design

### Permission Types and Stream Mapping

We'll define a simplified set of permission types that directly map to OS-level permissions:

```typescript
export enum PermissionType {
  MICROPHONE = 'MICROPHONE',     // Microphone access for audio/speech features
  LOCATION = 'LOCATION',         // Location services access
  CALENDAR = 'CALENDAR',         // Calendar events access
  NOTIFICATIONS = 'NOTIFICATIONS', // Phone notification access
  ALL = 'ALL',                   // Convenience type requiring all permissions
}
```

Each permission type will map to one or more stream types:

```typescript
// Example mapping
MICROPHONE => [StreamType.AUDIO_CHUNK, StreamType.TRANSCRIPTION, StreamType.TRANSLATION, StreamType.VAD]
LOCATION => [StreamType.LOCATION_UPDATE]
CALENDAR => [StreamType.CALENDAR_EVENT]
NOTIFICATIONS => [StreamType.PHONE_NOTIFICATION, StreamType.NOTIFICATION_DISMISSED]
```

Any stream types not explicitly mapped to these permissions (like button presses, head position) will be considered basic functionality available to all TPAs.

### Components Architecture

The permissions system will consist of these components:

1. **SDK PermissionManager**: Client-side manager for checking permissions status
2. **Cloud PermissionManager**: Server-side session-scoped manager for enforcing permissions
3. **App Schema Extensions**: Additional fields in the app model for permission declarations
4. **Phone Permission Integration**: System for receiving and handling phone permission status

## 4. Implementation Details

### SDK Changes

#### New Permission Manager Class

Path: `/packages/sdk/src/tpa/permission/permission-manager.ts`

```typescript
/**
 * SDK Permission Manager
 * 
 * Provides permission status checks for TPAs
 */
import { PermissionType, PermissionStatus } from '../../types/permissions';
import { EventManager } from '../session/events';
import { TpaToCloudMessageType } from '../../types/message-types';

// Import TpaSession interface for typing
import type { TpaSession } from '../session/index';
import { TpaToCloudMessage } from '../../types';

export class PermissionManager {
  private permissions: Map<PermissionType, PermissionStatus> = new Map();
  
  constructor(
    private session: TpaSession,
    private packageName: string,
    private send: (message: TpaToCloudMessage) => void,
    private events: EventManager
  ) {}

  /**
   * Check if a permission is granted at the OS level
   */
  async hasPermission(permission: PermissionType): Promise<boolean> {
    // Check local cache first
    const status = this.permissions.get(permission);
    if (status === PermissionStatus.GRANTED) return true;
    if (status === PermissionStatus.DENIED) return false;
    
    // Request status from server
    try {
      const response = await this.session.sendRequest({
        type: TpaToCloudMessageType.PERMISSION_CHECK,
        permission,
        packageName: this.packageName,
        sessionId: this.session.getSessionId(),
        timestamp: new Date()
      });
      
      const granted = response.status === PermissionStatus.GRANTED;
      this.permissions.set(permission, granted ? PermissionStatus.GRANTED : PermissionStatus.DENIED);
      return granted;
    } catch (error) {
      console.error(`Permission check failed: ${error}`);
      return false;
    }
  }

  /**
   * Listen for permission status changes
   */
  onPermissionChange(callback: (permission: PermissionType, status: PermissionStatus) => void): () => void {
    return this.events.on('permission_change', (data) => {
      this.permissions.set(data.permission, data.status);
      callback(data.permission, data.status);
    });
  }

  /**
   * Update local permission cache (used internally)
   */
  updatePermission(permission: PermissionType, status: PermissionStatus): void {
    this.permissions.set(permission, status);
    this.events.emit('permission_change', { permission, status });
  }
}
```

#### TpaSession Integration

Path: `/packages/sdk/src/tpa/session/index.ts`

The existing subscribe() method needs to be modified to check permissions:

```typescript
// Existing subscribe method
async subscribe(type: ExtendedStreamType): Promise<void> {
  // Add permission check
  const permissionType = this.getRequiredPermissionForStream(type);
  if (permissionType) {
    const hasPermission = await this.permissions.hasPermission(permissionType);
    if (!hasPermission) {
      this.events.emit('permission_denied', { 
        stream: type, 
        permission: permissionType 
      });
      return;
    }
  }
  
  // Existing code continues...
  this.subscriptions.add(type);
  if (this.ws?.readyState === 1) {
    this.updateSubscriptions();
  }
}
```

### Cloud Changes

#### Permission Manager Implementation

Path: `/packages/cloud/src/services/permissions/permission-manager.ts`

```typescript
import { PermissionType, PermissionStatus } from '@augmentos/sdk';
import { ExtendedUserSession } from '../core/session.service';
import { Logger } from 'winston';

export class PermissionManager {
  private phonePermissions: Map<PermissionType, PermissionStatus> = new Map();
  private streamToPermissionMap: Map<string, PermissionType> = new Map();
  private logger: Logger;
  
  constructor(private userSession: ExtendedUserSession) {
    this.logger = userSession.logger;
    this.initStreamToPermissionMap();
  }
  
  /**
   * Initialize mapping from stream types to permissions
   */
  private initStreamToPermissionMap(): void {
    // Audio-related streams
    this.streamToPermissionMap.set('audio_chunk', PermissionType.MICROPHONE);
    this.streamToPermissionMap.set('transcription', PermissionType.MICROPHONE);
    this.streamToPermissionMap.set('translation', PermissionType.MICROPHONE);
    this.streamToPermissionMap.set('vad', PermissionType.MICROPHONE);
    
    // Location stream
    this.streamToPermissionMap.set('location_update', PermissionType.LOCATION);
    
    // Calendar stream
    this.streamToPermissionMap.set('calendar_event', PermissionType.CALENDAR);
    
    // Notification streams
    this.streamToPermissionMap.set('phone_notification', PermissionType.NOTIFICATIONS);
    this.streamToPermissionMap.set('notification_dismissed', PermissionType.NOTIFICATIONS);
    
    // Language-specific streams
    // Handle dynamically during permission checks
  }
  
  /**
   * Get the required permission for a stream type
   */
  getRequiredPermissionForStream(streamType: string): PermissionType | null {
    // Handle language-specific streams
    if (streamType.startsWith('transcription:')) {
      return PermissionType.MICROPHONE;
    }
    if (streamType.startsWith('translation:')) {
      return PermissionType.MICROPHONE;
    }
    
    // Check regular stream types
    return this.streamToPermissionMap.get(streamType) || null;
  }
  
  /**
   * Check if a stream type is allowed based on current phone permissions
   */
  isStreamAllowed(streamType: string): boolean {
    const requiredPermission = this.getRequiredPermissionForStream(streamType);
    
    // If no permission is required, allow the stream
    if (!requiredPermission) {
      return true;
    }
    
    // Check if the required permission is granted
    const status = this.phonePermissions.get(requiredPermission);
    return status === PermissionStatus.GRANTED;
  }
  
  /**
   * Check if a TPA is allowed to subscribe to a stream
   */
  canSubscribeToStream(packageName: string, streamType: string): boolean {
    // In this simplified model, any TPA can subscribe to any stream
    // as long as the OS-level permission is granted
    return this.isStreamAllowed(streamType);
  }
  
  /**
   * Update phone permission status
   */
  updatePhonePermission(permission: PermissionType, status: PermissionStatus): void {
    const oldStatus = this.phonePermissions.get(permission);
    this.phonePermissions.set(permission, status);
    
    this.logger.info(`Updated phone permission: ${permission} = ${status}`);
    
    // If this is a newly revoked permission, check running TPAs
    if (oldStatus === PermissionStatus.GRANTED && status === PermissionStatus.DENIED) {
      this.handleRevokedPermission(permission);
    }
    
    // Notify all TPAs of permission change
    this.notifyPermissionChange(permission, status);
  }
  
  /**
   * Handle revoked permissions for running TPAs
   */
  private handleRevokedPermission(permission: PermissionType): void {
    // Check all running TPAs
    for (const packageName of this.userSession.activeAppSessions) {
      const app = this.userSession.installedApps.find(a => a.packageName === packageName);
      
      // Skip if app not found
      if (!app) continue;
      
      // Check if app requires this permission
      if (app.permissions && app.permissions.some(p => p.type === permission && p.required)) {
        // This is a required permission, stop the app
        this.logger.info(`Stopping TPA ${packageName} due to revoked required permission: ${permission}`);
        
        // Send notification before stopping
        const connection = this.userSession.appConnections.get(packageName);
        if (connection && connection.readyState === 1) {
          const message = {
            type: 'permission_required',
            permission,
            message: `This app requires the ${permission} permission which has been disabled`,
            timestamp: new Date()
          };
          connection.send(JSON.stringify(message));
        }
        
        // Stop the app
        // TODO: Call appropriate method to stop the TPA
      }
    }
  }
  
  /**
   * Notify TPAs of permission changes
   */
  private notifyPermissionChange(permission: PermissionType, status: PermissionStatus): void {
    // For each active TPA
    for (const packageName of this.userSession.activeAppSessions) {
      const connection = this.userSession.appConnections.get(packageName);
      if (connection && connection.readyState === 1) {
        // Send permission change notification
        const message = {
          type: 'permission_change',
          permission,
          status,
          timestamp: new Date()
        };
        connection.send(JSON.stringify(message));
      }
    }
  }
  
  /**
   * Check if a TPA can start based on its required permissions
   */
  canTpaStart(packageName: string): { canStart: boolean; missingPermissions: PermissionType[] } {
    const app = this.userSession.installedApps.find(a => a.packageName === packageName);
    if (!app || !app.permissions) {
      // No declared permissions, allow start
      return { canStart: true, missingPermissions: [] };
    }
    
    // Check required permissions
    const missingPermissions: PermissionType[] = [];
    
    for (const perm of app.permissions) {
      if (perm.required && this.phonePermissions.get(perm.type) !== PermissionStatus.GRANTED) {
        missingPermissions.push(perm.type);
      }
    }
    
    return {
      canStart: missingPermissions.length === 0,
      missingPermissions
    };
  }
  
  /**
   * Cleanup resources
   */
  dispose(): void {
    this.phonePermissions.clear();
    this.streamToPermissionMap.clear();
  }
}
```

#### Subscription Service Integration

Path: `/packages/cloud/src/services/core/subscription.service.ts`

```typescript
// Add to updateSubscriptions method
updateSubscriptions(
  sessionId: string,
  packageName: string,
  userId: string,
  subscriptions: ExtendedStreamType[]
): void {
  // Get user session
  const userSession = this.sessionService.getSession(sessionId);
  if (!userSession) {
    throw new Error(`User session not found: ${sessionId}`);
  }
  
  // Filter out subscriptions that require disabled permissions
  const allowedSubscriptions = processedSubscriptions.filter(sub => 
    userSession.permissionManager.canSubscribeToStream(packageName, sub)
  );
  
  // If some subscriptions were filtered out, log it
  if (allowedSubscriptions.length < processedSubscriptions.length) {
    userSession.logger.warn(
      `Filtered out ${processedSubscriptions.length - allowedSubscriptions.length} subscriptions ` +
      `for ${packageName} due to missing permissions`
    );
  }
  
  // Existing code continues with allowed subscriptions
  const key = `${sessionId}:${packageName}`;
  this.subscriptions.set(key, new Set(allowedSubscriptions));
  // ...
}
```

#### App Model Extensions

Path: `/packages/cloud/src/models/app.model.ts`

```typescript
// Add to AppSchema
const AppSchema = new Schema({
  // Existing fields...
  
  // Add permissions array
  permissions: [{
    type: {
      type: String,
      enum: ['MICROPHONE', 'LOCATION', 'CALENDAR', 'NOTIFICATIONS', 'ALL'],
      required: true
    },
    required: {
      type: Boolean,
      default: false
    },
    description: {
      type: String,
      required: true
    }
  }]
}, { 
  strict: false,
  timestamps: true 
});
```

#### Session Service Integration

Path: `/packages/cloud/src/services/core/session.service.ts`

```typescript
// Add to ExtendedUserSession interface
export interface ExtendedUserSession extends UserSession {
  // Existing fields...
  permissionManager: PermissionManager;
}

// Add to createSession method
async createSession(ws: WebSocket, userId: string): Promise<ExtendedUserSession> {
  // Existing code...
  
  // Create permission manager for the session
  partialSession.permissionManager = new PermissionManager(partialSession as ExtendedUserSession);
  
  // Rest of the existing code...
}

// Add to endSession method
async endSession(sessionId: string): Promise<void> {
  // Existing code...
  
  // Clean up permission manager
  if (userSession.permissionManager) {
    userSession.permissionManager.dispose();
  }
  
  // Rest of the existing code...
}
```

#### WebSocket Service Integration

Path: `/packages/cloud/src/services/core/websocket.service.ts`

```typescript
// Add to handleTpaInit or startAppSession method
async startAppSession(userSession: ExtendedUserSession, packageName: string): Promise<void> {
  // Check if the TPA can start based on permissions
  const permissionCheck = userSession.permissionManager.canTpaStart(packageName);
  
  if (!permissionCheck.canStart) {
    // TPA can't start due to missing permissions
    userSession.logger.warn(
      `Cannot start TPA ${packageName}: missing required permissions: ${permissionCheck.missingPermissions.join(', ')}`
    );
    
    // Throw an error with clear message about missing permissions
    throw new Error(
      `This app requires the following permissions which are disabled on your device: ` +
      `${permissionCheck.missingPermissions.join(', ')}. ` +
      `Please enable these permissions in your device settings to use this app.`
    );
  }
  
  // Continue with normal app start
  // Existing code...
}
```

### AppStore/Dev Console Requirements

The app store and developer console will need these modifications:

1. **Developer Console**:
   - Add permission selection UI for developers
   - Allow developers to mark permissions as required or optional
   - Require descriptions for why each permission is needed

2. **App Store**:
   - Display permission requirements in app listings
   - Indicate which permissions are required vs. optional
   - Show developer-provided explanations for permissions

3. **App Installation Flow**:
   - Inform users about permission requirements during installation
   - Allow installation even if required permissions are currently disabled
   - Provide clear messaging if the app can't be started due to disabled permissions

### Client Behavior Requirements

The iOS/Android client apps will need to:

1. **Track Permission Status**:
   - Monitor system permission changes (microphone, location, etc.)
   
2. **Send Permission Updates**:
   ```json
   {
     "type": "phone_permissions_update",
     "permissions": {
       "LOCATION": true,
       "MICROPHONE": false,
       "CALENDAR": true,
       "NOTIFICATIONS": true
     },
     "timestamp": "2023-04-15T14:30:00Z"
   }
   ```

3. **Handle Permission Errors**:
   - Show clear error messages when apps can't start due to permission issues
   - Provide guidance on how to enable required permissions

## 5. Permission Flows

### 1. User Views App in App Store

- App store displays list of required and optional permissions
- Shows descriptions of why each permission is needed
- User can see if their current phone permission settings are compatible

### 2. Installing TPA

- User can install any TPA regardless of current permission settings
- App store informs user about required permissions
- Installation is considered consent to use all declared permissions if they're enabled at the OS level

### 3. Starting TPA with Insufficient Permissions

- If required permissions are disabled at OS level, start is blocked
- Display clear error message explaining which permissions are needed
- Provide direct guidance on how to enable required permissions in device settings

### 4. Runtime Permission Changes

**When phone permissions are enabled:**
1. Client sends `PHONE_PERMISSIONS_UPDATE` to cloud
2. Cloud updates its permission state
3. Previously blocked TPAs can now be started
4. Running TPAs gain access to newly enabled data streams
5. Notification sent to affected TPAs about permission change

**When phone permissions are disabled:**
1. Client sends `PHONE_PERMISSIONS_UPDATE` to cloud
2. Cloud updates its permission state
3. Running TPAs that require the permission as optional:
   - Continue running with reduced functionality
   - Stop receiving events that require the disabled permission
4. Running TPAs that require the permission as required:
   - Are stopped with a clear error message
   - Receive notification about why they're being stopped

## 6. Edge Cases

### Handling Existing Apps

For backward compatibility, existing TPAs without declared permissions will:
- Be treated as if they have no required permissions
- Still be subject to OS permission constraints for sensitive streams
- Not appear in app store with explicit permission requirements

### Required vs Optional Permission Behaviors

**Required Permissions:**
- TPA cannot start without these permissions enabled at OS level
- When revoked at runtime, TPA is stopped with an error message
- User must enable the permission at OS level to use the TPA

**Optional Permissions:**
- TPA can start without these permissions
- When revoked at runtime, TPA continues with limited functionality
- Data streams dependent on the permission are filtered out

### Clear User Messaging

When permissions prevent functionality, users will see:
1. Which permission is needed at the OS level
2. Why it's needed (from developer description)
3. How to enable it in device settings
4. Alternative options if available

## 7. API Reference

### Developer-Facing Permission APIs

The SDK exposes permissions as a property of the session object that developers receive in the `onSession` method:

```typescript
/**
 * Handle new TPA session
 * This is called automatically by the TpaServer base class
 */
protected async onSession(session: TpaSession, sessionId: string, userId: string): Promise<void> {
  // Check if microphone permission is enabled at OS level
  if (session.permission.microphone) {
    // Microphone permission is enabled, we can subscribe to audio streams
    session.onTranscription((data) => {
      console.log('Transcription:', data.text);
    });
  } else {
    console.log('Microphone permission is disabled');
    // Show alternative UI or functionality since this is an optional permission
  }
  
  // Listen for permission changes for optional permissions
  const cleanup = session.permission.onChange((changes) => {
    if (changes.location === false) {
      // Location permission was disabled
      disableLocationFeatures();
    } else if (changes.microphone === true) {
      // Microphone permission was enabled
      enableSpeechFeatures();
    }
  });
  
  // Can also use the more explicit API if needed
  const hasCalendarAccess = await session.permission.has(PermissionType.CALENDAR);
  
  // Be notified when a subscription is rejected due to permissions
  session.on('permission_denied', (data) => {
    console.log(`Cannot access ${data.stream} - required permission is disabled`);
  });
}
```

For permissions declared as **required**, the behavior is different. If a required permission becomes disabled at the OS level, the cloud will automatically stop the TPA. Developers can handle this in their TPA server:

```typescript
/**
 * Handle TPA being stopped
 * This is called automatically by the TpaServer base class
 */
protected onStop(sessionId: string, userId: string, reason?: string): void {
  if (reason === 'permission_disabled') {
    // TPA was stopped because a required permission was disabled
    console.log('TPA stopped due to a required permission being disabled');
    
    // Perform any necessary cleanup
    this.cleanupResources(sessionId);
    
    // Log analytics or notify your backend as needed
    this.logPermissionStopEvent(userId);
  }
}
```

This callback helps developers distinguish between normal user-initiated stops and permission-related stops, allowing appropriate handling of each case.

### Internal Permission Checking System

```typescript
// Check if stream is allowed (cloud-side)
const canAccessLocation = userSession.permissionManager.isStreamAllowed('location_update');

// Check if TPA can start based on permissions
const { canStart, missingPermissions } = userSession.permissionManager.canTpaStart(packageName);

// Update phone permission status
userSession.permissionManager.updatePhonePermission(
  PermissionType.LOCATION, 
  PermissionStatus.GRANTED
);
```