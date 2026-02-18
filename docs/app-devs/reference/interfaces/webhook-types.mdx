---
sidebar_position: 4
title: Webhook Types
---

# Webhook Types

This page documents the webhook interfaces used for communication between MentraOS Cloud and App servers.

Webhooks are HTTP requests sent from MentraOS Cloud to your App server to manage the lifecycle of App sessions.

## BaseWebhookRequest

The base structure for all webhook requests sent to App servers.

```typescript
interface BaseWebhookRequest extends BaseMessage {
  /** The specific type of webhook request. */
  type: WebhookRequestType;

  /** The session identifier this request pertains to. */
  sessionId: string;

  /** The user identifier this request pertains to. */
  userId: string;

  /** Timestamp string when the webhook was generated. */
  timestamp: string;
}
```

## SessionWebhookRequest

Webhook sent to initiate a new App session. Handled by [`AppServer.onSession`](/reference/app-server#onsession-protected).

```typescript
interface SessionWebhookRequest extends BaseWebhookRequest {
  /** Must be WebhookRequestType.SESSION_REQUEST. */
  type: WebhookRequestType.SESSION_REQUEST;

  /** The specific WebSocket URL the AppSession should connect to for this session. */
  mentraOSWebsocketUrl?: string;
}
```

**Example:**
```typescript
// This is handled automatically by AppServer, but here's how it looks
{
  "type": "session_request",
  "sessionId": "session-123456",
  "userId": "user-789012",
  "timestamp": "2023-04-01T12:30:45Z",
  "mentraOSWebsocketUrl": "wss://api.mentra.glass/app-ws/session-123456"
}
```

When this webhook is received, your [`AppServer.onSession`](/reference/app-server#onsession-protected) method is called with a new [`AppSession`](/reference/app-session) instance, the `sessionId`, and the `userId`.

## StopWebhookRequest

Webhook sent to request stopping a App session. Handled by [`AppServer.onStop`](/reference/app-server#onstop-protected).

```typescript
interface StopWebhookRequest extends BaseWebhookRequest {
  /** Must be WebhookRequestType.STOP_REQUEST. */
  type: WebhookRequestType.STOP_REQUEST;

  /** The reason the session is being stopped. */
  reason: 'user_disabled' | 'system_stop' | 'error';
}
```

**Example:**
```typescript
// This is handled automatically by AppServer, but here's how it looks
{
  "type": "stop_request",
  "sessionId": "session-123456",
  "userId": "user-789012",
  "timestamp": "2023-04-01T13:45:30Z",
  "reason": "user_disabled"
}
```

When this webhook is received, your [`AppServer.onStop`](/reference/app-server#onstop-protected) method is called with the `sessionId`, `userId`, and `reason`.

## ServerRegistrationWebhookRequest

Webhook confirming successful registration of the App server with MentraOS Cloud.

```typescript
interface ServerRegistrationWebhookRequest extends BaseWebhookRequest {
  /** Must be WebhookRequestType.SERVER_REGISTRATION. */
  type: WebhookRequestType.SERVER_REGISTRATION;

  /** Unique ID for this server registration. */
  registrationId: string;

  /** Package name of the registered App. */
  packageName: string;

  /** URLs associated with this registration. */
  serverUrls: string[];
}
```

**Example:**
```typescript
{
  "type": "server_registration",
  "sessionId": "registration-123456",
  "userId": "system",
  "timestamp": "2023-04-01T10:00:00Z",
  "registrationId": "reg-78901234",
  "packageName": "org.company.myapp",
  "serverUrls": ["https://myapp-app.example.com/webhook"]
}
```

## SessionRecoveryWebhookRequest

Webhook sent when the cloud attempts to recover a potentially disconnected session.

```typescript
interface SessionRecoveryWebhookRequest extends BaseWebhookRequest {
  /** Must be WebhookRequestType.SESSION_RECOVERY. */
  type: WebhookRequestType.SESSION_RECOVERY;

  /** The WebSocket URL to use for reconnection. */
  mentraOSWebsocketUrl: string;
}
```

**Example:**
```typescript
{
  "type": "session_recovery",
  "sessionId": "session-123456",
  "userId": "user-789012",
  "timestamp": "2023-04-01T14:15:30Z",
  "mentraOSWebsocketUrl": "wss://api.mentra.glass/app-ws/session-123456"
}
```

## ServerHeartbeatWebhookRequest

Webhook sent periodically to check App server health. Requires a success response.

```typescript
interface ServerHeartbeatWebhookRequest extends BaseWebhookRequest {
  /** Must be WebhookRequestType.SERVER_HEARTBEAT. */
  type: WebhookRequestType.SERVER_HEARTBEAT;

  /** The registration ID being checked. */
  registrationId: string;
}
```

**Example:**
```typescript
{
  "type": "server_heartbeat",
  "sessionId": "heartbeat-123456",
  "userId": "system",
  "timestamp": "2023-04-01T14:30:00Z",
  "registrationId": "reg-78901234"
}
```

## WebhookResponse

Standard response structure App servers should return for webhook requests.

```typescript
interface WebhookResponse {
  /** Indicates success or failure of handling the webhook. */
  status: 'success' | 'error';

  /** Optional message providing details, especially on error. */
  message?: string;
}
```

**Example Success Response:**
```typescript
{
  "status": "success"
}
```

**Example Error Response:**
```typescript
{
  "status": "error",
  "message": "Failed to create session: Invalid configuration"
}
```

## Type Guards

The SDK provides utility functions to check the type of webhook request:

```typescript
// Check if a request is a session request
function isSessionWebhookRequest(request: WebhookRequest): request is SessionWebhookRequest;

// Check if a request is a stop request
function isStopWebhookRequest(request: WebhookRequest): request is StopWebhookRequest;

// Check if a request is a server registration request
function isServerRegistrationWebhookRequest(request: WebhookRequest): request is ServerRegistrationWebhookRequest;

// Check if a request is a session recovery request
function isSessionRecoveryWebhookRequest(request: WebhookRequest): request is SessionRecoveryWebhookRequest;

// Check if a request is a server heartbeat request
function isServerHeartbeatWebhookRequest(request: WebhookRequest): request is ServerHeartbeatWebhookRequest;
```

**Example (For Manual Webhook Processing):**
```typescript
// You typically don't need to do this as AppServer handles it automatically
function processWebhook(request: WebhookRequest): WebhookResponse {
  if (isSessionWebhookRequest(request)) {
    // Handle session request
    return { status: 'success' };
  } else if (isStopWebhookRequest(request)) {
    // Handle stop request
    return { status: 'success' };
  } else {
    // Unknown request type
    return {
      status: 'error',
      message: `Unknown webhook type: ${request.type}`
    };
  }
}
```

## Webhook Flow

1. **Registration**: When your [`AppServer`](/reference/app-server) starts, it is registered with MentraOS Cloud.
2. **Server Registration Confirmation**: MentraOS Cloud sends a [`SERVER_REGISTRATION`](/reference/enums#webhookrequesttype) webhook to confirm registration.
3. **Heartbeat**: MentraOS Cloud periodically sends [`SERVER_HEARTBEAT`](/reference/enums#webhookrequesttype) webhooks to check if your server is still running.
4. **Session Initialization**: When a user starts your App, MentraOS Cloud sends a [`SESSION_REQUEST`](/reference/enums#webhookrequesttype) webhook.
5. **Session Termination**: When a user stops your App or there's a system issue, a [`STOP_REQUEST`](/reference/enums#webhookrequesttype) webhook is sent.
6. **Session Recovery**: If MentraOS Cloud restarts or detects a potential disconnection, it may send a [`SESSION_RECOVERY`](/reference/enums#webhookrequesttype) webhook.