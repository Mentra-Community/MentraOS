# ASG Selective Packet Retransmission Plan

## Executive Summary

Implement selective packet retransmission for BLE file transfers between ASG glasses and phones, working within BES2700 hardware constraints that require sequential packet transmission.

## Problem Statement

Current system retransmits ALL packets when ANY are missing, wasting bandwidth and battery. For example, if packets [5, 8, 14] are missing from a 100-packet transfer, we retransmit all 100 packets instead of just 3.

## BES2700 Hardware Constraint

The BES2700 Bluetooth chip requires packets to be sent sequentially through its interface (0, 1, 2...). We cannot send packets out of order, even for retransmission.

## Solution: Announcement-Based Index Mapping

Use a retransmission announcement message to map sequential BES indices to actual packet indices.

### Flow Diagram

```
GLASSES (BES2700)                    PHONE (Android/iOS)
─────────────────                    ──────────────────
1. Initial transfer → → → → → → → → → Receives packets
2. [Missing detected] ← ← ← ← ← ← ← Request missing [5,8,14]
3. Send announcement → → → → → → → → "Map: [0→5, 1→8, 2→14]"
4. Send 3 packets → → → → → → → → → BES sees: 0,1,2
                                     Phone maps to: 5,8,14
5. [Complete] ← ← ← ← ← ← ← ← ← ← ← Success confirmation
6. Delete file → → → → → → → → → → → Cleanup
```

## Implementation Details

### Phase 1: Glasses (ASG Client) Changes

#### 1.1 K900BluetoothManager.java - Add Announcement

```java
private void sendRetransmissionAnnouncement(String fileName, List<Integer> missingPackets) {
    try {
        JSONObject announcement = new JSONObject();
        announcement.put("type", "retransmission_map");
        announcement.put("fileName", fileName);
        announcement.put("indices", new JSONArray(missingPackets));
        announcement.put("count", missingPackets.size());
        announcement.put("timestamp", System.currentTimeMillis());

        String jsonStr = announcement.toString();
        Log.d(TAG, "📦 Sending retransmission map: " + jsonStr);
        sendData(jsonStr.getBytes(StandardCharsets.UTF_8));

    } catch (Exception e) {
        Log.e(TAG, "Error sending retransmission announcement", e);
    }
}
```

#### 1.2 Modify retransmitMissingPackets

```java
public void retransmitMissingPackets(String fileName, List<Integer> missingPackets) {
    // Validation and retry checks...

    // Send announcement first
    sendRetransmissionAnnouncement(fileName, missingPackets);

    // Small delay for announcement processing
    Thread.sleep(50);

    // Send only the missing packets
    sendSelectivePackets(missingPackets);
}

private void sendSelectivePackets(List<Integer> packetIndices) {
    for (int i = 0; i < packetIndices.size(); i++) {
        int actualPacketIndex = packetIndices.get(i);

        // Schedule with delay
        long delay = i * PACKET_SEND_DELAY_MS;
        fileTransferExecutor.schedule(() -> {
            transmitSinglePacket(actualPacketIndex);
        }, delay, TimeUnit.MILLISECONDS);
    }
}
```

### Phase 2: Android Phone (MentraLiveSGC.java)

#### 2.1 Add Retransmission Context

```java
private static class RetransmissionContext {
    String fileName;
    List<Integer> expectedIndices;  // [5, 8, 14]
    int currentPosition = 0;         // Maps sequential to actual
    long timestamp;

    Integer getActualIndex() {
        if (currentPosition < expectedIndices.size()) {
            return expectedIndices.get(currentPosition++);
        }
        return null;
    }

    boolean isComplete() {
        return currentPosition >= expectedIndices.size();
    }
}

private RetransmissionContext activeRetransmission = null;
```

#### 2.2 Handle Announcement

```java
private void handleRetransmissionAnnouncement(JSONObject json) {
    String fileName = json.getString("fileName");
    JSONArray indicesArray = json.getJSONArray("indices");

    List<Integer> indices = new ArrayList<>();
    for (int i = 0; i < indicesArray.length(); i++) {
        indices.add(indicesArray.getInt(i));
    }

    activeRetransmission = new RetransmissionContext(fileName, indices);
    Log.d(TAG, "📦 Expecting retransmission: " + indices);
}
```

#### 2.3 Modify Packet Handler

```java
private void handleFilePacket(byte[] data) {
    PacketInfo packetInfo = parsePacket(data);

    // Check if retransmission
    if (activeRetransmission != null &&
        activeRetransmission.fileName.equals(packetInfo.fileName)) {

        // Map sequential to actual index
        Integer actualIndex = activeRetransmission.getActualIndex();
        if (actualIndex != null) {
            packetInfo.packIndex = actualIndex;
            Log.d(TAG, "📦 Mapped packet: " + actualIndex);
        }

        if (activeRetransmission.isComplete()) {
            activeRetransmission = null;
        }
    }

    // Continue normal processing
    processFilePacket(packetInfo);
}
```

### Phase 3: iOS Phone (MentraLive.swift)

#### 3.1 Retransmission Context

```swift
class RetransmissionContext {
    let fileName: String
    let expectedIndices: [Int]
    var currentPosition = 0

    func getActualIndex() -> Int? {
        guard currentPosition < expectedIndices.count else { return nil }
        let index = expectedIndices[currentPosition]
        currentPosition += 1
        return index
    }

    var isComplete: Bool {
        return currentPosition >= expectedIndices.count
    }
}

private var activeRetransmission: RetransmissionContext?
```

#### 3.2 Handle Packets

```swift
func handlePacket(data: Data) {
    var packetInfo = parsePacket(data)

    if let retransmission = activeRetransmission,
       retransmission.fileName == packetInfo.fileName {

        if let actualIndex = retransmission.getActualIndex() {
            packetInfo.index = actualIndex
        }

        if retransmission.isComplete {
            activeRetransmission = nil
        }
    }

    processPacket(packetInfo)
}
```

## Testing Plan

### 1. Simulated Packet Loss

```java
// Test configuration in K900BluetoothManager
private static final boolean TEST_MODE = true;
private static final int[] PACKETS_TO_DROP = {5, 8, 14, 27, 45, 88};

private boolean shouldDropPacket(int index) {
    if (!TEST_MODE) return false;
    for (int dropIndex : PACKETS_TO_DROP) {
        if (index == dropIndex) return true;
    }
    return false;
}
```

### 2. Test Scenarios

1. **Single packet loss**: Drop packet 50 of 100
2. **Multiple scattered**: Drop [5, 8, 14, 27, 45, 88] of 100
3. **Edge cases**: Drop first (0), last (99), or both
4. **Large gaps**: Drop packets 10-20 (simulate burst loss)
5. **Announcement loss**: Simulate lost announcement packet

### 3. Validation Metrics

- Verify only missing packets are retransmitted
- Measure time savings vs full retransmission
- Confirm file integrity after selective retransmission
- Monitor battery/bandwidth usage reduction

## Rollback Strategy

Feature flag for quick disable:

```java
private static final boolean USE_SELECTIVE_RETRANSMISSION = true;

public void retransmitMissingPackets(...) {
    if (!USE_SELECTIVE_RETRANSMISSION) {
        // Fallback to full retransmission
        sendFileTransferAnnouncement();
        sendAllFilePackets();
        return;
    }
    // New selective logic
}
```

## Performance Benefits

### Example: 100-packet photo (200KB)

| Scenario            | Current (Full) | Optimized (Selective) | Savings |
| ------------------- | -------------- | --------------------- | ------- |
| 3 packets missing   | 100 packets    | 3 packets             | 97%     |
| 10 packets missing  | 100 packets    | 10 packets            | 90%     |
| Time (3 missing)    | ~10 seconds    | ~0.3 seconds          | 96%     |
| Battery (3 missing) | 100 mAh        | 3 mAh                 | 97%     |

## Risks and Mitigations

| Risk                      | Impact | Mitigation                      |
| ------------------------- | ------ | ------------------------------- |
| Announcement packet lost  | High   | Timeout + full restart fallback |
| Index mapping confusion   | High   | Extensive logging + validation  |
| Phone/glasses out of sync | Medium | Session ID in announcement      |
| iOS/Android inconsistency | Medium | Shared test suite               |
| BES firmware issues       | Low    | Feature flag disable            |

## Implementation Timeline

- **Day 1**: Implement glasses-side announcement + selective sending
- **Day 2**: Android phone-side retransmission handling
- **Day 3**: iOS phone-side implementation
- **Day 4**: Integration testing with simulated packet loss
- **Day 5**: Production deployment with feature flag enabled

## Success Criteria

1. ✅ Only missing packets are retransmitted
2. ✅ File integrity maintained after selective retransmission
3. ✅ 90%+ reduction in retransmission data for typical packet loss
4. ✅ Works reliably with both Android and iOS phones
5. ✅ No increase in transfer failure rate

## Future Optimizations

1. **Batch small files**: Group multiple small transfers
2. **Adaptive packet size**: Adjust based on link quality
3. **Forward Error Correction**: Add redundancy to prevent retransmission
4. **Persistent packet cache**: Keep recent packets in memory for instant retransmit

## Conclusion

This solution achieves selective packet retransmission efficiency while working within BES2700's sequential transmission constraint. Expected benefits include 90%+ reduction in retransmission overhead for typical packet loss scenarios.
