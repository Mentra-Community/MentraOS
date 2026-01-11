# Silent Photo Request Spec

## Overview

Add cloud-controlled `silent` mode for photo requests. When `silent: true`, the glasses disable LED flash and shutter sound during capture. The cloud determines this based on the requesting app's packageName—not exposed as an SDK option.

## Problem

AI apps like Mira and MentraAI take photos continuously for context awareness. Currently:

1. Each photo triggers LED flash and shutter sound
2. This is disruptive in social/work settings
3. Users complain about the visible/audible feedback
4. The `silent` parameter exists in the pipeline but cloud doesn't set it

### Evidence

The parameter flows correctly when set:

```
Mobile (SocketComms.ts):     silent = msg.silent ?? true
iOS (MentraLive.swift):      json["silent"] = silent
Android (PhotoCommandHandler.java):  boolean silent = data.optBoolean("silent", false)
                                     boolean enableLed = !silent
```

But the Cloud never sends it:

```typescript
// PhotoManager.ts - current code (missing silent)
const messageToGlasses = {
  type: CloudToGlassesMessageType.PHOTO_REQUEST,
  requestId,
  appId: packageName,
  webhookUrl,
  authToken,
  size,
  compress,
  timestamp: new Date(),
  // ❌ No silent field
};
```

## Goals

1. Add `silent` field to photo request types in SDK
2. Cloud sets `silent: true` for whitelisted AI apps
3. Configurable via env var for additional packages
4. No SDK API exposure—developers cannot request silent mode

## Non-Goals

- Exposing `silent` as an SDK option for developers
- Per-user preferences for silent mode
- Changing mobile or ASG client code (already works)

## Implementation

### Allowlist

Hardcoded packages that always get `silent: true`:

```typescript
const SILENT_PHOTO_PACKAGES = new Set([
  'com.mentra.mira',
  'com.mentra.mentraai',
  'com.mentra.mentraai.beta',
]);
```

### Environment Variable

Optional env var to add more packages:

```
SILENT_PHOTO_PACKAGES=com.example.app1,com.example.app2
```

Merged into the set at startup.

### Type Changes

**`sdk/src/types/messages/cloud-to-glasses.ts`**:

```typescript
export interface PhotoRequestToGlasses extends BaseMessage {
  type: CloudToGlassesMessageType.PHOTO_REQUEST;
  requestId: string;
  appId: string;
  saveToGallery?: boolean;
  webhookUrl?: string;
  authToken?: string;
  size?: "small" | "medium" | "large" | "full";
  compress?: "none" | "medium" | "heavy";
  silent?: boolean;  // NEW: Disables LED and shutter sound when true
}
```

### PhotoManager Changes

**`cloud/src/services/session/PhotoManager.ts`**:

```typescript
// At module level
const SILENT_PHOTO_PACKAGES = new Set([
  'com.mentra.mira',
  'com.mentra.mentraai', 
  'com.mentra.mentraai.beta',
]);

// Add env var packages at startup
const envPackages = process.env.SILENT_PHOTO_PACKAGES?.split(',').map(p => p.trim()) || [];
envPackages.forEach(pkg => SILENT_PHOTO_PACKAGES.add(pkg));

// In requestPhoto()
const silent = SILENT_PHOTO_PACKAGES.has(packageName);

const messageToGlasses = {
  type: CloudToGlassesMessageType.PHOTO_REQUEST,
  // ... existing fields
  silent,  // NEW
};
```

## Behavior Matrix

| packageName | silent value | LED | Sound |
|-------------|--------------|-----|-------|
| `com.mentra.mira` | `true` | Off | Off |
| `com.mentra.mentraai` | `true` | Off | Off |
| `com.mentra.mentraai.beta` | `true` | Off | Off |
| Any other app | `false` | On | On |
| App in `SILENT_PHOTO_PACKAGES` env | `true` | Off | Off |

## Testing

1. Request photo from Mira → Verify no LED/sound
2. Request photo from random app → Verify LED/sound
3. Add package to env var → Verify silent mode works
4. Check logs show `silent: true/false` in photo request

## Open Questions

1. **Should we log when silent mode is used?**
   - Probably yes, for debugging
   - Decision: Log at debug level

2. **What if an app in the allowlist is compromised?**
   - Silent photos could be privacy concern
   - Mitigation: Only first-party apps in hardcoded list, third-party via env var requires deploy