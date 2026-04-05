# LC3 Bitrate Upgrade Plan: 16kbps → 32kbps

## Problem Statement

Current LC3 audio streaming from mobile to cloud uses 16kbps (20-byte frames), which results in poor transcription accuracy. We need to upgrade to 32kbps (40-byte frames) while maintaining backwards compatibility with existing clients.

## Current State

### Bitrate Comparison
| Format | Bandwidth | vs Raw PCM |
|--------|-----------|------------|
| Raw PCM 16kHz 16-bit | 256 kbps | baseline |
| LC3 @ 16 kbps (current) | 16 kbps | 16x smaller |
| LC3 @ 32 kbps (target) | 32 kbps | 8x smaller |
| LC3 @ 48 kbps (future option) | 48 kbps | 5.3x smaller |

### Current Hardcoded Values

**Cloud - LC3Service** (`cloud/packages/cloud/src/services/lc3/lc3.service.ts`):
```typescript
private readonly frameBytes = 20; // Hardcoded, constructor override commented out
```

**Cloud - audio-config.api.ts** (`cloud/packages/cloud/src/api/hono/client/audio-config.api.ts`):
```typescript
// Rejects any non-canonical config, forces 20-byte frames
if (sampleRate !== 16000 || frameDurationMs !== 10 || frameSizeBytes !== 20) {
  // Forces defaults...
}
```

**Mobile - Android** (`mobile/modules/core/android/.../CoreManager.kt`):
```kotlin
const val LC3_FRAME_SIZE = 20
```

**Mobile - iOS** (`mobile/modules/core/ios/Packages/CoreObjC/PcmConverter.m`):
```objc
#define LC3_FRAME_SIZE 20
```

**Mobile - SocketComms.ts**:
```typescript
frameSizeBytes: 20  // Hardcoded in configureAudioFormat()
```

---

## Implementation Plan

### Phase 1: Cloud Changes (Backend First)

#### 1.1 Update LC3Service to Accept Frame Size

**File**: `cloud/packages/cloud/src/services/lc3/lc3.service.ts`

- Uncomment/enable the `frameBytes` constructor parameter
- Update `createLC3Service()` factory to accept `frameBytes`
- Validate allowed values: 20, 40, 60 (16/32/48 kbps)

#### 1.2 Update AudioManager to Accept Frame Size

**File**: `cloud/packages/cloud/src/services/session/AudioManager.ts`

- Update `setAudioFormat()` to pass `frameSizeBytes` to LC3Service
- Update `initializeLc3Decoder()` to use the configured frame size
- Reinitialize decoder when config changes (handles runtime updates)

#### 1.3 Update Audio Config REST Endpoint

**File**: `cloud/packages/cloud/src/api/hono/client/audio-config.api.ts`

- Accept `frameSizeBytes` values: 20, 40, 60 (not just 20)
- Keep 20 as default for backwards compatibility
- This endpoint remains the control plane for audio config

---

### Phase 2: Mobile Changes

#### 2.1 Add LC3 Bitrate Setting (Local Only)

**Files**:
- `mobile/src/stores/useSettingsStore.ts` - Add new setting key (AsyncStorage only, no cloud sync)
- `mobile/src/components/settings/DeveloperSettings.tsx` - Add UI picker

Setting options:
- 16 kbps (20 bytes) - "Low bandwidth"
- 32 kbps (40 bytes) - "Balanced" (NEW DEFAULT)
- 48 kbps (60 bytes) - "High quality"

#### 2.2 Update SocketComms

**File**: `mobile/src/services/SocketComms.ts`

Update `configureAudioFormat()`:
- Read `lc3_frame_size` from local settings store
- Send configured `frameSizeBytes` in the REST call (instead of hardcoded 20)

```typescript
body: JSON.stringify({
  format: "lc3",
  lc3Config: {
    sampleRate: 16000,
    frameDurationMs: 10,
    frameSizeBytes: getLC3FrameSize(),  // 20, 40, or 60 from settings
  },
}),
```

#### 2.3 Update Native Encoders

**Android** (`mobile/modules/core/android/.../CoreManager.kt`):
- Make `LC3_FRAME_SIZE` configurable via method call
- Expose `setLC3FrameSize(size: Int)` to React Native

**iOS** (`mobile/modules/core/ios/...`):
- Make frame size configurable in PcmConverter
- Expose `setLC3FrameSize(_ size: Int)` to React Native bridge

#### 2.4 Update React Native Bridge

**File**: `mobile/modules/core/src/CoreModule.ts`

- Add `setLC3FrameSize(size: number)` method
- Call native implementations on both platforms
- Call on app start and when setting changes

#### 2.5 Handle Setting Change

When user changes LC3 bitrate in Developer Settings:
1. Save to local store (AsyncStorage)
2. Update native encoder via `CoreModule.setLC3FrameSize()`
3. If connected, call `configureAudioFormat()` again to update server
4. (Optional) Show toast confirming change

---

## Edge Cases & Race Conditions

### Edge Case 1: Server Restart Mid-Session

**Scenario**:
1. User connects, client sends LC3 config (32kbps) via REST
2. User streams audio for 5 minutes
3. Server restarts/redeploys
4. Client reconnects

**Behavior**:
- Mobile reconnects, receives new CONNECTION_ACK
- Mobile calls `configureAudioFormat()` again (fire-and-forget)
- Server gets new config via REST, reinitializes decoder
- Brief moment of potential mismatch, then stabilizes

**Acceptable** - LC3 decoder stabilizes quickly after reinitialization.

---

### Edge Case 2: Audio Arrives Before Config (Race Condition)

**Scenario**:
1. Client connects, gets CONNECTION_ACK
2. Client starts streaming audio (40-byte frames)
3. REST config call still in-flight
4. Server tries to decode with default 20-byte decoder

**What happens**:
- Brief garbage audio (100-200ms)
- REST call completes, server reinitializes decoder with correct frame size
- Audio stabilizes

**Decision**: Acceptable. Not worth the complexity to fix. LC3 decoder reinit handles it.

---

### Edge Case 3: Mixed Client Versions

**Scenario**:
- Old client (v1.x): Sends REST config with 20-byte frames
- New client (v2.x): Sends REST config with 40-byte frames

**Server behavior**:
- Always uses whatever the last REST call specified
- Default is 20-byte if no config received yet
- Each client configures its own session independently

**No issues** - fully backward compatible.

---

### Edge Case 4: Setting Changed Mid-Session

**Scenario**:
1. User is streaming at 32kbps
2. User opens Developer Settings, changes to 48kbps

**Behavior**:
1. Save new value to local store (AsyncStorage)
2. Update native encoder to new frame size
3. Call `configureAudioFormat()` to tell server
4. Server reinitializes decoder with new frame size
5. Audio continues with new quality

**No reconnect needed** - this is the foundation for future adaptive bitrate.

---

### Edge Case 5: New User (First Time)

**Scenario**: Fresh install, never set LC3 preference

**Behavior**:
- App uses default: 40-byte (32kbps) - the new default
- Native encoder initialized with 40 bytes
- REST config sends `frameSizeBytes: 40`
- Server configures decoder accordingly

---

### Edge Case 6: App Killed and Restarted

**Scenario**:
1. User sets 48kbps, uses app
2. App is killed
3. App restarts

**Behavior**:
- Local setting persists in AsyncStorage
- On app start, read setting, configure native encoder
- On connect, send config via REST
- Server matches client

**No issues** - local persistence handles it.

---

## Rollout Strategy

### Phase 1: Backend Preparation (Deploy First)
1. Deploy cloud changes that ACCEPT 20/40/60 byte frames
2. Existing clients continue working (all send 20)
3. Monitor for any issues

### Phase 2: Mobile Beta
1. Release mobile update to beta testers
2. Default still 20 bytes, but 32/48 available in dev settings
3. Gather transcription quality feedback

### Phase 3: Default Flip
1. Change mobile default to 32 bytes
2. Release to all users
3. Monitor bandwidth/battery metrics

### Phase 4: Cleanup
1. Consider removing 16kbps option if unused
2. Potentially make 48kbps the default if 32 proves insufficient

---

## Testing Plan

### Unit Tests
- LC3Service decodes 20, 40, 60 byte frames correctly
- AudioManager reinitializes decoder on config change
- Config endpoint validates and accepts valid frame sizes

### Integration Tests
- Full flow: connect → config → stream → transcribe
- Reconnection after server restart preserves config
- Mixed frame sizes from different clients don't interfere

### Manual Testing
- Record same audio sample at 16/32/48 kbps
- Compare transcription accuracy
- Measure battery impact on mobile
- Test on poor cellular (3G, spotty LTE)

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Transcription WER | TBD | -20% or better |
| Bandwidth per minute | 120 KB | 240 KB |
| Battery drain per hour | TBD | <10% increase |
| Config success rate | N/A | >99.9% |

---

## Files to Modify

### Cloud
- `cloud/packages/cloud/src/services/lc3/lc3.service.ts`
  - Remove `readonly` from `frameBytes`
  - Enable constructor param for `frameBytes`
  - Update `createLC3Service()` factory to accept `frameBytes`
- `cloud/packages/cloud/src/services/session/AudioManager.ts`
  - Change default `audioFormat` from `"pcm"` to `"lc3"` (Issue 6)
  - Pass `lc3Config.frameSizeBytes` to `createLC3Service()`
- `cloud/packages/cloud/src/api/hono/client/audio-config.api.ts`
  - Accept `frameSizeBytes` values: 20, 40, 60 (not just 20)

### Mobile (React Native)
- `mobile/src/services/SocketComms.ts` - Read frame size from settings, send in REST call
- `mobile/src/stores/useSettingsStore.ts` - Add `lc3_frame_size` setting (local only, AsyncStorage)
- `mobile/src/components/settings/DeveloperSettings.tsx` - Add UI picker for LC3 quality
- `mobile/modules/core/src/CoreModule.ts` - Add `setLC3FrameSize(size: number)` bridge method

### Mobile (Android Native)
- `mobile/modules/core/android/src/main/java/com/mentra/core/CoreManager.kt`
  - Change `LC3_FRAME_SIZE` from `val` to `var`
  - Add `setLC3FrameSize(size: Int)` method exposed to React Native
  - (Note: JNI already supports frame size param - no changes needed there)

### Mobile (iOS Native)
- `mobile/modules/core/ios/Source/CoreManager.swift`
  - Change `LC3_FRAME_SIZE` to be configurable
  - Add `setLC3FrameSize(_ size: Int)` method exposed to React Native
- `mobile/modules/core/ios/Packages/CoreObjC/PcmConverter.h`
  - Add `encode:frameSize:` method signature
  - Add `setOutputFrameSize:` method signature (alternative approach)
- `mobile/modules/core/ios/Packages/CoreObjC/PcmConverter.m`
  - Change `outputByteCount` from `const` to instance variable
  - Implement `encode:frameSize:` or `setOutputFrameSize:`
  - Update `encode:` to use configurable frame size

---

## Design Decisions

### 1. Persist LC3 Config to Cloud Database? **NO - Local Only**

Keep it simple:
- Store in AsyncStorage on mobile (local only)
- No cloud sync needed
- Client always tells server what it's using via REST endpoint

**Rationale**: The client is the source of truth for what encoder settings it's using. Server just needs to be told so it can match. No need to persist on server side.

---

### 2. Add LC3 Config to CONNECTION_INIT? **NO - Keep Using REST Endpoint**

The existing REST endpoint (`/api/client/audio/configure`) is the right approach:
- Already exists, just needs to accept more frame sizes
- Supports runtime changes (foundation for future adaptive bitrate)
- Fire-and-forget is fine - server reinitializes decoder on config change
- Brief race condition at session start is acceptable (LC3 stabilizes quickly)

**Why not CONNECTION_INIT**:
- Would only handle initial config, not runtime changes
- We want to support mid-session quality changes for adaptive bitrate later
- REST endpoint is the single control plane for audio config

---

### 3. Battery Impact? **Not a concern**

We're upgrading FROM raw PCM (256 kbps) TO LC3 at 32 kbps. Still 8x bandwidth reduction. The 2x increase from 16→32 kbps is negligible.

---

### 4. Adaptive Bitrate? **Not now, but forward-compatible**

The REST endpoint approach supports runtime changes, which is the foundation for future adaptive bitrate based on network conditions. For now, user picks a setting manually.

---

## Issues Found During Review

### Issue 1: iOS Encoder Has Hardcoded Output Size

**File**: `mobile/modules/core/ios/Packages/CoreObjC/PcmConverter.m`

```objc
static const uint16_t outputByteCount = 20;  // Line 41 - HARDCODED
```

The iOS encoder always outputs 20-byte frames regardless of what we want. This needs to be made configurable.

**Fix**: Add a `setOutputFrameSize:` method or pass frame size to `encode:` method.

---

### Issue 2: iOS Encoder `encode:` Method Has No Frame Size Parameter

**File**: `mobile/modules/core/ios/Packages/CoreObjC/PcmConverter.m`

```objc
- (NSMutableData *)encode:(NSData *)pcmdata {
    // Uses hardcoded outputByteCount = 20
}
```

Unlike the decoder which accepts `frameSize:`, the encoder has no parameter.

**Fix**: Add `encode:frameSize:` method similar to `decode:frameSize:`.

---

### Issue 3: Android JNI Already Supports Frame Size (Good!)

**File**: `mobile/modules/core/android/lc3Lib/src/main/java/com/mentra/lc3Lib/Lc3Cpp.java`

```java
public static native byte[] encodeLC3(long encoderPtr, byte[] pcmData, int frameSize);
```

Android already has the parameterized version. The convenience overload defaults to 20.

**No change needed** - just need to pass the configurable value instead of `LC3_FRAME_SIZE` constant.

---

### Issue 4: MentraLive Uses Different Frame Size (40 bytes)

**File**: `mobile/modules/core/android/src/main/java/com/mentra/core/sgcs/MentraLive.java`

```java
private static final int LC3_FRAME_SIZE = 40;  // Line 123
```

MentraLive glasses use 40-byte frames for audio FROM glasses. This is separate from phone-to-cloud streaming.

**Clarification needed**: Is this intentional? Glasses → phone uses 40-byte, but phone → cloud uses 20-byte currently. This is confusing but may be correct if glasses have more bandwidth over BLE than we thought.

**No change needed for this plan** - this is glasses-to-phone, not phone-to-cloud.

---

### Issue 5: Cloud LC3Service `frameBytes` Is Read-Only

**File**: `cloud/packages/cloud/src/services/lc3/lc3.service.ts`

```typescript
private readonly frameBytes = 20;
```

The `readonly` modifier prevents changing this after construction. The commented-out constructor code wouldn't work as-is.

**Fix**: Remove `readonly` or set it in constructor before the property becomes frozen.

---

### Issue 6: Default Should Be LC3 with 20 Bytes, Not PCM

**File**: `cloud/packages/cloud/src/services/session/AudioManager.ts`

```typescript
private audioFormat: AudioFormat = "pcm";  // Line 74
```

Current clients send LC3, but server defaults to PCM. If REST call fails or races, server tries to decode LC3 as PCM = garbage.

**Fix**: Change default to `"lc3"` since all current clients send LC3.

---

### Issue 7: Plan Missing - When to Call `setLC3FrameSize()` on Native Side

The plan says "call on app start and when setting changes" but doesn't specify the exact timing.

**Clarification**:
1. On app launch, read setting from AsyncStorage
2. Call `CoreModule.setLC3FrameSize()` BEFORE any audio recording starts
3. When setting changes, update immediately (encoder will use new size for next frame)

---

### Issue 8: Race Between Native Encoder and REST Config

**Scenario**:
1. User changes setting to 48kbps
2. Native encoder switches to 60-byte frames immediately
3. REST call to server is still in-flight
4. Server receives 60-byte frames but decoder still expects 40-byte

**Mitigation**: This is similar to Edge Case 4. Server reinit handles it. Brief glitch, then stabilizes. Acceptable.

---

## Updated Files to Modify

### iOS (Additional Work Found)

The iOS encoder needs more work than originally planned:

- `mobile/modules/core/ios/Packages/CoreObjC/PcmConverter.h` - Add `setOutputFrameSize:` or `encode:frameSize:`
- `mobile/modules/core/ios/Packages/CoreObjC/PcmConverter.m` - Implement configurable output frame size
