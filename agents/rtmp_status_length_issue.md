# RTMP Stream Status Message Length Issue

**Date:** October 28, 2025
**Severity:** Critical
**Affects:** Unmanaged RTMP streams
**Status:** Root cause identified

---

## Executive Summary

Unmanaged RTMP streams fail after 60 seconds due to missing keep-alive messages from the cloud. The root cause is a **268-byte status message** from the glasses that exceeds the BLE MTU (~244 bytes), causing the message to be fragmented across multiple BLE packets. The phone's BLE handling code **silently drops fragmented messages**, preventing the cloud from ever receiving the critical "streaming" status update needed to start sending keep-alives.

---

## Issue #1: RTMP Status Message Too Large (Primary Issue)

### Description

When the asg_client (glasses) successfully connects to an RTMP server, it sends a status update message to the phone with detailed information about the stream. This message has grown to **268 bytes** due to the inclusion of:

- Full RTMP URL (can be 40-60 bytes)
- Stream statistics object with bitrate, fps, droppedFrames
- Various metadata fields

### Evidence

From asg_client logs (timestamp 14:59:42.103):

```json
{
  "type": "rtmp_stream_status",
  "status": "streaming",
  "rtmpUrl": "rtmp://192.168.50.135/s/streamKey",
  "streamId": "sb40jg2ezu3",
  "stats": {
    "bitrate": 1500000,
    "fps": 30,
    "droppedFrames": 0
  },
  "timestamp": 1761688782102
}
```

After K900 protocol wrapping, this becomes:

- Payload: 206 bytes (raw JSON)
- C-wrapped: ~250 bytes (with JSON escaping)
- K900 protocol: **268 bytes total** (with headers ## + type + length + payload + $$)

### BLE MTU Constraints

- Default BLE MTU: 23 bytes
- Typical negotiated MTU: 247 bytes (244 bytes effective payload after 3-byte overhead)
- Maximum MTU: 517 bytes (rare, requires both devices to support it)

The 268-byte message **cannot fit in a single BLE packet** with standard MTU negotiation.

### Impact

When BLE fragments the message:

- First packet: 244 bytes
- Second packet: 24 bytes

The phone receives the fragmented packets but fails to reassemble them, silently dropping the entire message.

### Why This Affects Unmanaged Streams Only

**Managed streams** (Cloudflare-based):

- Cloud actively polls Cloudflare API to check stream status
- Has fallback mechanisms to detect if stream is live
- Not solely dependent on glasses status messages

**Unmanaged streams** (direct RTMP):

- Cloud has NO other way to detect if stream is live
- 100% dependent on receiving the "streaming" status from glasses
- No fallback or polling mechanism available

### Timeline of Failure

```
T+0.0s:  App requests unmanaged stream
T+0.0s:  Cloud sends START_RTMP_STREAM to phone → glasses
T+0.0s:  Cloud creates stream with status="initializing"
T+1.2s:  Glasses connect to RTMP server successfully
T+1.2s:  Glasses send status="streaming" (268 bytes) to phone
T+1.2s:  Phone receives fragmented BLE packets
T+1.2s:  ❌ Phone drops message due to incomplete reassembly
T+1.2s:  ❌ Cloud never receives "streaming" status
T+1.2s:  ❌ Cloud never calls lifecycle.setActive(true)
T+1.2s:  ❌ Cloud never starts sending keep-alive messages
T+60.0s: Glasses timeout waiting for keep-alive
T+60.0s: Glasses stop streaming and send error status
```

---

## Issue #2: Missing BLE Packet Reassembly Logic (Secondary Issue)

### Description

The phone's BLE handling code in all three implementations (OG Android, refactored Android, iOS) contains a **critical validation check** that drops any message where the received data length is less than the expected protocol length. This prevents proper handling of fragmented BLE packets.

### Code Locations

#### Refactored Android (Current)

**File:** `mobile/modules/core/android/src/main/java/com/mentra/core/utils/K900ProtocolUtils.java`
**Lines:** 395-398

```java
if (data.length < payloadLength + 7) {
    android.util.Log.d("K900ProtocolUtils",
        "Received data size (" + data.length +
        ") is less than expected size (" + (payloadLength + 7) + ")");
    return null;  // ❌ DROPS THE MESSAGE
}
```

#### OG Android (Pre-refactor)

**File:** `local/og_android_core/app/src/main/java/com/augmentos/augmentos_core/smarterglassesmanager/utils/K900ProtocolUtils.java`
**Lines:** 368-372

```java
if (data.length < payloadLength + 7) {
    android.util.Log.d("K900ProtocolUtils",
        "Received data size (" + data.length +
        ") is less than expected size (" + (payloadLength + 7) + ")");
    return null;  // ❌ DROPS THE MESSAGE
}
```

#### iOS

**File:** `mobile/modules/core/ios/Source/sgcs/MentraLive.swift`
**Line:** 1534

```swift
if commandType == 0x30, data.count >= payloadLength + 7 {
    // Only processes if complete message received
    // Silently ignores if data.count < payloadLength + 7
}
```

### Phone Logs Evidence

From phone logs at 14:59:44.165:

```
K900ProtocolUtils: Command type: 0x30, Payload length: 261
K900ProtocolUtils: Received data size (253) is less than expected size (268)
Live: Thread-305: Failed to parse K900 protocol data
```

**Analysis:**

- Expected size: 268 bytes (7 header bytes + 261 payload bytes)
- Received size: 253 bytes (first BLE packet fragment)
- Missing: 15 bytes (in second fragment)
- Result: Message dropped entirely

### Why This Wasn't Noticed Before

1. **Most messages are small**: Status updates, button presses, battery levels typically < 200 bytes
2. **"Initializing" status works**: The initial status message is smaller because it doesn't include stats/URL
3. **Managed streams hide the issue**: Cloudflare polling provides an alternative path
4. **Recent code changes**: The "streaming" status message may have grown over time with added fields

### Missing Features

The phone BLE handling lacks:

1. **Fragment buffer**: No accumulator to collect fragments across multiple BLE notifications
2. **Reassembly logic**: No code to detect partial K900 protocol messages and wait for completion
3. **Timeout handling**: No mechanism to clear stale fragments after a timeout
4. **Multi-packet detection**: No check to see if more data is coming based on payload length vs received length

---

## Potential Solutions

### Option 1: Reduce Message Size (Quick Fix)

**Modify asg_client to send minimal status message:**

```java
// In RtmpStreamingService.java or StreamingManager.java
// When sending "streaming" status, omit rtmpUrl and detailed stats

JSONObject statusMessage = new JSONObject();
statusMessage.put("type", "rtmp_stream_status");
statusMessage.put("status", "streaming");
statusMessage.put("streamId", streamId);
statusMessage.put("timestamp", System.currentTimeMillis());
// Don't include rtmpUrl - cloud already knows it
// Don't include stats - can be sent separately if needed
```

**Pros:**

- Quick to implement
- Minimal risk
- Works with existing phone/cloud code
- Message size: ~110 bytes (fits in single BLE packet)

**Cons:**

- Loses visibility into stream stats at connection time
- Doesn't fix the underlying reassembly problem
- Other messages might still hit this issue in future

### Option 2: Implement BLE Packet Reassembly (Proper Fix)

**Add reassembly logic to phone BLE handlers:**

```java
// Pseudocode for reassembly logic
private ByteBuffer fragmentBuffer = null;
private int expectedLength = 0;
private long lastFragmentTime = 0;
private static final long FRAGMENT_TIMEOUT_MS = 1000;

private JSONObject processK900Message(byte[] data) {
    // Check if this is the start of a new message
    if (data[0] == 0x23 && data[1] == 0x23) {
        int payloadLength = ((data[3] & 0xFF) << 8) | (data[4] & 0xFF);
        expectedLength = payloadLength + 7;

        // Check if we have the complete message
        if (data.length >= expectedLength) {
            // Complete message in one packet
            return parseK900Protocol(data);
        } else {
            // Start of fragmented message
            fragmentBuffer = ByteBuffer.allocate(expectedLength);
            fragmentBuffer.put(data);
            lastFragmentTime = System.currentTimeMillis();
            return null; // Wait for more fragments
        }
    } else if (fragmentBuffer != null) {
        // Continuation of fragmented message
        long now = System.currentTimeMillis();

        // Check for timeout
        if (now - lastFragmentTime > FRAGMENT_TIMEOUT_MS) {
            fragmentBuffer = null; // Clear stale fragments
            return null;
        }

        // Add to buffer
        fragmentBuffer.put(data);
        lastFragmentTime = now;

        // Check if complete
        if (fragmentBuffer.position() >= expectedLength) {
            byte[] completeMessage = fragmentBuffer.array();
            fragmentBuffer = null; // Clear buffer
            return parseK900Protocol(completeMessage);
        }
    }

    return null;
}
```

**Pros:**

- Fixes the root cause
- Handles any size message
- Future-proof
- Matches how BLE is designed to work

**Cons:**

- More complex implementation
- Needs testing across Android + iOS
- Need to handle edge cases (timeouts, out-of-order packets, interleaved messages)
- Higher risk of introducing bugs

### Option 3: Increase MTU Negotiation (Supplementary)

**Request higher MTU during BLE connection:**

```java
// In Android BLE callback
@Override
public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
    if (newState == BluetoothProfile.STATE_CONNECTED) {
        // Request maximum MTU (512 bytes) to reduce fragmentation
        gatt.requestMtu(512);
    }
}
```

**Pros:**

- Reduces fragmentation for many messages
- Simple to add
- Compatible with reassembly logic

**Cons:**

- Not guaranteed (both devices must support larger MTU)
- Doesn't eliminate fragmentation for very large messages
- Not a complete solution on its own

### Option 4: Send Stats Separately (Architectural)

**Split status updates into multiple messages:**

```java
// First: Send critical status immediately (small message)
sendStreamStatus("streaming", streamId);

// Then: Send stats as separate message (arrives after, but that's OK)
sendStreamStats(streamId, bitrate, fps, droppedFrames);
```

**Pros:**

- Keeps critical status messages small
- Detailed stats still available
- More modular message design
- Cloud can process status immediately, stats when they arrive

**Cons:**

- Requires changes to both glasses and cloud
- Need to handle out-of-order messages
- More messages = more BLE overhead

---

## Recommended Approach

### Short-term (Immediate Fix)

**Option 1: Reduce message size** in asg_client

- Remove `rtmpUrl` from streaming status (cloud already has it)
- Remove `stats` object from initial streaming status
- Keep the message under 150 bytes to ensure single-packet delivery
- **Estimated time:** 30 minutes
- **Risk:** Very low

### Medium-term (Complete Fix)

**Option 2: Implement BLE packet reassembly**

- Add fragment buffering to Android and iOS native modules
- Handle timeouts and edge cases
- Test with various message sizes
- **Estimated time:** 4-6 hours
- **Risk:** Medium (needs thorough testing)

### Long-term (Optimization)

**Option 3: Increase MTU negotiation**

- Request 512-byte MTU during connection
- Reduces fragmentation for most messages
- **Estimated time:** 1 hour
- **Risk:** Low

**Option 4: Architectural split**

- Design message protocol to split large payloads
- Send critical data in small messages
- Send supplementary data separately
- **Estimated time:** 2-3 hours
- **Risk:** Low

---

## Related Issues

### Why Managed Streams Still Work

Managed streams (Cloudflare) have a **dual status detection mechanism**:

1. **Glasses status messages** (same as unmanaged, but not critical)
2. **Cloudflare API polling** (polls every 5-10 seconds to check if stream is live)

When the glasses status message is dropped, the Cloudflare polling detects the stream is live anyway, so keep-alives start.

### Cloud Keep-alive Logic

**File:** `cloud/services/extensions/UnmanagedStreamingExtension.ts`
**Lines:** 508-594

The cloud only starts keep-alives when it receives a status message with:

- `status === "active"`
- `status === "streaming"`
- `status === "reconnected"`

```typescript
case "active":
case "streaming":
case "reconnected":
  mappedStatus = "active";
  runtime.lifecycle.setActive(true);  // 🔥 START KEEP-ALIVES
  break;
```

Without receiving the "streaming" status, `setActive(true)` is never called, and keep-alives never start.

---

## Testing Recommendations

### After Implementing Fix

1. **Basic functionality test:**
   - Start unmanaged RTMP stream
   - Verify cloud receives "streaming" status
   - Verify keep-alives are sent
   - Stream should stay alive > 2 minutes

2. **Message size test:**
   - Send messages of various sizes: 100, 200, 300, 400 bytes
   - Verify all are received correctly
   - Check phone logs for fragmentation handling

3. **Stress test:**
   - Send multiple large messages rapidly
   - Verify no messages are lost
   - Check for buffer overflow or memory leaks

4. **Timeout test:**
   - Simulate a dropped second fragment
   - Verify buffer is cleared after timeout
   - Verify next message is processed correctly

5. **Managed stream regression:**
   - Test managed streams still work
   - Verify Cloudflare polling still functions
   - Check both status paths work

---

## Additional Notes

### Why This Took So Long to Discover

1. Development testing often uses managed streams (easier setup with Cloudflare)
2. Unmanaged streams are less common in testing
3. The issue is timing-dependent (depends on BLE MTU negotiation)
4. Logs showed the glasses working fine, problem was in the middle (phone)
5. Cloud logs didn't show the missing message (silent failure)

### Lessons Learned

1. **BLE message size matters**: Always design protocol messages to fit in a single MTU
2. **Test with real hardware**: Emulators don't simulate BLE fragmentation accurately
3. **Log at every layer**: Glasses logged, cloud logged, but phone didn't log enough detail
4. **Protocol analyzers help**: A BLE sniffer would have shown the fragmentation immediately
5. **Have fallback mechanisms**: Managed streams' dual detection path saved them

---

## References

- Issue discovered: October 28, 2025
- Affected since: Unknown (possibly after adding stats to streaming status)
- Platform: All platforms (Android, iOS)
- Related files:
  - `asg_client/app/src/main/java/.../StreamingManager.java`
  - `mobile/modules/core/android/src/main/java/.../K900ProtocolUtils.java`
  - `mobile/modules/core/ios/Source/sgcs/MentraLive.swift`
  - `cloud/services/extensions/UnmanagedStreamingExtension.ts`
