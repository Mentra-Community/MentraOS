# MentraOS Mobile App Crash Report - v2.3.0

Generated: 2026-01-09

This document catalogs all hard crashes (native crashes, fatal errors, app terminations) affecting the mobile app in release 2.3.0, ranked by event count.

---

## Summary

| Rank | Issue ID      | Platform | Events | Users | Error Type                | Status                                              |
| ---- | ------------- | -------- | ------ | ----- | ------------------------- | --------------------------------------------------- |
| 1    | MENTRA-OS-3   | iOS      | 349    | 31    | WatchdogTermination (RAM) | **FIXED** - SileroVAD memory leak                   |
| 2    | MENTRA-OS-3M  | Android  | 323    | 63    | SIGABRT (abort)           | Unknown - no stacktrace                             |
| 3    | MENTRA-OS-T9  | Android  | 121    | 75    | NullPointerException      | **FIXED** - Migrated to @dr.pogodin/react-native-fs |
| 4    | MENTRA-OS-3C  | iOS      | 25     | 2     | EXC_BAD_ACCESS            | Open - Swift async memory issue                     |
| 5    | MENTRA-OS-5V  | iOS      | 19     | 5     | EXC_BREAKPOINT            | **FIXED** - Bridge.swift thread safety              |
| 6    | MENTRA-OS-MC  | iOS      | 14     | 12    | EXC_BREAKPOINT            | **FIXED** - Bridge.swift thread safety              |
| 7    | MENTRA-OS-14G | iOS      | 10     | 4     | EXC_BAD_ACCESS            | **FIXED** - SileroVAD buffer fix                    |
| 8    | MENTRA-OS-7J  | iOS      | 9      | 4     | EXC_BAD_ACCESS            | Open - React Native framework                       |
| 9    | MENTRA-OS-R4  | iOS      | 8      | 7     | NSRangeException          | Open - CoreLocation bounds                          |
| 10   | MENTRA-OS-V6  | iOS      | 4      | 4     | EXC_BAD_ACCESS            | **FIXED** - Bridge.swift thread safety              |

---

## Detailed Crash Analysis

### 1. MENTRA-OS-3 - iOS Watchdog Termination (RAM Overuse) ✅ FIXED

**Sentry URL:** https://mentra-labs.sentry.io/issues/MENTRA-OS-3

| Metric         | Value                     |
| -------------- | ------------------------- |
| Events         | 349                       |
| Users Affected | 31                        |
| First Seen     | 2025-08-13                |
| Last Seen      | 2026-01-09 (17 hours ago) |
| Platform       | iOS (cocoa)               |
| Status         | **FIXED in PR #1858**     |

**Error:**

```
WatchdogTermination: The OS watchdog terminated your app, possibly because it overused RAM.
```

**Stacktrace:** None available (iOS kills the app before it can capture)

**Context:**

- Occurs when app is in foreground
- No specific device pattern (iPhone 14, etc.)
- Consistent across iOS versions 18.x

**Root Cause Analysis:**
The iOS watchdog terminates apps that consume too much memory. This is a gradual memory leak or excessive allocation issue.

**Fix Applied:**
The memory leak was traced to `SileroVAD.swift` creating new `NSMutableData` objects for every audio frame (~30-60x/sec), causing ~50MB/minute memory growth. Fixed by:

1. Pre-allocating reusable buffers (`inputData`, `srData`, `hData`, `cData`) as instance variables
2. Reusing these buffers in the `predict()` method instead of creating new ones
3. Added `MemoryMonitor.swift` utility for future debugging (disabled by default)

Memory verified stable at ~535MB instead of continuously climbing.

---

### 2. MENTRA-OS-3M - Android Native Abort

**Sentry URL:** https://mentra-labs.sentry.io/issues/MENTRA-OS-3M

| Metric         | Value                     |
| -------------- | ------------------------- |
| Events         | 323                       |
| Users Affected | 63                        |
| First Seen     | 2025-08-22                |
| Last Seen      | 2026-01-09 (10 hours ago) |
| Platform       | Android (native)          |
| Status         | Unresolved, Ongoing       |

**Error:**

```
SIGABRT: Abort
```

**Stacktrace:**

```
at <unknown> (<unknown>)
at abort (<unknown>)
```

**Context:**

- Affects various Samsung devices (SM-S928W, etc.)
- Android 15-16
- No clear pattern in device/OS combination
- Mechanism: signalhandler

**Root Cause Analysis:**
A native library is calling `abort()`. Without symbols, the exact location is unknown. Likely candidates:

- LiveKit WebRTC native code
- ONNX Runtime (SileroVAD)
- Sherpa-ONNX (speech recognition)
- React Native Hermes engine

**Recommended Fix:**

1. **Enable native crash symbolication** in Sentry for all native libraries
2. **Add NDK debug symbols** to build process
3. **Wrap native library calls** with try-catch where possible
4. **Check for assertion failures** in native dependencies

**Difficulty:** High (requires native debugging and symbolication)

---

### 3. MENTRA-OS-T9 - React Native Bridge NPE ✅ FIXED

**Sentry URL:** https://mentra-labs.sentry.io/issues/MENTRA-OS-T9

| Metric         | Value                    |
| -------------- | ------------------------ |
| Events         | 121                      |
| Users Affected | 75                       |
| First Seen     | 2025-10-21               |
| Last Seen      | 2026-01-09 (8 hours ago) |
| Platform       | Android (java)           |
| Status         | **FIXED in PR #1858**    |

**Error:**

```
NullPointerException: Parameter specified as non-null is null:
method com.facebook.react.bridge.PromiseImpl.reject, parameter code
```

**Stacktrace:**

```
at com.facebook.react.bridge.PromiseImpl.reject(Unknown Source:2)
at com.rnfs.RNFSManager.reject(RNFSManager.java:978)
at com.rnfs.RNFSManager.-$$Nest$mreject(Unknown Source)
at com.rnfs.RNFSManager$3.onTaskCompleted(RNFSManager.java:734)
at com.rnfs.Downloader$1.run(Downloader.java:34)
at java.lang.Thread.run(Thread.java:1119)
```

**Context:**

- RNFS (react-native-fs) library calling Promise.reject with null code
- Happens during file download operations
- Affects various Samsung devices

**Root Cause Analysis:**
The `react-native-fs` library is passing `null` as the error code when rejecting a promise. This is a bug in error handling within RNFS.

**Fix Applied:**
Migrated from unmaintained `react-native-fs` to actively maintained fork `@dr.pogodin/react-native-fs` which has this bug fixed. Updated imports in 6 source files:

- `fullscreen.tsx`, `GalleryScreen.tsx`, `TarBz2Extractor.ts`, `STTModelManager.ts`, `localStorageService.ts`, `asgCameraApi.ts`

---

### 4. MENTRA-OS-3C - iOS EXC_BAD_ACCESS (Swift Memory)

**Sentry URL:** https://mentra-labs.sentry.io/issues/MENTRA-OS-3C

| Metric         | Value               |
| -------------- | ------------------- |
| Events         | 25                  |
| Users Affected | 2                   |
| First Seen     | 2025-08-21          |
| Last Seen      | 2026-01-04          |
| Platform       | iOS (cocoa)         |
| Status         | Unresolved, Ongoing |

**Error:**

```
EXC_BAD_ACCESS: KERN_INVALID_ADDRESS at 0xa106974f8
```

**Stacktrace:**

```
at swift::runJobInEstablishedExecutorContext
at objc_release
```

**Context:**

- Occurs when app is in background
- Swift async context with object release
- iPhone 18,2 (iPhone 16 Pro)

**Root Cause Analysis:**
Object being released after it was already deallocated. This is a use-after-free bug, likely in async Swift code where an object is captured weakly or escapes its expected lifetime.

**Recommended Fix:**

1. **Audit async closures** for proper capture semantics (`[weak self]`)
2. **Check background task handlers** for object lifetime issues
3. **Enable Address Sanitizer** in debug builds to catch earlier
4. **Review LiveKit disconnect/reconnect** code paths

**Difficulty:** Medium (requires careful review of async code)

---

### 5. MENTRA-OS-5V - iOS EXC_BREAKPOINT (BLE Callback) ✅ FIXED

**Sentry URL:** https://mentra-labs.sentry.io/issues/MENTRA-OS-5V

| Metric         | Value                 |
| -------------- | --------------------- |
| Events         | 19                    |
| Users Affected | 5                     |
| First Seen     | 2025-08-28            |
| Last Seen      | 2025-12-31            |
| Platform       | iOS (cocoa)           |
| Status         | **FIXED in PR #1858** |

**Error:**

```
EXC_BREAKPOINT: Exception 6, Code 1, Subcode 6835908640
```

**Stacktrace:**

```
at -[CBPeripheral handleCharacteristicEvent:...]
at <redacted>  // Our BLE handling code
at facebook::react::concreteComponentDescriptorConstructor<T>
at std::runtime_error::~runtime_error
```

**Context:**

- Triggered during CoreBluetooth characteristic event handling
- Exception being thrown and caught improperly
- React Native component descriptor involved

**Root Cause Analysis:**
A BLE characteristic update is triggering code that throws a C++ exception (`std::runtime_error`), which is not being caught properly and causes the app to crash.

**Fix Applied:**
Added `dispatchEvent()` helper in `Bridge.swift` that ensures all React Native event callbacks are dispatched on the main thread:

```swift
private static func dispatchEvent(_ eventName: String, _ data: [String: Any]) {
    guard let callback = eventCallback else { return }
    if Thread.isMainThread {
        callback(eventName, data)
    } else {
        DispatchQueue.main.async {
            callback(eventName, data)
        }
    }
}
```

---

### 6. MENTRA-OS-MC - iOS EXC_BREAKPOINT (NSMutableArray Threading) ✅ FIXED

**Sentry URL:** https://mentra-labs.sentry.io/issues/MENTRA-OS-MC

| Metric         | Value                 |
| -------------- | --------------------- |
| Events         | 14                    |
| Users Affected | 12                    |
| First Seen     | 2025-09-29            |
| Last Seen      | 2026-01-01            |
| Platform       | iOS (cocoa)           |
| Status         | **FIXED in PR #1858** |

**Error:**

```
EXC_BREAKPOINT: 833-09B09469A32F > isEqual: > NSBlock
```

**Stacktrace:**

```
at -[NSMutableArray removeObject:]
at -[__NSCFString isEqual:]
at -[NSInvocation invoke]
at _dispatch_call_block_and_release
```

**Context:**

- App in background when crash occurs
- NSMutableArray being modified while being enumerated/accessed
- Dispatch queue serialization issue

**Root Cause Analysis:**
Classic thread-safety issue with `NSMutableArray`. An array is being accessed from multiple threads without proper synchronization. The `removeObject:` call is iterating the array while another thread modifies it.

**Fix Applied:**
Same fix as MENTRA-OS-5V - the `Bridge.swift` thread safety fix ensures all event callbacks are dispatched on the main thread, preventing concurrent access to arrays during event dispatch.

---

### 7. MENTRA-OS-14G - iOS EXC_BAD_ACCESS (SileroVAD Buffer) ✅ FIXED

**Sentry URL:** https://mentra-labs.sentry.io/issues/MENTRA-OS-14G

| Metric         | Value                 |
| -------------- | --------------------- |
| Events         | 10                    |
| Users Affected | 4                     |
| First Seen     | 2025-12-04            |
| Last Seen      | 2025-12-28            |
| Platform       | iOS (cocoa)           |
| Status         | **FIXED in PR #1858** |

**Error:**

```
EXC_BAD_ACCESS: KERN_INVALID_ADDRESS at 0x4c07acd482f7cf64
```

**Stacktrace:**

```
at PhoneMic.startRecordingInternal (PhoneMic.swift:595)
at CoreManager.handlePcm (CoreManager.swift:296)
at SileroVADStrategy.checkVAD (SileroVADStrategy.swift:33)
at SileroVAD.predict (SileroVAD.swift:183)
at SileroVAD.InternalBuffer.append (SileroVAD.swift:35)
at Array.append
at Array._makeUniqueAndReserveCapacityIfNotUnique
at _ArrayBuffer._consumeAndCreateNew
at swift::RefCounts<T>::doDecrementSlow
at _swift_release_dealloc
```

**Context:**

- Clear stacktrace pointing to SileroVAD audio buffer management
- Occurs during audio processing
- Memory being released while still in use

**Root Cause Analysis:**
The `SileroVAD.InternalBuffer` is experiencing a use-after-free. When appending to the audio buffer array, Swift's copy-on-write optimization is trying to create a new buffer, but the old buffer has already been deallocated.

**Fix Applied:**
Updated `SileroVAD.InternalBuffer` class in `SileroVAD.swift`:

1. Changed `[Bool]` to `ContiguousArray<Bool>` for better memory layout and to avoid copy-on-write issues
2. Pre-allocated capacity with `reserveCapacity()` to minimize reallocations
3. Added `NSLock` for thread-safe buffer access

---

### 8. MENTRA-OS-7J - iOS EXC_BAD_ACCESS (React Native Runtime)

**Sentry URL:** https://mentra-labs.sentry.io/issues/MENTRA-OS-7J

| Metric         | Value                  |
| -------------- | ---------------------- |
| Events         | 9                      |
| Users Affected | 4                      |
| First Seen     | 2025-09-03             |
| Last Seen      | 2026-01-08 (1 day ago) |
| Platform       | iOS (cocoa)            |
| Status         | Unresolved, Ongoing    |

**Error:**

```
EXC_BAD_ACCESS: KERN_INVALID_ADDRESS at 0x3f87c8c39a744f57
```

**Stacktrace:**

```
at facebook::react::RCTMessageThread::tryFunc
at facebook::react::RuntimeScheduler_Modern::runEventLoop
at facebook::react::RuntimeScheduler_Modern::updateRendering
```

**Context:**

- Deep in React Native's runtime scheduler
- Occurs in background
- Development environment (debug build)

**Root Cause Analysis:**
React Native's modern runtime scheduler is accessing invalid memory during UI updates. This could be a React Native framework bug or an issue with how native modules interact with the JS runtime.

**Recommended Fix:**

1. **Update React Native** to latest version
2. **Check for native module issues** that may corrupt the runtime
3. **Ensure proper cleanup** when app goes to background
4. **File issue with React Native** if persists after update

**Difficulty:** High (framework-level issue)

---

### 9. MENTRA-OS-R4 - iOS NSRangeException (Array Bounds)

**Sentry URL:** https://mentra-labs.sentry.io/issues/MENTRA-OS-R4

| Metric         | Value               |
| -------------- | ------------------- |
| Events         | 8                   |
| Users Affected | 7                   |
| First Seen     | 2025-10-10          |
| Last Seen      | 2026-01-04          |
| Platform       | iOS (cocoa)         |
| Status         | Unresolved, Ongoing |

**Error:**

```
NSRangeException: *** -[__NSArrayM insertObject:atIndex:]:
index 1276 beyond bounds [0 .. 1274]
```

**Stacktrace:**

```
at -[__NSArrayM insertObject:atIndex:]
at CLClientStopVehicleHeadingUpdates  // CoreLocation
at CLConnectionServer::handleDisconnection
```

**Context:**

- Related to CoreLocation (vehicle heading updates)
- Array index off-by-one or race condition
- Occurs when location services disconnect

**Root Cause Analysis:**
An array insertion is happening with an index that's 1 beyond the valid range (1276 vs max 1274). This is occurring in CoreLocation handling code, possibly when stopping location updates.

**Recommended Fix:**

1. **Audit location service stop/start code**
2. **Add bounds checking** before array insertions
3. **Check for race conditions** in location update handlers
4. **Ensure proper synchronization** when modifying location-related arrays

**Difficulty:** Medium

---

### 10. MENTRA-OS-V6 - iOS EXC_BAD_ACCESS (NSMutableArray Threading) ✅ FIXED

**Sentry URL:** https://mentra-labs.sentry.io/issues/MENTRA-OS-V6

| Metric         | Value                 |
| -------------- | --------------------- |
| Events         | 4                     |
| Users Affected | 4                     |
| First Seen     | 2025-10-23            |
| Last Seen      | 2026-01-04            |
| Platform       | iOS (cocoa)           |
| Status         | **FIXED in PR #1858** |

**Error:**

```
EXC_BAD_ACCESS: KERN_INVALID_ADDRESS at 0xd6a70
```

**Stacktrace:**

```
at -[NSMutableArray removeObject:]
at -[__NSCFString isEqual:]
at -[NSInvocation invoke]
```

**Context:**

- Same pattern as MENTRA-OS-MC
- NSMutableArray thread-safety issue
- Different users, same root cause

**Root Cause Analysis:**
Same as MENTRA-OS-MC - thread-unsafe access to NSMutableArray. These two issues likely share the same root cause.

**Fix Applied:**
Same fix as MENTRA-OS-MC/5V - the `Bridge.swift` thread safety fix.

---

## Summary of Fixes in PR #1858

### ✅ Fixed (6 crashes, ~415 events, ~131 users affected)

| Issue         | Fix                                                | Files Changed                  |
| ------------- | -------------------------------------------------- | ------------------------------ |
| MENTRA-OS-3   | SileroVAD memory leak - pre-allocated ONNX buffers | `SileroVAD.swift`              |
| MENTRA-OS-T9  | Migrated to `@dr.pogodin/react-native-fs` fork     | `package.json`, 6 source files |
| MENTRA-OS-5V  | Bridge.swift thread-safe event dispatch            | `Bridge.swift`                 |
| MENTRA-OS-MC  | Bridge.swift thread-safe event dispatch            | `Bridge.swift`                 |
| MENTRA-OS-14G | SileroVAD ContiguousArray + NSLock                 | `SileroVAD.swift`              |
| MENTRA-OS-V6  | Bridge.swift thread-safe event dispatch            | `Bridge.swift`                 |

### Remaining Issues (4 crashes)

| Issue        | Status  | Next Steps                                 |
| ------------ | ------- | ------------------------------------------ |
| MENTRA-OS-3M | Unknown | Enable native symbolication for Android    |
| MENTRA-OS-3C | Open    | Audit Swift async code for lifetime issues |
| MENTRA-OS-7J | Open    | May require React Native update            |
| MENTRA-OS-R4 | Open    | Add bounds checking in CoreLocation code   |

---

## Monitoring

After fixes are deployed, monitor these issues in Sentry:

- Mark as resolved in next release
- Set up regression alerts
- Track event count trends week-over-week
