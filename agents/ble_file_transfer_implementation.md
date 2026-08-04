# BLE File Transfer Implementation for K900/Mentra Live Glasses

## 🎉 IMPLEMENTATION COMPLETE AND WORKING!

This document tracks the successful implementation of BLE file transfer protocol for sending images from K900/Mentra Live glasses to phone. The implementation achieves blazing-fast transfer speeds (~600ms for 13KB) using the BES chip's auto-acknowledgment system.

## Protocol Documentation (from ODM)

### 1. BLE Service and Characteristics

- **Service UUID**: `00004860-0000-1000-8000-00805f9b34fb`
- **File Read UUID**: `000072FF-0000-1000-8000-00805f9b34fb` (BES → Phone)
- **File Write UUID**: `000073FF-0000-1000-8000-00805f9b34fb` (Phone → BES)
- **Normal TX/RX UUIDs**: `000070FF/000071FF`

### 2. File Transfer Protocol Format

```
head(2) + file_type(1) + pack_size(2) + pack_index(2) + file_size(4) +
file_name(16) + flags(2) + data(n) + verify(1) + tail(2)
```

- **Head**: `##` (0x23, 0x23)
- **File type**: `0x31` for photos
- **Pack size**: 400 bytes per packet (except last)
- **Pack index**: Starting from 0
- **Verify**: Checksum of data bytes (sum & 0xFF)
- **Tail**: `$$` (0x24, 0x24)
- **Total packet size**: 432 bytes (32 bytes header/footer + 400 bytes data)

### 3. CRITICAL DISCOVERY: BES Auto-Acknowledgment System

The key breakthrough was understanding that the BES2700 chip automatically handles ALL acknowledgments:

1. **MTK sends packet to BES via UART**
2. **BES immediately sends ACK back to MTK** with format: `{"C":"cs_flts","B":{"state":1,"index":packet_index+1}}`
3. **BES forwards packet to phone via BLE** (fire-and-forget)
4. **MTK receives BES ACK and sends next packet**

**The phone NEVER sends acknowledgments!** The ODM documentation only describes MTK<=>BES communication, not phone involvement.

## Why It's So Fast

The implementation achieves remarkable speed (13KB in ~600ms) because:

1. **No Round-Trip Delays**: BES chip ACKs immediately (~13-21ms) without waiting for phone
2. **Fast Mode**: UART sleep reduced from 50ms to 5ms during transfers
3. **Large Packets**: 400-byte data chunks minimize overhead
4. **MTU Optimization**: 512-byte MTU negotiated for efficient BLE transmission
5. **No Retries Needed**: Reliable BES<=>Phone BLE connection

## Critical Implementation Details

### 1. Byte Order (MANDATORY)

- **All multi-byte integers MUST use big-endian byte order**
- This includes: pack_size, pack_index, file_size, flags
- BES chip expects big-endian and won't parse packets otherwise

### 2. Message Extraction Order (MANDATORY)

- **Try big-endian extraction first** for messages from BES chip
- **Fall back to little-endian** for messages from phone
- Different components use different byte orders!

### 3. BES ACK Index Behavior (MANDATORY)

BES response indices are asymmetric:

- Success (`state=1`) is cumulative and sends the next expected index. For example,
  `index=16` acknowledges packets 0 through 15, so the sender maps it to packet 15.
- Failure (`state=0`) sends the exact zero-based packet BES still expects. For example,
  `index=16` means resend packet 16; do not subtract one.

Treating a failure index as one-based causes the sender to retry an already-ACKed packet,
discard the failure as stale, and eventually time out every packet after the gap.

### 4. Phone-Side Changes Required in MentraLiveSGC.java

**MANDATORY changes:**

1. **Remove phone ACK sending** - BES handles this automatically
2. **Add file packet detection** for 0x31 command type
3. **Implement file reassembly** with duplicate detection
4. **Save complete files** to app storage

**What we changed:**

```java
// In processReceivedData():
// 1. Detect file packets (type 0x31)
if (commandType == 0x31) {
    // Process file packet
}

// 2. DON'T send ACKs - BES handles this
// sendFileTransferAck(1, packetInfo.packIndex); // REMOVED!

// 3. Reassemble file with duplicate detection
if (!receivedPackets.contains(packetIndex)) {
    // Add packet data to buffer
}

// 4. Save complete file
if (receivedBytes == fileSize) {
    saveReceivedFile();
}
```

## Code Cleanup Opportunities

### 1. **Remove Phone ACK Code**

- `MentraLiveSGC.sendFileTransferAck()` - NOT NEEDED
- `K900ProtocolUtils.createFileTransferAck()` - NOT NEEDED (except for BES simulation)
- Any phone-side ACK sending logic - NOT NEEDED

### 2. **Simplify K900BluetoothManager**

- Remove complex ACK timeout/retry logic if BES is reliable
- Consider removing `pendingPackets` tracking if not needed
- Simplify `FilePacketState` class

### 3. **Clean Up Byte Order Handling**

- Standardize on big-endian for file packets
- Document byte order requirements clearly
- Remove little-endian file packet code paths

### 4. **Remove Debug/Test Code**

- Excessive logging in production paths
- Test image sending from assets (keep for dev only)
- Notification manager debug messages

### 5. **Consolidate Duplicate Code**

- File packet parsing appears in multiple places
- Byte order conversion utilities could be centralized
- JSON wrapping/unwrapping logic is repeated

## What's Essential vs What Can Go

### Essential Code:

1. **K900ProtocolUtils.packFilePacket()** - Creates file packets
2. **K900ProtocolUtils.extractFilePacket()** - Parses file packets
3. **K900BluetoothManager file transfer methods** - Sends packets
4. **MentraLiveSGC file reassembly** - Receives and saves files
5. **ComManager fast mode** - Critical for performance
6. **Big-endian byte order** - Required by BES chip

### Can Be Removed:

1. **Phone ACK sending/receiving** - BES handles this
2. **Complex retry logic** - BES ACKs are reliable
3. **Little-endian file packet code** - Not used
4. **Excessive debug logging** - Clean up for production
5. **ACK timeout scheduling** - Not needed with immediate BES ACKs

## Performance Metrics

Based on successful transfer of test.jpg:

- **File Size**: 13,147 bytes
- **Packets**: 33 (0-32)
- **Transfer Time**: ~600ms
- **Throughput**: ~22 KB/s
- **ACK Latency**: 13-21ms (BES chip response time)
- **Packet Size**: 432 bytes (400 data + 32 header/footer)
- **Success Rate**: 100% (no retries needed)

## Lessons Learned

1. **Read ODM docs carefully** - They described MTK<=>BES, not phone behavior
2. **Question assumptions** - "Phantom ACKs" were real BES ACKs
3. **Byte order matters** - Big-endian vs little-endian caused major issues
4. **Trust the hardware** - BES chip's auto-ACK is faster than round-trip
5. **Simple is fast** - Removing phone ACKs made transfers blazing fast

## Test Setup

1. Place test image in `/asg_client/app/src/main/assets/test.jpg`
2. Press photo button on glasses
3. File appears in `/storage/emulated/0/Android/data/com.mentra.mentra/files/MentraLive_Images/`
4. Retrieve with: `adb pull <path>`

## Next Steps

1. **Production Cleanup** - Remove debug code and unnecessary ACK logic
2. **Error Handling** - Add timeouts for stuck transfers
3. **Progress Callbacks** - Notify UI of transfer progress
4. **Multiple File Types** - Support video, audio, etc.
5. **Bidirectional Transfer** - Send files from phone to glasses
