# Custom GATT Audio Implementation for Mentra Live

## High Level Explanation

**What we're asking for:** Instead of implementing standard Bluetooth audio (HFP/A2DP/LE Audio), we want the glasses to:

1. **Send microphone audio as regular BLE data packets** - Just like sending sensor data or any other information
2. **Use LC3 codec for compression** - But NOT the full LE Audio standard, just the compression algorithm

**Think of it like this:** Instead of using Bluetooth's built-in phone call feature, we're sending audio data the same way you'd send temperature readings from a sensor - as regular data packets through custom GATT characteristics.

**Why this unusual approach?** Standard Bluetooth audio takes over the phone's entire audio system. Our approach lets users get audio data from the glasses without conflicting with any other apps on their phone that also require audio.

## Overview

This document outlines the implementation of custom LC3 GATT audio for Mentra Live smart glasses, providing an alternative to the standard HFP (Hands-Free Profile) audio system.

## Why Custom GATT Audio?

### Current HFP Limitations

The existing HFP implementation has several significant drawbacks:

1. **Audio System Hijacking**: HFP takes control of the entire phone's audio system
2. **Concurrent Audio Conflicts**: Cannot play audio from multiple apps simultaneously
   - Example: Playing music while using MentraOS to play audio (ex: text-to-speech) causes one to stop the other
   - Example: Using the microphone in another app prevents MentraOS from using the microphone
   - Standard Android/iOS behavior prevents multiple audio streams
3. **User Experience Impact**: Forces users to choose between MentraOS audio and other apps

### Custom GATT Audio Benefits

1. **Non-Disruptive**: Android/iOS doesn't recognize custom GATT audio as a system audio device
2. **Concurrent Audio Support**: Users can play music while MentraOS audio plays through glasses. Users can use the microphone in other apps while MentraOS uses the microphone from the glasses.
3. **Flexible Control**: App-level control over audio routing and processing
4. **Better User Experience**: No conflicts with other audio apps

### Custom LC3 GATT vs Standard LE Audio

**Important Distinction**: This implementation uses only the LC3 codec from the LE Audio specification, NOT the full LE Audio standard.

#### Standard LE Audio (NOT what we want)

- Full Bluetooth LE Audio specification implementation
- Uses standardized audio profiles and services
- Phone OS recognizes it as a standard Bluetooth audio device
- **Same problems as HFP**: Hijacks phone's audio system
- Prevents concurrent audio from other apps
- Complex specification with features we don't need (audio sharing, broadcast, etc.)

#### Custom LC3 over GATT (What we want)

- Uses only the LC3 codec (compression algorithm) from LE Audio
- Streams raw LC3 data through custom GATT characteristics
- No standard Bluetooth audio profiles involved
- **Phone OS doesn't recognize it as an audio device**
- Completely bypasses phone's audio system
- Allows concurrent audio from other apps

#### Technical Flow

1. **App Audio** → LC3 Encode → Custom GATT Message → **Glasses**
2. **Glasses Mic** → LC3 Encode → Custom GATT Message → **App**

This approach gives us the benefits of LC3 compression without the limitations of standard Bluetooth audio profiles.

#### Coexistence with Standard Audio

- **Keep existing HFP/LE Audio**: Maintain current standard audio implementation
- **Runtime toggling**: Switch between standard and custom modes as needed
- **Use case flexibility**: Standard audio for system integration, custom GATT for concurrent audio scenarios

## Implementation Checklist

For the glasses BES firmware, you need to:

### 1. Add LC3 Codec Library

- Include LC3 encoder library
- Configure for: 10ms frames, 32kHz sample rate, appropriate bitrate for voice

### 2. Create Custom GATT Service

- Add a custom service with characteristics for audio data transfer
- One characteristic for sending microphone audio to phone (TX)
- Enable notifications on TX characteristic

### 3. Audio Pipeline

- **For Microphone**: Mic → PCM → LC3 Encoder → Pack into BLE packets → Send via GATT

### 4. Keep Existing HFP/Audio

- Don't remove standard Bluetooth audio support
- Add toggle commands to switch between standard and custom audio modes

### 5. Packet Format

- Each audio packet should include a sequence number for ordering
- Keep packets under BLE MTU size (typically ~240 bytes)

## Implementation Requirements

### Toggle System

The implementation should provide runtime toggles for different audio modes:

```json
{
  "C": "enable_custom_audio_rx",
  "B": true/false
}
```

```json
{
  "C": "enable_custom_audio_tx",
  "B": true/false
}
```

```json
{
  "C": "enable_hfp_audio_server",
  "B": true/false
}
```

### Audio Direction Support

- **RX (Receive)**: Phone → Glasses audio streaming
- **TX (Transmit)**: Glasses → Phone microphone audio

### Compatibility

- **Maintain HFP**: Keep existing HFP system for compatibility
- **Runtime Switching**: Allow toggling between HFP and custom GATT

## Technical Implementation Example

> **Note**: The following technical details are from the Even Realities G1 smart glasses implementation found in `EvenRealitiesG1SGC.java`, which serves as a reference example for custom LC3 GATT audio. This is just an example of how it's done with the Even Realities G1 glasses.

### GATT Service Structure

```
Service UUID: 6E400001-B5A3-F393-E0A9-E50E24DCCA9E (UART Service)
├── TX Characteristic: 6E400002-B5A3-F393-E0A9-E50E24DCCA9E (Phone → Glasses)
├── RX Characteristic: 6E400003-B5A3-F393-E0A9-E50E24DCCA9E (Glasses → Phone)
└── Descriptor: 00002902-0000-1000-8000-00805f9b34fb (Notifications)
```

### LC3 Audio Packet Format

```
Packet Structure (202 bytes total):
├── Byte 0: 0xF1 (Audio data identifier)
├── Byte 1: Sequence number (0-255)
└── Bytes 2-201: LC3 encoded audio data (200 bytes)
```

### Control Commands

```
Microphone Control:
├── Enable: 0x0E 0x01
├── Disable: 0x0E 0x00
└── Heartbeat: Periodic keep-alive commands
```

### Audio Processing Flow

1. **Outgoing Audio (Phone → Glasses)**:
   - Package LC3 audio into GATT packets with sequence numbers
   - Send via TX characteristic

2. **Incoming Audio (Glasses → Phone)**:
   - Receive LC3 packets via RX characteristic
   - Validate sequence numbers
   - Decode LC3 to PCM for processing

### Real-time Streaming Considerations

For optimal responsiveness and user experience:

1. **Minimal Buffering**: Keep audio buffering under 100ms to reduce latency
2. **Immediate Processing**: Process and forward audio packets as soon as they arrive
3. **No Batch Processing**: Avoid accumulating multiple packets before processing
4. **Direct Streaming**: Stream audio data directly without intermediate storage when possible

This approach ensures low-latency audio transmission critical for real-time voice interactions and responsive audio feedback.

## Reference Implementation: Even Realities G1 Smart Glasses

### Overview

The Even Realities G1 implementation in `EvenRealitiesG1SGC.java` provides a working example of custom LC3 GATT audio.

### Key Implementation Details

#### Audio Data Detection

```java
// Detect audio packets by header byte
if (data[0] == (byte) 0xF1) {
    byte sequenceNumber = data[1];
    byte[] lc3Data = Arrays.copyOfRange(data, 2, 202);

    // Decode LC3 to PCM
    byte[] pcmData = L3cCpp.decodeLC3(lc3DecoderPtr, lc3Data);
}
```
