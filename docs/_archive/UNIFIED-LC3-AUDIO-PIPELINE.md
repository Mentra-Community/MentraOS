# Unified LC3 Audio Pipeline

## Overview

This document outlines the plan to normalize all audio transmission to a single LC3 configuration, reducing network bandwidth by ~16x while simplifying cloud-side audio processing.

**Goal:** All audio sent from mobile to cloud uses one canonical LC3 format, regardless of source (phone mic, glasses mic, different glasses models).

**Key Benefits:**

- 16x reduction in bandwidth (2560 bytes PCM → 160 bytes LC3 per 80ms chunk)
- Simplified cloud architecture (one decoder, no format branching)
- Transport-agnostic (works for UDP, WebSocket, LiveKit data channel)
- Easy future migration to Opus or other codecs
- No race conditions between config and packets during mic switching

**Trade-offs:**

- 10-30ms extra latency from re-encoding on mobile
- Some CPU usage on phone (negligible on modern devices)

---

## The Problem

Currently we have multiple audio sources with different formats:

- **Phone mic**: Sends raw PCM (2560 bytes per ~80ms chunk)
- **Even G1 glasses**: Sends LC3 with one frame size
- **Mentra Live glasses**: Sends LC3 with different frame size
- **Future glasses**: May have yet another LC3 config

The cloud needs to handle all these formats, creating complexity:

- Multiple decoder configurations
- Race conditions when switching mics mid-session
- State management per-session for format tracking

---

## The Solution: Normalize on Mobile

**"Every mic switch is a new audio stream."** — but all streams use the same format.

Instead of pushing complexity to the cloud, we normalize everything on the mobile device:

```
Phone Mic (PCM) ──────────────► LC3 Encoder ──► Canonical LC3 ──► Cloud
                                    ▲
Glasses (LC3 Config A) ──► Decode ──┘
                                    ▲
Glasses (LC3 Config B) ──► Decode ──┘
```

Cloud receives ONE format. ONE decoder. ZERO branching.

---

## Canonical LC3 Configuration

All audio sent to cloud uses this exact configuration:

| Parameter         | Value               | Notes            |
| ----------------- | ------------------- | ---------------- |
| Sample Rate       | 16,000 Hz           | Speech standard  |
| Frame Duration    | 10ms (10,000 µs)    | Low latency      |
| Frame Size        | 20 bytes            | ~16 kbps bitrate |
| PCM Format        | S16 (16-bit signed) | Standard         |
| Samples per Frame | 160                 | 16kHz × 10ms     |

**Why 20 bytes?** Cloud LC3Service already uses 20-byte frames. Matches existing implementation.

---

## Current State Analysis

### Android Core

**Files:**

- `mobile/modules/core/android/src/main/java/com/mentra/core/CoreManager.kt` - Main audio routing
- `mobile/modules/core/android/lc3Lib/` - LC3 encoder/decoder library
- `mobile/modules/core/android/src/main/java/com/mentra/core/sgcs/G1.java` - Even G1 glasses handler
- `mobile/modules/core/android/src/main/java/com/mentra/core/sgcs/MentraLive.java` - Mentra Live glasses handler

**Current Flow:**

```
Phone Mic → PhoneMic.kt → CoreManager.handlePcm() → Bridge.sendMicData(PCM)
G1 Glasses → G1.java (internal LC3 decode) → CoreManager.handlePcm() → Bridge.sendMicData(PCM)
MentraLive → MentraLive.java (internal LC3 decode) → CoreManager.handlePcm() → Bridge.sendMicData(PCM)
```

**Target Flow (after Phase 0 + Phase 1):**

```
Phone Mic → PhoneMic.kt → CoreManager.handlePcm() → LC3 encode → Bridge.sendMicData(LC3)
G1 Glasses → G1.java → CoreManager.handleGlassesMicData(lc3, 20) → decode → handlePcm() → LC3 encode → Bridge.sendMicData(LC3)
MentraLive → MentraLive.java → CoreManager.handleGlassesMicData(lc3, 40) → decode → handlePcm() → LC3 encode → Bridge.sendMicData(LC3)
```

**Important Note (Android vs iOS difference - will be standardized in Phase 0):**

- **Android (current):** G1.java and MentraLive.java decode LC3 to PCM internally, then call `handlePcm(pcmData)`. The `handleGlassesMicData()` function has a TODO and is NOT being called.
- **iOS (current):** G1.swift and MentraLive.swift call `handleGlassesMicData(lc3Data, frameSize)` with raw LC3 data. CoreManager decodes LC3 internally.

**Target:** Standardize on iOS approach - glasses forward raw LC3 to CoreManager, which handles all decoding/encoding.

**Flags:**

- `bypassAudioEncoding` - DEAD CODE, will be removed and replaced with `audioOutputFormat`
- `shouldSendPcmData` - Whether to send audio to cloud
- `shouldSendTranscript` - Whether to send to local transcriber
- `bypassVad` - Defaults to `true`, VAD logic is bypassed but code exists for future use

**VAD Buffer Notes:**

- Android: `emptyVadBuffer()` and `addToVadBuffer()` exist but are NEVER CALLED (dead code)
- iOS: VAD buffer IS used when `bypassVad = false`, stores PCM chunks
- VAD requires PCM to analyze speech, so encoding must happen AFTER VAD processing

**LC3 Library Status:**

- ✅ Encoder exists (`Lc3Cpp.encodeLC3()`)
- ✅ Decoder exists (`Lc3Cpp.decodeLC3()`)
- ✅ Default config: 16kHz, 10ms, 20-byte frames (matches canonical!)
- ❌ Not currently used in audio pipeline

### iOS Core

**Files:**

- `mobile/modules/core/ios/Source/CoreManager.swift` - Main audio routing
- `mobile/modules/core/ios/Packages/CoreObjC/PcmConverter.m` - LC3 codec wrapper
- `mobile/modules/core/ios/Packages/CoreObjC/PcmConverter.h` - Header

**Current Flow:**

```
Phone Mic → PhoneMic.swift → CoreManager.handlePcm() → Bridge.sendMicData(PCM)
Glasses → handleGlassesMicData() → decode LC3 → VAD processing → send PCM
```

**Flags:**

- `bypassVad` - Defaults to `true`, VAD logic is bypassed but code exists for future use
- `bypassAudioEncoding` - DEAD CODE, will be removed and replaced with `audioOutputFormat`
- `shouldSendPcmData` - Whether to send audio to cloud
- `shouldSendTranscript` - Whether to send to local transcriber

**VAD Buffer Notes:**

- iOS VAD buffer IS actively used when `bypassVad = false`
- Multiple `Bridge.sendMicData()` calls scattered through VAD logic need to be consolidated
- VAD requires PCM, so buffer stores PCM and encoding happens at send time

**LC3 Library Status:**

- ✅ Decoder exists in PcmConverter (`decode:frameSize:`)
- ✅ Encoder declared in header (`encode:`)
- ❌ Encoder NOT implemented in .m file (just declared)
- ✅ Config: 16kHz, 10ms, 20-byte frames (matches canonical!)

### React Native

**Files:**

- `mobile/src/bridge/MantleBridge.tsx` - Receives audio from native
- `mobile/src/services/SocketComms.ts` - WebSocket connection to cloud
- `mobile/src/services/UdpAudioService.ts` - UDP audio transport

**Current Flow:**

```
Native mic_data event → MantleBridge → UdpAudioService/SocketComms → Cloud
```

**What's Needed:**

- Call REST endpoint `/api/client/audio/configure` on connection
- Tell cloud we're sending LC3 format

### Cloud

**Files:**

- `cloud/packages/cloud/src/services/session/AudioManager.ts` - Audio processing
- `cloud/packages/cloud/src/services/lc3/lc3.service.ts` - LC3 decoder (WASM)
- `cloud/packages/cloud/src/api/hono/client/` - Client API routes

**Current State:**

- ✅ Full LC3 decoder exists (lc3.service.ts)
- ✅ Uses canonical config (16kHz, 10ms, 20-byte frames)
- ❌ Disabled by `IS_LC3 = false` constant
- ❌ No endpoint to configure audio format

---

## Target Architecture

### Audio Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              MOBILE DEVICE                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────┐                                                        │
│  │  Phone Mic  │────► PCM 16kHz ────┐                                   │
│  └─────────────┘                    │                                   │
│                                     ▼                                   │
│  ┌─────────────┐            ┌──────────────┐            ┌─────────────┐│
│  │ Glasses Mic │──► LC3 ──► │ LC3 Decoder  │──► PCM ──► │ LC3 Encoder ││
│  │ (Config A)  │            └──────────────┘            │ (Canonical) ││
│  └─────────────┘                                        │ 16kHz/10ms/ ││
│                                     ▲                   │ 20 bytes    ││
│  ┌─────────────┐            ┌──────────────┐            └──────┬──────┘│
│  │ Glasses Mic │──► LC3 ──► │ LC3 Decoder  │──► PCM ──────────►│       │
│  │ (Config B)  │            └──────────────┘                   │       │
│  └─────────────┘                                               ▼       │
│                                                        ┌──────────────┐│
│                                                        │    Bridge    ││
│                                                        │ sendMicData  ││
│                                                        └───────┬──────┘│
└────────────────────────────────────────────────────────────────┼───────┘
                                                                 │
                                                    LC3 (Canonical)
                                                                 │
                              ┌──────────────────────────────────┼───────┐
                              │            REACT NATIVE          │       │
                              ├──────────────────────────────────┼───────┤
                              │                                  ▼       │
                              │  ┌─────────────────────────────────────┐ │
                              │  │           MantleBridge              │ │
                              │  │  (receives mic_data from native)    │ │
                              │  └──────────────────┬──────────────────┘ │
                              │                     │                    │
                              │         ┌───────────┴───────────┐        │
                              │         ▼                       ▼        │
                              │  ┌─────────────┐         ┌─────────────┐ │
                              │  │    UDP      │         │  WebSocket  │ │
                              │  │  Transport  │         │  Transport  │ │
                              │  └──────┬──────┘         └──────┬──────┘ │
                              └─────────┼───────────────────────┼────────┘
                                        │                       │
                                        └───────────┬───────────┘
                                                    │
                                         LC3 (Canonical) over network
                                                    │
                              ┌─────────────────────┼────────────────────┐
                              │                 CLOUD                    │
                              ├─────────────────────┼────────────────────┤
                              │                     ▼                    │
                              │  ┌───────────────────────────────────┐   │
                              │  │          AudioManager             │   │
                              │  │   (processAudioData method)       │   │
                              │  └──────────────────┬────────────────┘   │
                              │                     │                    │
                              │                     ▼                    │
                              │  ┌───────────────────────────────────┐   │
                              │  │          LC3 Decoder              │   │
                              │  │   (if audioFormat == 'lc3')       │   │
                              │  └──────────────────┬────────────────┘   │
                              │                     │                    │
                              │                 PCM 16kHz                │
                              │                     │                    │
                              │                     ▼                    │
                              │  ┌───────────────────────────────────┐   │
                              │  │         Transcription             │   │
                              │  │     (Deepgram, Gladia, etc.)      │   │
                              │  └───────────────────────────────────┘   │
                              └──────────────────────────────────────────┘
```

### Mic Switching Scenario

```
Time ──────────────────────────────────────────────────────────────────►

Phone Mic ════════════╗
                      ║ (Switch to glasses)
                      ╠═══════════════════════════════════════════════►
                      ║
                      ▼
                 ┌─────────┐
                 │  Core   │ Tears down phone mic encoder
                 │         │ Sets up glasses decoder + encoder
                 └─────────┘
                      │
                      ▼
             Canonical LC3 continues
             (Cloud sees no difference)
```

---

## Files to Modify (Summary)

### Mobile (Phase 0 - Standardize glasses audio flow)

| File                                                                             | Changes                                                                             |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `mobile/modules/core/android/src/main/java/com/mentra/core/sgcs/G1.java`         | Remove internal LC3 decode, call `handleGlassesMicData(lc3Data, frameSize)` instead |
| `mobile/modules/core/android/src/main/java/com/mentra/core/sgcs/MentraLive.java` | Remove internal LC3 decode, call `handleGlassesMicData(lc3Data, frameSize)` instead |

### Mobile (Phase 1 - Add LC3 encoding)

| File                                                                       | Changes                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mobile/modules/core/android/src/main/java/com/mentra/core/CoreManager.kt` | Add AudioOutputFormat enum, LC3 encoder/decoder, remove `bypassAudioEncoding`, add `sendMicData()` helper, update `handlePcm()`, `emptyVadBuffer()`, implement `handleGlassesMicData()`, cleanup                        |
| `mobile/modules/core/ios/Packages/CoreObjC/PcmConverter.m`                 | Add encoder instance vars, setupEncoder(), implement encode() method, update dealloc                                                                                                                                    |
| `mobile/modules/core/ios/Source/CoreManager.swift`                         | Add AudioOutputFormat enum, lc3Converter, remove `bypassAudioEncoding`, add `sendMicData()` helper, update `handlePcm()`, `emptyVadBuffer()`, simplify `handleGlassesMicData()`, replace all `Bridge.sendMicData` calls |

### Cloud (Phase 2)

| File                                                           | Changes                                                        |
| -------------------------------------------------------------- | -------------------------------------------------------------- |
| `cloud/packages/cloud/src/api/hono/client/audio-config.api.ts` | **NEW FILE** - POST endpoint for audio format config           |
| `cloud/packages/cloud/src/api/hono/client/index.ts`            | Export audioConfigApi                                          |
| `cloud/packages/cloud/src/api/hono/index.ts`                   | Export audioConfigApi from client                              |
| `cloud/packages/cloud/src/hono-app.ts`                         | Import and register route                                      |
| `cloud/packages/cloud/src/services/session/AudioManager.ts`    | Add format config, setAudioFormat(), update processAudioData() |

### React Native (Phase 3)

| File                                 | Changes                                                     |
| ------------------------------------ | ----------------------------------------------------------- |
| `mobile/src/services/SocketComms.ts` | Add configureAudioFormat(), call in handle_connection_ack() |

---

## Implementation Tasks

### Phase 0: Standardize Android Glasses Audio Flow

**Goal:** Make Android match iOS - glasses classes forward raw LC3 to CoreManager instead of decoding internally.

#### G1.java

Find the audio processing code that decodes LC3 and calls `handlePcm()`. Change it to forward raw LC3:

**Before (around line 525):**

```java
// Decodes LC3 internally
byte[] pcmData = ... // LC3 decode logic
CoreManager.getInstance().handlePcm(pcmData);
```

**After:**

```java
// Forward raw LC3 to CoreManager (matches iOS behavior)
// G1 uses 20-byte LC3 frames
CoreManager.getInstance().handleGlassesMicData(lc3Data, 20);
```

#### MentraLive.java

Find the audio processing code that decodes LC3 and calls `handlePcm()`. Change it to forward raw LC3:

**Before (around line 5359):**

```java
// Decodes LC3 internally
byte[] pcmData = ... // LC3 decode logic
CoreManager.getInstance().handlePcm(pcmData);
```

**After:**

```java
// Forward raw LC3 to CoreManager (matches iOS behavior)
// MentraLive uses 40-byte LC3 frames
CoreManager.getInstance().handleGlassesMicData(lc3Data, 40);
```

#### Update handleGlassesMicData signature

The current Android signature is:

```kotlin
fun handleGlassesMicData(rawLC3Data: ByteArray)
```

Update to include frameSize parameter (matching iOS):

```kotlin
fun handleGlassesMicData(rawLC3Data: ByteArray, frameSize: Int = 20)
```

---

### Phase 1: Mobile Core - Add LC3 Encoding

#### Android (CoreManager.kt)

1. **Add LC3 import and AudioOutputFormat enum**

   ```kotlin
   import com.mentra.lc3Lib.Lc3Cpp

   // Audio output format enum
   enum class AudioOutputFormat { LC3, PCM }
   ```

2. **Add LC3 encoder/decoder pointers and format config**

   ```kotlin
   // LC3 Audio Encoding
   // Canonical LC3 config: 16kHz sample rate, 10ms frame duration, 20-byte frame size
   private var lc3EncoderPtr: Long = 0
   private var lc3DecoderPtr: Long = 0
   private val LC3_FRAME_SIZE = 20 // bytes per LC3 frame (canonical config)

   // Audio output format - defaults to LC3 for bandwidth savings
   private var audioOutputFormat: AudioOutputFormat = AudioOutputFormat.LC3
   ```

3. **Remove dead `bypassAudioEncoding` flag** and add format setter:

   ```kotlin
   // DELETE: private var bypassAudioEncoding = false
   // DELETE: fun updateBypassAudioEncoding(enabled: Boolean) { ... }

   // ADD: Format setter for future configuration
   fun updateAudioOutputFormat(format: AudioOutputFormat) {
       audioOutputFormat = format
       Bridge.log("Audio output format set to: $format")
   }
   ```

4. **Initialize in init block**

   ```kotlin
   // Initialize LC3 encoder/decoder for unified audio encoding
   try {
       Lc3Cpp.init()
       lc3EncoderPtr = Lc3Cpp.initEncoder()
       lc3DecoderPtr = Lc3Cpp.initDecoder()
       Bridge.log("LC3 encoder/decoder initialized successfully")
   } catch (e: Exception) {
       Bridge.log("Failed to initialize LC3 encoder/decoder: ${e.message}")
       lc3EncoderPtr = 0
       lc3DecoderPtr = 0
   }
   ```

5. **Create single send path - `sendMicData()` helper**

   This centralizes all encoding logic. VAD buffer and all other code paths use this:

   ```kotlin
   /**
    * Send audio data to cloud via Bridge.
    * Encodes to LC3 if audioOutputFormat is LC3, otherwise sends raw PCM.
    * All audio destined for cloud should go through this function.
    */
   private fun sendMicData(pcmData: ByteArray) {
       when (audioOutputFormat) {
           AudioOutputFormat.LC3 -> {
               if (lc3EncoderPtr == 0L) {
                   Bridge.log("MAN: ERROR - LC3 encoder not initialized but format is LC3")
                   return
               }
               val lc3Data = Lc3Cpp.encodeLC3(lc3EncoderPtr, pcmData, LC3_FRAME_SIZE)
               if (lc3Data == null || lc3Data.isEmpty()) {
                   Bridge.log("MAN: ERROR - LC3 encoding returned empty data")
                   return
               }
               Bridge.sendMicData(lc3Data)
           }
           AudioOutputFormat.PCM -> {
               Bridge.sendMicData(pcmData)
           }
       }
   }
   ```

6. **Update emptyVadBuffer() to use new send path**

   ```kotlin
   private fun emptyVadBuffer() {
       while (vadBuffer.isNotEmpty()) {
           val chunk = vadBuffer.removeAt(0)
           sendMicData(chunk)  // Uses our encoder, not Bridge directly
       }
   }
   ```

7. **Update handlePcm() to use new send path**

   ```kotlin
   fun handlePcm(pcmData: ByteArray) {
       // Send audio to cloud if needed (encoding handled by sendMicData)
       if (shouldSendPcmData) {
           sendMicData(pcmData)
       }

       // Send PCM to local transcriber (always needs raw PCM)
       if (shouldSendTranscript) {
           transcriber?.acceptAudio(pcmData)
       }
   }
   ```

8. **Implement handleGlassesMicData()**

   After Phase 0 standardization, all glasses audio flows through this function. Decode the glasses LC3, then pass to handlePcm() for canonical LC3 encoding:

   ```kotlin
   fun handleGlassesMicData(rawLC3Data: ByteArray, frameSize: Int = LC3_FRAME_SIZE) {
       if (lc3DecoderPtr == 0L) {
           Bridge.log("MAN: LC3 decoder not initialized, cannot process glasses audio")
           return
       }

       try {
           // Decode glasses LC3 to PCM (glasses may use different LC3 configs)
           val pcmData = Lc3Cpp.decodeLC3(lc3DecoderPtr, rawLC3Data, frameSize)
           if (pcmData != null && pcmData.isNotEmpty()) {
               // Re-encode to canonical LC3 via handlePcm
               handlePcm(pcmData)
           } else {
               Bridge.log("MAN: LC3 decode returned empty data")
           }
       } catch (e: Exception) {
           Bridge.log("MAN: Failed to decode glasses LC3: ${e.message}")
       }
   }
   ```

9. **Add cleanup**

   ```kotlin
   fun cleanup() {
       // ... existing cleanup ...

       if (lc3EncoderPtr != 0L) {
           Lc3Cpp.freeEncoder(lc3EncoderPtr)
           lc3EncoderPtr = 0
       }
       if (lc3DecoderPtr != 0L) {
           Lc3Cpp.freeDecoder(lc3DecoderPtr)
           lc3DecoderPtr = 0
       }
   }
   ```

#### iOS (PcmConverter.m)

1. **Add encoder instance variables**

   ```objc
   // Instance variables for persistent encoder
   lc3_encoder_t _lc3_encoder;
   void* _encMem;
   unsigned char* _encOutBuf;
   BOOL _encoderInitialized;
   unsigned _encodeSize;
   ```

2. **Add setupEncoder method**

   ```objc
   - (void)setupEncoder {
       if (_encoderInitialized) return;

       _encodeSize = lc3_encoder_size(dtUs, srHz);
       _encMem = malloc(_encodeSize);
       if (!_encMem) return;

       _lc3_encoder = lc3_setup_encoder(dtUs, srHz, 0, _encMem);
       _encOutBuf = malloc(outputByteCount);
       if (!_encOutBuf) {
           free(_encMem);
           _encMem = NULL;
           return;
       }

       _encoderInitialized = YES;
   }
   ```

3. **Implement encode: method**

   ```objc
   - (NSMutableData *)encode:(NSData *)pcmdata {
       if (!pcmdata || pcmdata.length == 0) return [[NSMutableData alloc] init];

       [self setupEncoder];
       if (!_encoderInitialized) return [[NSMutableData alloc] init];

       NSMutableData *lc3Data = [[NSMutableData alloc] init];
       const int16_t *pcmSamples = (const int16_t *)pcmdata.bytes;
       int totalBytes = (int)pcmdata.length;
       int bytesRead = 0;

       while (bytesRead < totalBytes) {
           if (totalBytes - bytesRead < _bytesOfFrames) break;

           const int16_t *currentSamples = pcmSamples + (bytesRead / 2);
           int result = lc3_encode(_lc3_encoder, LC3_PCM_FORMAT_S16,
                                   currentSamples, 1, outputByteCount, _encOutBuf);

           if (result == 0) {
               [lc3Data appendBytes:_encOutBuf length:outputByteCount];
           }
           bytesRead += _bytesOfFrames;
       }

       return lc3Data;
   }
   ```

4. **Update dealloc to free encoder**

#### iOS (CoreManager.swift)

1. **Add AudioOutputFormat enum and LC3 converter property**

   ```swift
   // Audio output format enum
   enum AudioOutputFormat { case lc3, pcm }

   private var lc3Converter: PcmConverter?
   private let LC3_FRAME_SIZE = 20

   // Audio output format - defaults to LC3 for bandwidth savings
   private var audioOutputFormat: AudioOutputFormat = .lc3
   ```

2. **Remove dead `bypassAudioEncoding` flag** and add format setter:

   ```swift
   // DELETE: private var bypassAudioEncoding: Bool = false
   // DELETE: func updateBypassAudioEncoding(_ enabled: Bool) { ... }

   // ADD: Format setter for future configuration
   func updateAudioOutputFormat(_ format: AudioOutputFormat) {
       audioOutputFormat = format
       Bridge.log("Audio output format set to: \(format)")
   }
   ```

3. **Initialize in init()**

   ```swift
   lc3Converter = PcmConverter()
   Bridge.log("LC3 encoder/decoder initialized successfully")
   ```

4. **Create single send path - `sendMicData()` helper**

   This centralizes all encoding logic. VAD buffer and all other code paths use this:

   ```swift
   /**
    * Send audio data to cloud via Bridge.
    * Encodes to LC3 if audioOutputFormat is .lc3, otherwise sends raw PCM.
    * All audio destined for cloud should go through this function.
    */
   private func sendMicData(_ pcmData: Data) {
       switch audioOutputFormat {
       case .lc3:
           guard let lc3Converter = lc3Converter else {
               Bridge.log("MAN: ERROR - LC3 converter not initialized but format is LC3")
               return
           }
           let lc3Data = lc3Converter.encode(pcmData) as Data
           guard lc3Data.count > 0 else {
               Bridge.log("MAN: ERROR - LC3 encoding returned empty data")
               return
           }
           Bridge.sendMicData(lc3Data)
       case .pcm:
           Bridge.sendMicData(pcmData)
       }
   }
   ```

5. **Update emptyVadBuffer() to use new send path**

   ```swift
   private func emptyVadBuffer() {
       while !vadBuffer.isEmpty {
           let chunk = vadBuffer.removeFirst()
           sendMicData(chunk)  // Uses our encoder, not Bridge directly
       }
   }
   ```

6. **Simplify handlePcm()** - Remove scattered VAD logic, use single send path:

   ```swift
   func handlePcm(_ pcmData: Data) {
       // Send audio to cloud if needed (encoding handled by sendMicData)
       if shouldSendPcmData {
           if bypassVad {
               sendMicData(pcmData)
           } else {
               // VAD path - check speech, buffer or send
               // (VAD logic stays the same, but uses sendMicData instead of Bridge.sendMicData)
               // ... existing VAD logic but replace Bridge.sendMicData with sendMicData ...
           }
       }

       // Send PCM to local transcriber (always needs raw PCM)
       if shouldSendTranscript {
           transcriber?.acceptAudio(pcm16le: pcmData)
       }
   }
   ```

7. **Simplify handleGlassesMicData()** - Remove VAD logic duplication, just decode and forward:

   ```swift
   func handleGlassesMicData(_ lc3Data: Data, _ frameSize: Int = 20) {
       guard let lc3Converter = lc3Converter else {
           Bridge.log("MAN: LC3 converter not initialized")
           return
       }

       guard lc3Data.count > 2 else {
           Bridge.log("MAN: Received invalid LC3 data size: \(lc3Data.count)")
           return
       }

       let pcmData = lc3Converter.decode(lc3Data, frameSize: frameSize) as Data
       guard pcmData.count > 0 else {
           Bridge.log("MAN: Failed to decode glasses LC3 audio")
           return
       }

       // Forward to handlePcm which handles VAD and encoding
       handlePcm(pcmData)
   }
   ```

8. **Update all remaining `Bridge.sendMicData()` calls** in VAD logic to use `sendMicData()`:
   - Search for all `Bridge.sendMicData(` in CoreManager.swift
   - Replace with `sendMicData(` (our private helper)
   - This ensures ALL audio goes through the encoder

---

### Phase 2: Cloud - REST Audio Configure Endpoint

#### Create audio-config.api.ts

Create new file: `cloud/packages/cloud/src/api/hono/client/audio-config.api.ts`

```typescript
/**
 * POST /api/client/audio/configure
 *
 * Configure the audio format for this session.
 * Must be called after WebSocket connection is established.
 *
 * Request body:
 * {
 *   "format": "lc3" | "pcm",
 *   "lc3Config"?: {
 *     "sampleRate": 16000,
 *     "frameDurationMs": 10,
 *     "frameSizeBytes": 20
 *   }
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "format": "lc3",
 *   "message": "Audio format configured successfully"
 * }
 */
```

#### Update client/index.ts

Add export:

```typescript
export {default as audioConfigApi} from "./audio-config.api"
```

#### Update api/hono/index.ts

Add to exports:

```typescript
export {
  audioConfigApi, // ADD THIS
  calendarApi,
  // ... rest of exports
} from "./client"
```

#### Update hono-app.ts

1. Add import:

   ```typescript
   import {
     audioConfigApi, // ADD THIS
     // ... rest of imports
   } from "./api/hono"
   ```

2. Add route registration:
   ```typescript
   // Client API Routes (Hono native)
   app.route("/api/client/audio/configure", audioConfigApi)
   ```

#### Update AudioManager.ts

1. Add audio format configuration properties:

   ```typescript
   private audioFormat: 'pcm' | 'lc3' = 'pcm';  // Default PCM for backwards compat
   private lc3Config?: {
       sampleRate: number;
       frameDurationMs: number;
       frameSizeBytes: number;
   };
   ```

2. Add setAudioFormat() method:

   ```typescript
   setAudioFormat(format: 'pcm' | 'lc3', lc3Config?: {...}): void {
       this.audioFormat = format;
       this.lc3Config = lc3Config;
       if (format === 'lc3') {
           this.initializeLc3Decoder();
       }
   }
   ```

3. Add getAudioFormat() and isLC3() helper methods

4. Modify processAudioData() to decode LC3 when configured:
   ```typescript
   async processAudioData(data: ArrayBuffer): Promise<void> {
       let pcmData = data;
       if (this.isLC3() && this.lc3Service) {
           pcmData = await this.lc3Service.decodeAudioChunk(data);
       }
       // ... rest of processing with pcmData
   }
   ```

---

### Phase 3: React Native - Call Audio Configure

#### Update SocketComms.ts

Add method to call audio configure endpoint on WebSocket connection:

```typescript
private async configureAudioFormat(): Promise<void> {
    const backendUrl = useSettingsStore.getState().getSetting(SETTINGS.backend_url.key);
    const coreToken = useSettingsStore.getState().getSetting(SETTINGS.core_token.key);

    const response = await fetch(`${backendUrl}/api/client/audio/configure`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${coreToken}`,
        },
        body: JSON.stringify({
            format: 'lc3',
            lc3Config: {
                sampleRate: 16000,
                frameDurationMs: 10,
                frameSizeBytes: 20,
            },
        }),
    });

    if (!response.ok) {
        console.error('[SocketComms] Failed to configure audio format');
    }
}
```

Call this in `handle_connection_ack()` after receiving the WebSocket connection acknowledgment.

---

## Data Size Comparison

| Format      | Per 10ms Frame | Per 80ms Chunk (8 frames) | Reduction       |
| ----------- | -------------- | ------------------------- | --------------- |
| PCM 16-bit  | 320 bytes      | 2560 bytes                | baseline        |
| LC3 20-byte | 20 bytes       | 160 bytes                 | **16x smaller** |

**Bandwidth Savings:** 93.75% reduction in audio data size.

---

## Backwards Compatibility

For old clients that don't call `/api/client/audio/configure`:

- Cloud defaults to `audioFormat: 'pcm'`
- Audio passed through without LC3 decoding
- Existing behavior preserved

For new clients:

- Call `/api/client/audio/configure` with LC3 config
- Cloud enables LC3 decoding
- All audio decoded before transcription

---

## Open Questions

1. **LC3 Licensing:** Verify LC3 usage rights for commercial deployment
2. **Error Metrics:** Should we track LC3 encode/decode failures?
3. **Fallback Strategy:** If LC3 encoding fails, should we send PCM or skip the chunk?

---

## References

- [LC3 Codec Specification](https://www.bluetooth.com/specifications/specs/low-complexity-communication-codec-1-0/)
- Existing LC3Service: `cloud/packages/cloud/src/services/lc3/lc3.service.ts`
- Existing AudioManager: `cloud/packages/cloud/src/services/session/AudioManager.ts`
- Android LC3 JNI: `mobile/modules/core/android/lc3Lib/`
- iOS LC3 Library: `mobile/modules/core/ios/Packages/CoreObjC/lc3.c`

---

## Implementation Verification Protocol

**IMPORTANT: After implementing this feature, follow this verification protocol before considering the work complete.**

### ⛔ FORBIDDEN COMMANDS - DO NOT RUN

**NEVER run these commands** - they make thousands of unrelated changes and pollute the diff:

```bash
# DO NOT RUN:
bun lint --fix           # ESLint auto-fix - changes everything
npm run lint -- --fix    # ESLint auto-fix - changes everything
npx prettier --write .   # Prettier - reformats entire codebase
```

Only run `bun lint` (without `--fix`) to CHECK for errors, then fix manually if needed.

### Self-Review Checklist

After completing each phase, perform the following:

1. **Code Review**
   - Review all changed files for bugs, typos, and logic errors
   - Check for missing error handling
   - Verify all imports are correct
   - Ensure no hardcoded values that should be constants
   - Check for memory leaks (especially in native code)
   - Look for race conditions in async code
   - Verify error messages are clear and actionable

2. **Build & Compile Verification**
   - Run `bun lint` on mobile code
   - Run `bun compile` (TypeScript type check) on mobile code
   - Ensure Android builds without errors (`bun android`)
   - Ensure iOS builds without errors (`bun ios`)
   - Run cloud linter (`cd packages/cloud && bun run lint`)
   - Ensure cloud builds without errors (`bun run build`)

3. **Static Analysis**
   - Check for unused imports
   - Check for unused variables
   - Verify all function signatures match their usage
   - Ensure consistent naming conventions

### Iterative Bug Fixing

After initial implementation:

1. Run all build/lint/compile checks
2. Carefully re-read all changed code looking for logic errors
3. Fix any issues found
4. Re-run all checks
5. Repeat until everything passes cleanly

**Do not consider the implementation complete until:**

- All builds pass without errors
- All linters pass without warnings
- TypeScript compiles without errors
- Code has been self-reviewed at least twice
- No obvious bugs or logic errors remain
- All error handling is in place

Only return to the user once everything is verified working correctly. The user will handle manual testing on device.
