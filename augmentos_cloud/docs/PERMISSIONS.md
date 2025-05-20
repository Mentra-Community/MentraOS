# AugmentOS Permissions System

This document describes the permissions system in AugmentOS, which controls what data Third-Party Applications (TPAs) can access.

## Overview

The permissions system ensures that TPAs can only access data streams they have explicitly declared permissions for. This provides transparency to users about what data TPAs are using and ensures TPAs are only accessing data they need.

## Permission Types

AugmentOS defines the following permission types:

| Permission | Description | Required For |
| ---------- | ----------- | ----------- |
| `MICROPHONE` | Access to audio data and speech recognition | Audio streams, transcription, translation |
| `LOCATION` | Access to user's location data | Location updates |
| `CALENDAR` | Access to calendar events | Calendar data |
| `NOTIFICATIONS` | Access to phone notifications | Phone notifications |
| `ALL` | Access to all data streams | Legacy apps and system applications |

## Stream-Permission Mapping

Here are the streams that require specific permissions:

- **MICROPHONE Permission**:
  - `audio_chunk`
  - `transcription` (including language-specific like `transcription:en-US`)
  - `translation` (including language-specific like `translation:es-ES-to-en-US`)
  - `VAD` (Voice Activity Detection)

- **LOCATION Permission**:
  - `location_update`

- **CALENDAR Permission**:
  - `calendar_event`

- **NOTIFICATIONS Permission**:
  - `phone_notification`
  - `notification_dismissed`

Other streams like `button_press`, `head_position`, etc. don't require specific permissions.

## For Developers

### How to Declare Permissions

In the Developer Portal, when creating or editing your app, you'll need to declare the permissions your app requires. Each permission should have:

1. Permission Type (from the list above)
2. Description (explaining why your app needs this permission)

### Subscription Validation

When your app tries to subscribe to data streams, the system checks if you've declared the necessary permissions:

```typescript
// This will work if your app has MICROPHONE permission
session.subscribe('transcription');

// This will fail if your app doesn't have LOCATION permission
session.subscribe('location_update');
```

If your app tries to subscribe to a stream without declaring the required permission, the subscription will be rejected with an error message explaining which permission is missing.

### Error Handling

When a subscription is rejected due to missing permissions, your app will receive a `permission_error` message:

```json
{
  "type": "permission_error",
  "message": "Some subscriptions were rejected due to missing permissions",
  "details": [
    {
      "stream": "audio_chunk",
      "requiredPermission": "MICROPHONE",
      "message": "To subscribe to audio_chunk, add the MICROPHONE permission in the developer portal"
    }
  ],
  "timestamp": "2023-06-05T12:34:56.789Z"
}
```

Your app should handle these errors gracefully and provide appropriate feedback to users.

## For System Administrators

### Migration

Existing apps have been automatically granted the `ALL` permission for backward compatibility. New apps must explicitly declare their required permissions.

### Migration Commands

- To add the `ALL` permission to existing apps: `bun run migrate:permissions`
- To verify the current permission status: `bun run verify:permissions`

## Implementation Details

The permission system is implemented as follows:

1. Permission declarations are stored in the MongoDB `App` document
2. The `SimplePermissionChecker` validates subscriptions against declared permissions
3. The `SubscriptionService` filters subscriptions based on declared permissions

For more details, see the technical implementation in:
- `/packages/cloud/src/services/permissions/simple-permission-checker.ts`
- `/packages/cloud/src/services/core/subscription.service.ts`