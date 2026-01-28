# Phone Mic Audio Quality Fix

Fixed degraded/choppy audio when switching from glasses mic to phone mic over UDP.

## Quick Context

**Problem**: Audio sounded broken when using phone mic instead of glasses mic.
**Root causes**: Three separate issues combining to corrupt LC3 audio stream.
**Status**: FIXED ✅

## Key Context

LC3 is a predictive codec with strict frame boundaries (320 bytes PCM → 20/40/60 bytes LC3). Any misalignment or state corruption causes decoder failure and audio artifacts.

## Problems Found & Fixed

### 1. Partial PCM Frames Dropped at Encoder Input

**File**: `mobile/modules/core/android/src/main/java/com/mentra/core/CoreManager.kt`

Phone mic sends variable-sized PCM chunks that don't align to LC3 frame boundaries (320 bytes = 160 samples @ 16kHz). Encoder silently dropped partial frames → audio data loss.

**Fix**: Buffer partial frames between chunks:

```kotlin
// Prepend remainder from previous chunk
val dataToEncode = if (pcmRemainder != null) pcmRemainder!! + pcmData else pcmData

// Calculate complete frames only
val completeFrameBytes = (dataToEncode.size / LC3_PCM_FRAME_BYTES) * LC3_PCM_FRAME_BYTES

// Save remainder for next chunk
pcmRemainder = if (remainderBytes > 0)
    dataToEncode.copyOfRange(completeFrameBytes, dataToEncode.size)
else null
```

### 2. LC3 Codec Thread Safety

**File**: `mobile/modules/core/android/src/main/java/com/mentra/core/CoreManager.kt`

LC3 encoder/decoder are stateful (predictive coding) and NOT thread-safe. Concurrent calls from phone mic (`AudioRecordingThread`) and glasses mic (BLE callbacks) corrupted codec state.

**Fix**: Synchronized blocks around codec access:

```kotlin
private val lc3EncoderLock = Any()
private val lc3DecoderLock = Any()

synchronized(lc3EncoderLock) {
    val lc3Data = Lc3Cpp.encodeLC3(lc3EncoderPtr, framesToEncode, lc3FrameSize)
}
```

### 3. UDP Packet Splitting at Wrong Boundaries

**File**: `mobile/src/services/UdpManager.ts`

When LC3 audio exceeded 1018 bytes, UDP chunking split at arbitrary byte boundaries → partial LC3 frames sent → cloud decoder failed.

**Example with 60-byte frames (48kbps)**:

- Before: 1440 bytes → 1016 + 424 (partial frames!)
- After: 1440 bytes → 960 + 480 (16 + 8 complete frames)

**Fix**: Align chunk size to LC3 frame boundaries:

```typescript
private getMaxChunkSize(): number {
  const frameSizeBytes = useSettingsStore.getState().getSetting(SETTINGS.lc3_frame_size.key) || 20
  // Calculate how many complete frames fit in max packet size
  const maxFrames = Math.floor(MAX_AUDIO_CHUNK_SIZE_BASE / frameSizeBytes)
  return maxFrames * frameSizeBytes
}
```

## Key Numbers

| Parameter       | Value                                                   |
| --------------- | ------------------------------------------------------- |
| PCM frame size  | 320 bytes (160 samples × 2 bytes)                       |
| LC3 frame sizes | 20 bytes (16kbps), 40 bytes (32kbps), 60 bytes (48kbps) |
| Max UDP payload | 1018 bytes (after 6-byte header)                        |
| Sample rate     | 16kHz                                                   |
| Frame duration  | 10ms                                                    |

## Debug Tools Added

- `bypass_audio_encoding_for_debugging` setting: Switch between LC3 and raw PCM to isolate encoding issues
- Logging every 100th encode: Shows input size, remainder, frame count
- Sample rate verification: Confirms AudioRecord returns requested 16kHz

## Files Changed

| File                                             | Change                                   |
| ------------------------------------------------ | ---------------------------------------- |
| `mobile/modules/core/android/.../CoreManager.kt` | PCM buffering, thread sync, debug bypass |
| `mobile/modules/core/android/.../PhoneMic.kt`    | Sample rate logging                      |
| `mobile/src/services/SocketComms.ts`             | Audio format bypass config               |
| `mobile/src/services/UdpManager.ts`              | LC3 frame-aligned UDP chunking           |

## Status

- [x] Identify root causes
- [x] Fix PCM frame buffering (Android)
- [x] Fix LC3 codec thread safety (Android)
- [x] Fix UDP packet frame alignment (TypeScript)
- [x] Add debug bypass for testing
- [x] Verify audio quality at 48kbps (60-byte frames)
