# Fix Camera BLE Reliability Issues

## Executive Summary

The current PR for packet loss recovery has several critical issues that will cause data corruption and storage problems in production. This document outlines all identified issues and proposes solutions.

## Critical Issues

### 1. ❌ No File Deletion After Successful Transfer

**Problem**: Files are never deleted from glasses storage after successful transfer confirmation.

**Impact**:

- Storage will fill up over time
- Glasses will eventually run out of space
- Old photos may be retransmitted
- System will become unusable

**Current Code** (K900BluetoothManager.java:680-684):

```java
if (success) {
    Log.d(TAG, "✅ File transfer completed successfully: " + fileName);
    // File deletion code was REMOVED!
} else {
    Log.e(TAG, "❌ File transfer failed: " + fileName);
}
```

**Fix Required**:

```java
if (success) {
    Log.d(TAG, "✅ File transfer completed successfully: " + fileName);

    // Delete the file after successful transfer confirmation
    if (currentFileTransfer != null && currentFileTransfer.filePath != null) {
        try {
            File file = new File(currentFileTransfer.filePath);
            if (file.exists() && file.delete()) {
                Log.d(TAG, "🗑️ Deleted file after confirmed successful BLE transfer: " + currentFileTransfer.filePath);
            } else {
                Log.w(TAG, "Failed to delete file: " + currentFileTransfer.filePath);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error deleting file after BLE transfer", e);
        }
    }
} else {
    Log.e(TAG, "❌ File transfer failed: " + fileName);
    // Keep file for manual retry or debugging
}
```

### 2. ❌ Incorrect Packet Loss Threshold (>50%)

**Problem**: System only treats transfer as failed if >50% packets are missing. ANY missing packet corrupts binary data like photos.

**Impact**:

- Corrupted photos accepted as successful
- Binary data (JPEG/AVIF) becomes unreadable with even 1 missing packet
- User loses photos thinking they were saved

**Current Code** (MentraLiveSGC.java:3749-3760):

```java
// Check if too many packets are missing (>50% = likely failure)
if (session != null && missingPackets.size() > session.totalPackets / 2) {
    Log.e(TAG, "❌ Too many missing packets...");
    sendTransferCompleteConfirmation(fileName, false);
    return;
}
```

**Fix Required**: Remove the threshold entirely OR make it configurable per file type:

```java
// For binary files (photos), ANY missing packet is a failure
boolean isBinaryFile = fileName.endsWith(".jpg") || fileName.endsWith(".avif") ||
                       fileName.endsWith(".png") || fileName.endsWith(".mp4");

if (isBinaryFile && !missingPackets.isEmpty()) {
    // For binary files, request retransmission for ANY missing packets
    Log.w(TAG, "🔍 Binary file has " + missingPackets.size() + " missing packets - requesting retransmission");
    // Continue with retransmission request...
} else if (missingPackets.size() > session.totalPackets / 2) {
    // For text/log files, >50% missing might indicate complete failure
    Log.e(TAG, "❌ Too many missing packets for non-binary file");
    sendTransferCompleteConfirmation(fileName, false);
    return;
}
```

### 3. ❌ Inefficient Full Restart Instead of Selective Retransmission

**Problem**: When packets are missing, the entire file is retransmitted from packet 0.

**Impact**:

- Wastes time and battery
- Increases chance of more packet loss
- Poor user experience for large files

**Current Implementation** (K900BluetoothManager.java):

```java
public void restartFileTransfer(String fileName, List<Integer> missingPackets) {
    // Reset to beginning - INEFFICIENT!
    currentFileTransfer.currentPacketIndex = 0;
    sendFileTransferAnnouncement();
    sendFilePacket(0); // Start from packet 0
}
```

**Better Solution**: Implement selective retransmission:

```java
public void retransmitMissingPackets(String fileName, List<Integer> missingPackets) {
    if (currentFileTransfer == null || !currentFileTransfer.fileName.equals(fileName)) {
        Log.w(TAG, "Cannot retransmit - no matching active transfer");
        return;
    }

    Log.d(TAG, "🔄 Retransmitting " + missingPackets.size() + " missing packets for " + fileName);

    // Sort packets to send in order
    Collections.sort(missingPackets);

    // Send only the missing packets
    for (int packetIndex : missingPackets) {
        if (packetIndex < currentFileTransfer.totalPackets) {
            transmitPacket(packetIndex, true); // true = retransmission

            // Small delay between retransmissions
            try {
                Thread.sleep(RETRANSMISSION_DELAY_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
    }

    // Send a "retransmission complete" marker
    sendRetransmissionComplete(fileName, missingPackets.size());
}
```

### 4. ⚠️ Test Code Enabled in Production

**Problem**: Packet drop simulation is enabled by default.

**Current Code** (K900BluetoothManager.java):

```java
private static final boolean ENABLE_PACKET_DROP_TEST = true; // WRONG!
private static final int PACKET_TO_DROP = 5;
```

**Fix**:

```java
private static final boolean ENABLE_PACKET_DROP_TEST = false; // Disable for production
// Or better: use BuildConfig
private static final boolean ENABLE_PACKET_DROP_TEST = BuildConfig.DEBUG && false;
```

### 5. ⚠️ Hardcoded Test Packet in Production Code

**Problem**: `retransmitSinglePacket()` contains hardcoded test data instead of actual retransmission logic.

**Current Code**:

```java
private void retransmitSinglePacket(int packetIndex) {
    Log.d(TAG, "🧪 TESTING: Sending hardcoded test packet...");
    String hexData = "23 23 31 00 EC 00..."; // HARDCODED TEST DATA!
    // ...
}
```

**Fix**: Remove this method entirely or replace with actual retransmission.

### 6. ⚠️ Commented Out Timeout Check

**Problem**: Transfer timeout mechanism is commented out.

**Current Code**:

```java
// // Schedule transfer timeout check
// fileTransferExecutor.schedule(() -> checkTransferTimeout(),
//                              TRANSFER_TIMEOUT_MS, TimeUnit.MILLISECONDS);
```

**Fix**: Either implement it properly or remove it entirely.

## Implementation Status

### ✅ Phase 1: Critical Fixes (COMPLETED)

1. **✅ Add file deletion** after successful transfer confirmation
   - Files are now deleted from glasses storage only after receiving success confirmation from phone
   - Prevents storage leak that would fill up glasses over time

2. **✅ Remove the >50% threshold**
   - ANY missing packets now trigger a full file restart
   - Prevents corrupted photos from being marked as successful
   - Added TODO comment for future selective retransmission

3. **✅ Disable test code** (ENABLE_PACKET_DROP_TEST = false)
   - Test flag now disabled by default
   - Can be re-enabled for testing packet loss scenarios

4. **✅ Remove hardcoded test packet**
   - Removed entire `retransmitSinglePacket()` method containing test data

### Phase 2: Optimization (Can be follow-up PR)

1. **Implement selective retransmission** instead of full restart
2. **Add proper timeout handling** with exponential backoff
3. **Add retry limits** (e.g., max 3 retransmission attempts)
4. **Track per-packet retry counts** to identify consistently failing packets

### Phase 3: Advanced Features

1. **Adaptive packet sizing** based on connection quality
2. **FEC (Forward Error Correction)** for critical data
3. **Compression** before transfer to reduce data size
4. **Checksum verification** per packet or per file

## Testing Strategy

1. **Unit Tests**:
   - Test packet loss detection
   - Test file assembly with missing packets
   - Test deletion after success confirmation

2. **Integration Tests**:
   - Simulate various packet loss scenarios (1%, 5%, 10%, 50%)
   - Test with different file sizes
   - Test timeout scenarios
   - Verify storage cleanup

3. **Field Tests**:
   - Test in high-interference environments
   - Test with moving users (walking)
   - Test with various phone models
   - Monitor storage usage over time

## Success Metrics

- **Transfer Success Rate**: >99% for files under 1MB in normal conditions
- **Storage Leak**: 0 bytes (all successful transfers deleted)
- **Retry Efficiency**: <20% overhead for retransmission (vs full restart)
- **User Experience**: No corrupted photos delivered to user

## Code Review Checklist

- [ ] File deletion implemented after successful transfer
- [ ] Packet loss threshold appropriate for binary files
- [ ] Test code disabled (ENABLE_PACKET_DROP_TEST = false)
- [ ] Hardcoded test data removed
- [ ] Timeout mechanism decided (implement or remove)
- [ ] Selective retransmission implemented (or planned for follow-up)
- [ ] Storage cleanup verified in testing
- [ ] No corrupted files can be marked as successful

## Risk Assessment

**High Risk** (if not fixed):

- Storage exhaustion on glasses
- Corrupted photos delivered to users
- System becomes unusable over time

**Medium Risk**:

- Battery drain from inefficient retransmission
- Poor performance in lossy environments

**Low Risk**:

- Minor inefficiencies in retry logic

## Conclusion

The current implementation provides a foundation for packet loss recovery but has critical issues that will cause data corruption and storage problems in production. The most urgent fixes are:

1. **Add file deletion** (prevent storage leak)
2. **Fix packet loss threshold** (prevent corrupted photos)
3. **Disable test code** (prevent deliberate packet drops)

These MUST be addressed before merging. The optimization to selective retransmission can be a follow-up improvement, but the critical fixes are non-negotiable for production readiness.
