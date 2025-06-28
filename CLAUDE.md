# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
MentraOS is an open source operating system, app store, and development framework for smart glasses.

- Architecture: Smart glasses connect to user's phone via BLE; phone connects to backend; backend connects to third-party app servers running the MentraOS SDK
- Mobile app: `augmentos_manager` (React Native with native modules)
- Android logic: `augmentos_core`
- iOS native module: `augmentos_manager/ios`
- Backend & web portals: `augmentos_cloud` (includes developer portal & app store)
- Android-based smart glasses client: `augmentos_asg_client` (uses `augmentos_core` as a library)
- MentraOS Store: `augmentos_cloud/store/` (web app for app discovery)
- Developer Console: `augmentos_cloud/developer-portal/` (web app for app management)

## Build Commands

### React Native (augmentos_manager)
- Start dev server: `npm start`
- Run on platforms: `npm run android`, `npm run ios`
- Build Android: `npm run build-android`, `npm run build-android-release`
- Run tests: `npm test`, `npm test -- -t "test name"` (single test)
- Lint code: `npm run lint`
- iOS setup: `cd ios && pod install && cd ..`

### Cloud Backend (augmentos_cloud)
- Install deps: `bun install`
- Setup environment: `./scripts/docker-setup.sh` or `bun run setup-deps && bun run dev`
- Setup Docker network: `bun run dev:setup-network`

## Prerequisites
- Node.js and npm/yarn/bun
- Android Studio (for Android development)
- Xcode (for iOS development)
- Docker and Docker Compose (for cloud development)
- Java SDK 17 (for Android components)

## Code Style Guidelines
- Java/Android: Java SDK 17 required
  - Classes: PascalCase
  - Methods: camelCase
  - Constants: UPPER_SNAKE_CASE
  - Member variables: mCamelCase (with m prefix)
  - Javadoc for public methods and classes
  - 2-space indentation
  - EventBus for component communication

- TypeScript/React Native:
  - Functional components with React hooks
  - Imports: Group by external/internal, alphabetize within groups
  - Formatting: Prettier with single quotes, no bracket spacing, trailing commas
  - Navigation: React Navigation with typed params
  - Context API for app-wide state
  - Feature-based organization under src/
  - Use try/catch with meaningful error messages

## Naming Conventions
- Top-level folders: `augmentos_${component}`
- User-facing names: CamelCase ("MentraOS App", "MentraOS Store", "MentraOS Manager")
- Code follows language-specific conventions (Java, TypeScript, Swift)

## Project Resources
- [GitHub Project Board - General Tasks](https://github.com/orgs/Mentra-Community/projects/2)
- [GitHub Project Board - iOS Tasks](https://github.com/orgs/Mentra-Community/projects/1)
- [Discord Community](https://discord.gg/5ukNvkEAqT)

## AugmentosService.java Update for WiFi Support
To add WiFi support flag in AugmentosService.java, use this code in the generateStatusJson method:

```java
// In generateStatusJson method where glasses info is being populated
// This is approximately at lines 1150-1160 in AugmentosService.java

// Add WiFi status information for glasses that need WiFi
String deviceModel = smartGlassesManager.getConnectedSmartGlasses().deviceModelName;

// Check if these are glasses that support WiFi
boolean usesWifi = deviceModel != null && (deviceModel.contains("Mentra Live") || deviceModel.contains("Android Smart Glasses"));

// Add the general WiFi support flag for all models
connectedGlasses.put("glasses_use_wifi", usesWifi);

// Add detailed WiFi status, but only for models that support it
if (usesWifi) {
    connectedGlasses.put("glasses_wifi_connected", glassesWifiConnected);
    connectedGlasses.put("glasses_wifi_ssid", glassesWifiSsid);
}
```

# App-to-App Communication Protocol Design

## Overview

This document outlines the design for enabling Apps to communicate with other Apps that have active sessions with the same App package, creating a multi-user collaborative experience within MentraOS.

## Current Architecture

### Existing Components
- **UserSession**: Manages user state with `appConnections: Map<string, WebSocket>`
- **AppSession**: Individual App connection to MentraOS Cloud
- **SubscriptionService**: Manages App subscriptions to data streams
- **Custom Messages**: `CUSTOM_MESSAGE` type already exists for flexible messaging

### Current Message Flow
```
App → Cloud (AppToCloudMessage)
Cloud → App (CloudToAppMessage)
```

## Proposed Multi-User App Communication

### 1. New Message Types

#### App-to-Cloud Messages
```typescript
// New message types for App-to-App communication
export enum AppToCloudMessageType {
  // ... existing types
  APP_BROADCAST_MESSAGE = 'app_broadcast_message',
  APP_DIRECT_MESSAGE = 'app_direct_message',
  APP_USER_DISCOVERY = 'app_user_discovery',
  APP_ROOM_JOIN = 'app_room_join',
  APP_ROOM_LEAVE = 'app_room_leave'
}

// Broadcast message to all users with same App
interface AppBroadcastMessage extends BaseMessage {
  type: AppToCloudMessageType.APP_BROADCAST_MESSAGE;
  packageName: string;
  sessionId: string;
  payload: any;
  messageId: string;
  timestamp: Date;
  senderUserId: string;
  roomId?: string; // Optional room-based messaging
}

// Direct message to specific user with same App
interface AppDirectMessage extends BaseMessage {
  type: AppToCloudMessageType.APP_DIRECT_MESSAGE;
  packageName: string;
  sessionId: string;
  targetUserId: string;
  payload: any;
  messageId: string;
  timestamp: Date;
  senderUserId: string;
}

// Discover other users with same App active
interface AppUserDiscovery extends BaseMessage {
  type: AppToCloudMessageType.APP_USER_DISCOVERY;
  packageName: string;
  sessionId: string;
  includeUserProfiles?: boolean;
}

// Join a communication room
interface AppRoomJoin extends BaseMessage {
  type: AppToCloudMessageType.APP_ROOM_JOIN;
  packageName: string;
  sessionId: string;
  roomId: string;
  roomConfig?: {
    maxUsers?: number;
    isPrivate?: boolean;
    metadata?: any;
  };
}
```

#### Cloud-to-App Messages
```typescript
export enum CloudToAppMessageType {
  // ... existing types
  APP_MESSAGE_RECEIVED = 'app_message_received',
  APP_USER_JOINED = 'app_user_joined',
  APP_USER_LEFT = 'app_user_left',
  APP_ROOM_UPDATED = 'app_room_updated'
}

// Message received from another App user
interface AppMessageReceived extends BaseMessage {
  type: CloudToAppMessageType.APP_MESSAGE_RECEIVED;
  payload: any;
  messageId: string;
  senderUserId: string;
  senderSessionId: string;
  messageType: 'broadcast' | 'direct';
  roomId?: string;
  timestamp: Date;
}
```

### 2. Multi-User Session Manager

```typescript
// New service to manage multi-user App sessions
export class MultiUserAppService {
  // Map of packageName -> Set of active user sessions
  private activeAppSessions = new Map<string, Set<string>>();

  // Map of packageName -> Map of roomId -> Set of userIds
  private appRooms = new Map<string, Map<string, Set<string>>>();

  // Message history for debugging/replay
  private messageHistory = new Map<string, AppMessage[]>();

  /**
   * Get all active users for a specific App package
   */
  getActiveAppUsers(packageName: string): string[] {
    return Array.from(this.activeAppSessions.get(packageName) || []);
  }

  /**
   * Broadcast message to all users with the same App active
   */
  async broadcastToAppUsers(
    senderSession: UserSession,
    message: AppBroadcastMessage
  ): Promise<void> {
    const packageName = message.packageName;
    const activeUsers = this.getActiveAppUsers(packageName);

    for (const userId of activeUsers) {
      // Skip sender
      if (userId === senderSession.userId) continue;

      const targetSession = this.sessionService.getSessionByUserId(userId);
      if (!targetSession) continue;

      const targetAppConnection = targetSession.appConnections.get(packageName);
      if (!targetAppConnection || targetAppConnection.readyState !== WebSocket.OPEN) {
        continue;
      }

      const receivedMessage: AppMessageReceived = {
        type: CloudToAppMessageType.APP_MESSAGE_RECEIVED,
        payload: message.payload,
        messageId: message.messageId,
        senderUserId: message.senderUserId,
        senderSessionId: message.sessionId,
        messageType: 'broadcast',
        roomId: message.roomId,
        timestamp: message.timestamp
      };

      targetAppConnection.send(JSON.stringify(receivedMessage));
    }
  }

  /**
   * Send direct message to specific user
   */
  async sendDirectMessage(
    senderSession: UserSession,
    message: AppDirectMessage
  ): Promise<boolean> {
    const targetSession = this.sessionService.getSessionByUserId(message.targetUserId);
    if (!targetSession) return false;

    const targetAppConnection = targetSession.appConnections.get(message.packageName);
    if (!targetAppConnection || targetAppConnection.readyState !== WebSocket.OPEN) {
      return false;
    }

    const receivedMessage: AppMessageReceived = {
      type: CloudToAppMessageType.APP_MESSAGE_RECEIVED,
      payload: message.payload,
      messageId: message.messageId,
      senderUserId: message.senderUserId,
      senderSessionId: message.sessionId,
      messageType: 'direct',
      timestamp: message.timestamp
    };

    targetAppConnection.send(JSON.stringify(receivedMessage));
    return true;
  }

  /**
   * Handle user joining App session
   */
  addAppUser(packageName: string, userId: string): void {
    if (!this.activeAppSessions.has(packageName)) {
      this.activeAppSessions.set(packageName, new Set());
    }

    this.activeAppSessions.get(packageName)!.add(userId);
    this.notifyUserJoined(packageName, userId);
  }

  /**
   * Handle user leaving App session
   */
  removeAppUser(packageName: string, userId: string): void {
    const users = this.activeAppSessions.get(packageName);
    if (users) {
      users.delete(userId);
      if (users.size === 0) {
        this.activeAppSessions.delete(packageName);
      }
    }
    this.notifyUserLeft(packageName, userId);
  }
}
```

### 3. SDK Enhancements

```typescript
// Enhanced AppSession with multi-user capabilities
export class AppSession {
  // ... existing code

  /**
   * Send broadcast message to all users with same App active
   */
  broadcastToAppUsers(payload: any, roomId?: string): Promise<void> {
    const message: AppBroadcastMessage = {
      type: AppToCloudMessageType.APP_BROADCAST_MESSAGE,
      packageName: this.config.packageName,
      sessionId: this.sessionId!,
      payload,
      messageId: this.generateMessageId(),
      timestamp: new Date(),
      senderUserId: this.userId,
      roomId
    };

    this.send(message);
    return Promise.resolve();
  }

  /**
   * Send direct message to specific user
   */
  sendDirectMessage(targetUserId: string, payload: any): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const messageId = this.generateMessageId();

      // Store promise resolver
      this.pendingDirectMessages.set(messageId, { resolve, reject });

      const message: AppDirectMessage = {
        type: AppToCloudMessageType.APP_DIRECT_MESSAGE,
        packageName: this.config.packageName,
        sessionId: this.sessionId!,
        targetUserId,
        payload,
        messageId,
        timestamp: new Date(),
        senderUserId: this.userId
      };

      this.send(message);
    });
  }

  /**
   * Discover other users with same App active
   */
  discoverAppUsers(includeProfiles = false): Promise<AppUserList> {
    return new Promise((resolve, reject) => {
      const message: AppUserDiscovery = {
        type: AppToCloudMessageType.APP_USER_DISCOVERY,
        packageName: this.config.packageName,
        sessionId: this.sessionId!,
        includeUserProfiles: includeProfiles
      };

      // Store resolver for response
      this.pendingDiscoveryRequests.set(this.sessionId!, resolve);
      this.send(message);
    });
  }

  /**
   * Listen for messages from other App users
   */
  onAppMessage(handler: (message: AppMessageReceived) => void): () => void {
    return this.events.on('app_message_received', handler);
  }

  /**
   * Listen for user join/leave events
   */
  onAppUserJoined(handler: (userId: string) => void): () => void {
    return this.events.on('app_user_joined', handler);
  }

  onAppUserLeft(handler: (userId: string) => void): () => void {
    return this.events.on('app_user_left', handler);
  }
}
```

### 4. Implementation Steps

#### Phase 1: Core Infrastructure
1. **Add new message types** to `message-types.ts`
2. **Create MultiUserAppService** in cloud services
3. **Integrate with WebSocketService** to handle new message types
4. **Add user tracking** when Apps connect/disconnect

#### Phase 2: SDK Enhancements
1. **Extend AppSession** with multi-user methods
2. **Add event handlers** for App messages
3. **Create helper utilities** for message formatting
4. **Add TypeScript types** for all new interfaces

#### Phase 3: Advanced Features
1. **Room-based messaging** for group conversations
2. **Message persistence** and history
3. **User presence indicators** (online/offline/busy)
4. **Rate limiting** to prevent spam
5. **Permission system** for App-to-App communication

#### Phase 4: Developer Experience
1. **Documentation and examples**
2. **Testing utilities**
3. **Debug tools** for multi-user sessions
4. **Performance monitoring**

### 5. Security Considerations

- **Permission Checks**: Ensure Apps have permission for multi-user communication
- **Rate Limiting**: Prevent message spam between Apps
- **User Privacy**: Only share necessary user information
- **Message Validation**: Sanitize payloads to prevent XSS/injection
- **Session Isolation**: Ensure messages only go to intended App instances

### 6. Example Usage

```typescript
// Example collaborative note-taking app
const session = new AppSession({
  packageName: 'com.example.collaborative-notes',
  apiKey: 'your-api-key',
  userId: 'user@example.com'
});

await session.connect('session-123');

// Discover other users
const activeUsers = await session.discoverAppUsers(true);
console.log(`${activeUsers.totalUsers} users are using this app`);

// Listen for collaborative changes
session.onAppMessage((message) => {
  if (message.payload.type === 'note_update') {
    updateNoteInRealtime(message.payload.noteData);
  }
});

// Broadcast a note update
session.broadcastToAppUsers({
  type: 'note_update',
  noteId: 'note-123',
  changes: {
    text: 'Updated content',
    cursor: { line: 1, col: 10 }
  }
});

// Send direct message to specific user
await session.sendDirectMessage('other-user@example.com', {
  type: 'cursor_position',
  position: { x: 100, y: 200 }
});
```

## Benefits

1. **Real-time Collaboration**: Multiple users can interact within the same App
2. **Scalable Architecture**: Leverages existing infrastructure
3. **Developer Friendly**: Simple API for App developers
4. **Flexible Messaging**: Supports both broadcast and direct messaging
5. **Room Support**: Enables group-based communication
6. **Backward Compatible**: Doesn't affect existing App functionality

This design enables rich multi-user experiences while maintaining the security and performance characteristics of the existing MentraOS platform.