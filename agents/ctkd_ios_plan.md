# CTKD Audio Pairing for iOS - Implementation Plan

## Overview

This document outlines the plan to implement Bluetooth audio pairing detection for Mentra Live glasses on iOS, achieving feature parity with Android's CTKD (Cross-Transport Key Derivation) implementation.

## Background

### Android (Current - Works Great!)

On Android, Mentra Live glasses use CTKD with the BES2800 chipset:

1. User selects Mentra Live
2. BLE scan shows devices
3. User taps device → BLE connects
4. **CTKD automatically triggers** → System shows "Pair with Mentra Live?" prompt
5. User taps "Pair" → Both BLE + BT Classic connected
6. Navigate to home

Implementation location: `mobile/modules/core/android/src/main/java/com/mentra/core/sgcs/MentraLive.java` (lines 770-773, 3031-3151)

### iOS (Current - Limited)

iOS has simulated CTKD code that doesn't actually work due to platform limitations:

- Core Bluetooth framework only supports BLE
- No programmatic access to BT Classic pairing
- No access to A2DP/HFP audio profiles via public APIs
- All BT Classic connections must be done through Settings

The simulated code in `mobile/modules/core/ios/Source/sgcs/MentraLive.swift` (lines 2931-3088) should be removed.

### Why MFi Certification Won't Work

- MFi is **per-accessory hardware certification**, not per-app
- Requires MFi authentication chip in each glasses model
- Would break the open ecosystem (third-party glasses wouldn't work)
- High cost and time investment per device model

## Proposed Solution

### iOS Flow (Manual Pairing with Detection)

1. User selects Mentra Live
2. BLE scan shows devices
3. User taps device → BLE connects
4. **App detects audio not paired** → Shows audio pairing prompt
5. **"Pair Audio Now"** button → Opens iOS Settings to Bluetooth
6. User manually pairs "Mentra Live" in Settings
7. **App detects audio connection** → Shows success toast
8. User returns to app (automatic via app lifecycle)
9. Navigate to home

## Architecture

### Hybrid Approach: 70% Native, 30% React Native

```
┌─────────────────────────────────────────────────────────────┐
│                     React Native Layer                       │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  loading.tsx                                                  │
│  ├── Shows BLE pairing loader                                │
│  ├── Listens for "audio_pairing_needed" event               │
│  └── Shows <AudioPairingPrompt /> when needed                │
│                                                               │
│  AudioPairingPrompt.tsx                                       │
│  ├── Displays instructions                                   │
│  ├── "Open Settings" → BluetoothSettingsHelper.open()       │
│  └── Listens for "audio_connected" → Navigate home           │
│                                                               │
│  MantleBridge.tsx                                             │
│  └── Routes native events to GlobalEventEmitter              │
│                                                               │
└───────────────────────┬─────────────────────────────────────┘
                        │ Bridge Events
┌───────────────────────▼─────────────────────────────────────┐
│                      Native iOS Layer                         │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  MentraLive.swift                                             │
│  └── On BLE connect (line 540)                               │
│      ├── Check if audio already paired                       │
│      ├── If NOT → AudioSessionMonitor.startMonitoring()      │
│      └── Send Bridge.sendTypedMessage("audio_pairing_needed")│
│                                                               │
│  AudioSessionMonitor.swift (NEW)                              │
│  ├── Listen to AVAudioSession.routeChangeNotification        │
│  ├── Check currentRoute.outputs for Bluetooth devices        │
│  ├── Match device name pattern ("Mentra", "MENTRA_LIVE")    │
│  └── Send Bridge.sendTypedMessage("audio_connected")         │
│                                                               │
│  Bridge.swift                                                 │
│  └── sendTypedMessage() → CoreModule → MantleBridge          │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

### Why Hybrid?

**Consistent with existing patterns:**

- Android CTKD detection → **in MentraLive.java** (native)
- Event routing → **via Bridge** (native → RN)
- UI flow → **in pairing screens** (React Native)

**Separation of concerns:**

- **Native:** Hardware/OS integration (AVAudioSession monitoring)
- **React Native:** UI/UX flow (prompts, navigation, toasts)

**Minimal code duplication:**

- Same event names on both platforms
- React Native UI layer works for both platforms
- Platform-specific detection logic stays in native code

## Implementation Plan

### Phase 1: Native iOS Audio Detection

#### 1.1 Create AudioSessionMonitor.swift

**Location:** `mobile/modules/core/ios/Source/utils/AudioSessionMonitor.swift`

**Responsibilities:**

- Monitor `AVAudioSession.routeChangeNotification` for audio route changes
- Check `AVAudioSession.sharedInstance().currentRoute.outputs` for Bluetooth devices
- Detect specific device names matching pattern (e.g., "Mentra", "MENTRA_LIVE")
- Send events to Bridge when audio devices connect/disconnect
- Configure AVAudioSession for Bluetooth audio
- Set preferred audio output device via HFP routing
- Provide singleton instance for app-wide access

**Important Note on "Already Paired" Scenario:**
When we call `configureAudioSession()` with `.allowBluetooth` and `.allowBluetoothA2DP` options and activate the session, iOS populates `availableInputs` with **all paired Bluetooth devices**, even if they're not currently active. This means:

- We don't need to check if device is "just paired" vs "paired and active"
- We simply call `setAsPreferredAudioOutputDevice()` after configuring the session
- If device is in `availableInputs` (paired), we make it active automatically
- If device is NOT in `availableInputs` (not paired), we show the pairing prompt
- This gives the best UX: only prompts when truly needed!

**Key Methods:**

```swift
class AudioSessionMonitor {
    static func getInstance() -> AudioSessionMonitor
    func configureAudioSession() -> Bool  // Setup AVAudioSession for Bluetooth
    func isAudioDeviceConnected(devicePattern: String) -> Bool  // Check if active audio route
    func setAsPreferredAudioOutputDevice(devicePattern: String) -> Bool  // Make it active audio route
    func startMonitoring(devicePattern: String, callback: (Bool, String?) -> Void)
    func stopMonitoring()
}
```

**Implementation Detail for `isAudioDeviceConnected` (Optional - may not be needed):**

```swift
func isAudioDeviceConnected(devicePattern: String) -> Bool {
    // Check if device is the current active audio route
    let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
    return outputs.contains { output in
        (output.portType == .bluetoothA2DP || output.portType == .bluetoothHFP) &&
        output.portName.contains(devicePattern)
    }
}
```

**Note:** This method may not be strictly necessary since we rely on `setAsPreferredAudioOutputDevice()` returning success/failure. However, it can be useful for monitoring route changes.

**Implementation Detail for `setAsPreferredAudioOutputDevice`:**

```swift
func setAsPreferredAudioOutputDevice(devicePattern: String) -> Bool {
    do {
        let session = AVAudioSession.sharedInstance()

        // Find the Bluetooth HFP input matching our pattern
        guard let availableInputs = session.availableInputs else {
            Bridge.log("AudioMonitor: No available inputs")
            return false
        }

        // Look for Bluetooth HFP input (Mentra Live supports HFP)
        let bluetoothInput = availableInputs.first { input in
            input.portType == .bluetoothHFP &&
            input.portName.contains(devicePattern)
        }

        guard let btInput = bluetoothInput else {
            Bridge.log("AudioMonitor: Bluetooth HFP device '\(devicePattern)' not found")
            return false
        }

        // Set as preferred input - iOS automatically routes OUTPUT too
        try session.setPreferredInput(btInput)

        Bridge.log("AudioMonitor: ✅ Set '\(btInput.portName)' as preferred audio output device")
        return true

    } catch {
        Bridge.log("AudioMonitor: Failed to set preferred audio output device: \(error)")
        return false
    }
}

func configureAudioSession() -> Bool {
    do {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord,
                               mode: .default,
                               options: [.allowBluetooth, .allowBluetoothA2DP])
        try session.setActive(true)
        Bridge.log("AudioMonitor: AVAudioSession configured for Bluetooth")
        return true
    } catch {
        Bridge.log("AudioMonitor: Failed to configure AVAudioSession: \(error)")
        return false
    }
}
```

**How it works:**

- `setPreferredInput()` with a Bluetooth HFP device automatically routes both input AND output to that device
- Mentra Live supports HFP (confirmed in MentraLive.java line 3426: `enableHfpAudioServer()`)
- **Critical:** Calling `setCategory()` with `.allowBluetooth` and `.allowBluetoothA2DP`, then `setActive(true)`, causes iOS to populate `availableInputs` with ALL paired Bluetooth devices, even if not currently active
- This enables us to auto-activate paired devices without user intervention!

**Events Sent:**

- `audio_connected` - When matching Bluetooth audio device connects
- `audio_disconnected` - When matching Bluetooth audio device disconnects

**Estimated Lines:** ~130 lines (simpler than originally planned - no EAAccessoryManager)

#### 1.2 Integrate into MentraLive.swift

**Location:** `mobile/modules/core/ios/Source/sgcs/MentraLive.swift`

**Changes at line ~540 (after BLE connection):**

```swift
// After BLE connection established
if let deviceName = peripheral.name {
    Bridge.log("BLE connection established, setting up audio...")

    let monitor = AudioSessionMonitor.getInstance()

    // Configure audio session - this populates availableInputs with paired devices
    monitor.configureAudioSession()

    // Try to set as preferred audio device (works for both "active" and "paired but not active")
    let wasSet = monitor.setAsPreferredAudioOutputDevice(devicePattern: "Mentra")

    if wasSet {
        // Successfully set as preferred! Device is now active.
        Bridge.sendTypedMessage("audio_connected", body: [
            "device_name": deviceName
        ])
    } else {
        // Not found in availableInputs - not paired yet
        Bridge.sendTypedMessage("audio_pairing_needed", body: [
            "device_name": deviceName
        ])

        // Start monitoring for when user pairs manually
        monitor.startMonitoring(devicePattern: "Mentra") { connected, _ in
            if connected {
                // User paired it, now set as preferred output
                monitor.setAsPreferredAudioOutputDevice(devicePattern: "Mentra")
            }
        }
    }
}
```

**Changes at disconnect (line ~560):**

```swift
// On disconnect, stop monitoring
if isBtClassicConnected {
    AudioSessionMonitor.getInstance().stopMonitoring()
}
```

**Remove simulated CTKD code (lines 2931-3088)** - no longer needed

**Estimated Lines:** ~50 lines added, ~160 lines removed

#### 1.3 Update Bridge.swift

**Location:** `mobile/modules/core/ios/Source/Bridge.swift`

**Add helper methods (if needed):**

```swift
static func sendAudioPairingNeeded(deviceName: String) {
    let data = ["device_name": deviceName]
    sendTypedMessage("audio_pairing_needed", body: data)
}

static func sendAudioConnected(deviceName: String) {
    let data = ["device_name": deviceName]
    sendTypedMessage("audio_connected", body: data)
}
```

**Estimated Lines:** ~20 lines

### Phase 2: Android Parity Layer (Optional)

#### 2.1 Create AudioSessionMonitor.kt

**Location:** `mobile/modules/core/android/src/main/java/com/mentra/core/utils/AudioSessionMonitor.kt`

**Purpose:**

- Provide identical API to iOS version
- Wrap existing CTKD bonding detection
- Send same events for platform parity
- **Does NOT change Android UX** - just adds observability

**Key Methods:**

```kotlin
class AudioSessionMonitor {
    companion object {
        fun getInstance(context: Context): AudioSessionMonitor
    }
    fun isAudioDeviceConnected(deviceNamePattern: String): Boolean
    fun startMonitoring(deviceNamePattern: String, callback: (Boolean, String?) -> Unit)
    fun stopMonitoring()
}
```

**Implementation:**

- Monitors `BluetoothDevice.ACTION_BOND_STATE_CHANGED` (existing CTKD mechanism)
- Detects `BOND_BONDED` state for matching devices
- Sends `audio_connected` event (same as iOS)

**Android Flow (UNCHANGED UX):**

1. BLE connects
2. `createBond()` called (existing - line 773 in MentraLive.java)
3. OS shows "Pair with Mentra Live?" dialog (automatic)
4. User taps "Pair"
5. ✨ NEW: AudioSessionMonitor detects bond → sends event
6. Continue to home

**Estimated Lines:** ~150 lines

#### 2.2 Optional Integration into MentraLive.java

**Location:** `mobile/modules/core/android/src/main/java/com/mentra/core/sgcs/MentraLive.java`

**Changes at line ~773 (optional):**

```java
// After createBond() call
AudioSessionMonitor.getInstance(context).startMonitoring("Mentra", (connected, deviceName) -> {
    if (connected) {
        Bridge.log("LIVE: Audio connected via CTKD: " + deviceName);
        // Monitor sends event to RN automatically
    }
});
```

**Estimated Lines:** ~10 lines

### Phase 3: React Native UI Layer

#### 3.1 Update MantleBridge.tsx

**Location:** `mobile/src/bridge/MantleBridge.tsx`

**Add event handlers in parseDataFromCore() method (around line 100):**

```typescript
case "audio_pairing_needed":
  GlobalEventEmitter.emit("AUDIO_PAIRING_NEEDED", {
    deviceName: data.device_name,
  })
  break
case "audio_connected":
  GlobalEventEmitter.emit("AUDIO_CONNECTED", {
    deviceName: data.device_name,
  })
  break
case "audio_disconnected":
  GlobalEventEmitter.emit("AUDIO_DISCONNECTED", {
    deviceName: data.device_name,
  })
  break
```

**Estimated Lines:** ~15 lines

#### 3.2 Create BluetoothSettingsHelper.ts

**Location:** `mobile/src/utils/BluetoothSettingsHelper.ts`

**Purpose:**

- Open iOS Settings to Bluetooth page
- Platform checks and fallback handling

```typescript
import {Platform, Linking} from "react-native"

export class BluetoothSettingsHelper {
  static async openBluetoothSettings(): Promise<boolean> {
    if (Platform.OS === "ios") {
      try {
        await Linking.openURL("App-Prefs:Bluetooth")
        return true
      } catch (error) {
        console.error("Failed to open Bluetooth settings:", error)
        return false
      }
    }
    // Android doesn't need this - OS handles pairing
    return false
  }
}
```

**Estimated Lines:** ~20 lines

#### 3.3 Create AudioPairingPrompt.tsx

**Location:** `mobile/src/components/pairing/AudioPairingPrompt.tsx`

**Purpose:**

- Show instructions for manual BT pairing on iOS
- "Pair Audio Now" button to open Settings
- Optional "Skip" button for BLE-only mode
- Show step-by-step instructions

**UI Elements:**

1. Icon (volume/audio)
2. Heading: "Enable Audio Features"
3. Description: Why audio pairing is needed
4. Step-by-step instructions:
   - Tap "Pair Audio Now" below
   - Find "Mentra Live" in Other Devices
   - Tap to pair
   - Return to this app
5. "Pair Audio Now" button (primary)
6. "Skip for Now" button (optional, secondary)

**Estimated Lines:** ~100 lines

#### 3.4 Update loading.tsx

**Location:** `mobile/src/app/pairing/loading.tsx`

**Add state management:**

```typescript
const [needsAudioPairing, setNeedsAudioPairing] = useState(false)
const [audioConnected, setAudioConnected] = useState(false)
```

**Add event listeners:**

```typescript
useEffect(() => {
  // Listen for audio pairing needed (iOS only)
  const unsubscribe1 = GlobalEventEmitter.addListener("AUDIO_PAIRING_NEEDED", (event) => {
    if (Platform.OS === "ios") {
      setNeedsAudioPairing(true)
      setPairingInProgress(false) // Stop BLE loading
    }
  })

  // Listen for audio connected
  const unsubscribe2 = GlobalEventEmitter.addListener("AUDIO_CONNECTED", (event) => {
    setAudioConnected(true)
    setNeedsAudioPairing(false)
    Toast.show({
      type: "success",
      text1: "Audio Connected",
      text2: `Connected to ${event.deviceName}`,
    })
    // Continue to home
    replace("/(tabs)/home")
  })

  return () => {
    unsubscribe1()
    unsubscribe2()
  }
}, [])
```

**Add conditional render:**

```typescript
if (needsAudioPairing && Platform.OS === 'ios') {
  return (
    <Screen preset="fixed">
      <Header leftIcon="arrow-left" onLeftPress={handleForgetGlasses} />
      <AudioPairingPrompt
        glassesModelName={glassesModelName}
        onPairNow={() => {
          BluetoothSettingsHelper.openBluetoothSettings()
        }}
        onSkip={() => {
          // Optional: allow skip for BLE-only mode
          replace('/(tabs)/home')
        }}
      />
    </Screen>
  )
}
```

**Estimated Lines:** ~40 lines

## Platform Parity Summary

### Event Names (Identical on Both Platforms)

- `audio_pairing_needed` - Audio pairing required (iOS only in practice)
- `audio_connected` - Audio device connected
- `audio_disconnected` - Audio device disconnected

### API Surface (99.99% Identical)

**iOS:**

```swift
AudioSessionMonitor.getInstance()
    .isAudioDeviceConnected(devicePattern: "Mentra")
AudioSessionMonitor.getInstance()
    .startMonitoring(devicePattern: "Mentra") { connected, name in }
AudioSessionMonitor.getInstance()
    .stopMonitoring()
```

**Android:**

```kotlin
AudioSessionMonitor.getInstance(context)
    .isAudioDeviceConnected("Mentra")
AudioSessionMonitor.getInstance(context)
    .startMonitoring("Mentra") { connected, name -> }
AudioSessionMonitor.getInstance(context)
    .stopMonitoring()
```

### React Native Code (100% Shared)

All React Native code works identically on both platforms:

- MantleBridge event routing
- AudioPairingPrompt UI component
- loading.tsx flow logic
- BluetoothSettingsHelper (iOS-only functionality, no-op on Android)

## User Experience Comparison

| Step                  | Android                                 | iOS                                             |
| --------------------- | --------------------------------------- | ----------------------------------------------- |
| **1. Select glasses** | User selects Mentra Live                | User selects Mentra Live                        |
| **2. BLE scan**       | Shows available devices                 | Shows available devices                         |
| **3. BLE connect**    | Automatic via `createBond()`            | Automatic via Core Bluetooth                    |
| **4. Audio check**    | ✅ OS dialog shows automatically        | ✅ Auto-activates if already paired             |
| **5. User action**    | Tap "Pair" in OS dialog (if not bonded) | Tap "Pair Audio Now" → Settings (if not paired) |
| **6. Audio connect**  | Automatic (CTKD)                        | Auto-activated via setPreferredInput            |
| **7. Confirmation**   | Continue to home                        | Continue to home                                |
| **UX Quality**        | Seamless (1 tap if not bonded)          | Good (seamless if paired, 2-3 taps if not)      |

**Platform Limitation:** iOS requires manual pairing due to lack of CTKD/BT Classic API access. This is the best possible UX given iOS restrictions.

## Implementation Checklist

### Phase 1: Native iOS (Required)

- [ ] Create `AudioSessionMonitor.swift` (~150 lines)
- [ ] Integrate into `MentraLive.swift` (~50 lines added, ~160 removed)
- [ ] Update `Bridge.swift` with helper methods (~20 lines)
- [ ] Test BLE connection triggers audio detection
- [ ] Test manual BT pairing is detected
- [ ] Test audio disconnection is detected

### Phase 2: Android Parity (Optional)

- [ ] Create `AudioSessionMonitor.kt` (~150 lines)
- [ ] Optionally integrate into `MentraLive.java` (~10 lines)
- [ ] Test CTKD bonding sends events
- [ ] Verify Android UX unchanged (still shows OS dialog)

### Phase 3: React Native (Required)

- [ ] Update `MantleBridge.tsx` event routing (~15 lines)
- [ ] Create `BluetoothSettingsHelper.ts` (~20 lines)
- [ ] Create `AudioPairingPrompt.tsx` component (~100 lines)
- [ ] Update `loading.tsx` with audio pairing flow (~40 lines)
- [ ] Test iOS flow end-to-end
- [ ] Test Android flow unchanged
- [ ] Test both platforms show success toast

### Testing

#### iOS Scenarios

- [ ] **Fresh pairing:** BLE connects → Audio prompt shows → User pairs → Device auto-activated → Navigate home
- [ ] **Already paired and active:** Device is current audio output → BLE connects → Auto-detected → Navigate home (no prompt!)
- [ ] **Already paired but not active:** Device paired but not active → BLE connects → Auto-activated via setAsPreferredAudioOutputDevice → Navigate home (no prompt!)
- [ ] **Open Settings:** "Pair Audio Now" button opens Settings to Bluetooth page
- [ ] **Manual pairing detection:** User pairs in Settings → App detects → Auto-activated → Shows toast → Navigate home
- [ ] **Audio disconnect:** Active device disconnects → Event detected
- [ ] **setAsPreferredAudioOutputDevice:** Successfully activates paired devices from availableInputs
- [ ] **availableInputs population:** After configureAudioSession(), paired devices appear in availableInputs

#### Android Scenarios

- [ ] **Fresh pairing:** BLE connects → OS dialog shows → User pairs → Navigate home
- [ ] **Already bonded:** Device already bonded → BLE connects → Skip prompt → Navigate home
- [ ] **Events sent:** CTKD bonding sends audio_connected event (optional feature)

#### Cross-Platform

- [ ] Both platforms show success toast on audio connection
- [ ] Both platforms handle audio disconnect gracefully
- [ ] React Native UI works identically on both platforms

## Estimated Effort

| Component                  | Lines of Code  | Complexity | Time Estimate   |
| -------------------------- | -------------- | ---------- | --------------- |
| AudioSessionMonitor.swift  | ~130           | Medium     | 3 hours         |
| MentraLive.swift changes   | ~50 net        | Low        | 1 hour          |
| Bridge.swift changes       | ~20            | Low        | 30 min          |
| AudioSessionMonitor.kt     | ~150           | Medium     | 2-3 hours       |
| MantleBridge.tsx           | ~15            | Low        | 30 min          |
| AudioPairingPrompt.tsx     | ~100           | Low        | 2 hours         |
| loading.tsx changes        | ~40            | Low        | 1 hour          |
| BluetoothSettingsHelper.ts | ~20            | Low        | 30 min          |
| Testing                    | -              | -          | 4 hours         |
| **Total**                  | **~525 lines** | **Medium** | **14-16 hours** |

## Risks & Mitigations

### Risk 1: Paired devices might not appear in availableInputs

**Mitigation:** After calling `setCategory()` with `.allowBluetooth` and `.allowBluetoothA2DP`, then `setActive(true)`, iOS reliably populates `availableInputs` with all paired Bluetooth devices. This is well-documented iOS behavior. If a device doesn't appear, it's genuinely not paired.

### Risk 2: Users confused by manual pairing step on iOS

**Mitigation:** Clear UI instructions with step-by-step guide. This is standard practice for iOS apps requiring BT Classic audio (headphones, speakers, etc.).

### Risk 3: Settings deep link might not work on all iOS versions

**Mitigation:** `App-Prefs:` URLs work on iOS 10+. Fallback to generic Settings app if Bluetooth-specific deep link fails.

### Risk 4: Android UX accidentally changed

**Mitigation:** AudioSessionMonitor on Android is purely observational. It doesn't call `createBond()` or interfere with existing CTKD flow.

## Success Criteria

### Functional Requirements

✅ iOS detects when BT audio pairing is needed
✅ iOS detects when BT audio device connects
✅ iOS shows clear instructions for manual pairing
✅ iOS opens Settings to Bluetooth page
✅ Android UX unchanged (still auto-shows pairing dialog)
✅ Both platforms send identical events to React Native
✅ React Native UI works on both platforms

### Non-Functional Requirements

✅ Native code follows existing patterns (Bridge, SGCManager)
✅ React Native code uses existing components (Screen, Header, Toast)
✅ Platform parity: 99.99% identical API between iOS and Android
✅ No breaking changes to existing Android flow
✅ Code is maintainable and well-documented

## Future Enhancements

### Phase 4: Enhanced UX (Optional)

- In-app Bluetooth settings (if iOS adds APIs in future)
- Audio quality indicators (AAC vs SBC codec detection)
- Automatic retry logic if pairing fails
- Battery level display for BT audio connection

### Phase 5: Analytics (Optional)

- Track audio pairing success rate
- Track time to complete pairing
- Track skip rate (if skip button provided)
- Platform-specific metrics (iOS vs Android)

## References

### Apple Documentation

- [AVAudioSession](https://developer.apple.com/documentation/avfoundation/avaudiosession)
- [AVAudioSession.RouteChangeNotification](https://developer.apple.com/documentation/avfoundation/avaudiosession/1616493-routechangenotification)
- [URL Schemes](https://developer.apple.com/library/archive/featuredarticles/iPhoneURLScheme_Reference/Introduction/Introduction.html)

### Android Documentation

- [BluetoothDevice.ACTION_BOND_STATE_CHANGED](https://developer.android.com/reference/android/bluetooth/BluetoothDevice#ACTION_BOND_STATE_CHANGED)
- [CTKD Overview](https://source.android.com/docs/core/connect/bluetooth/ctkd)

### Existing Code References

- MentraLive.java CTKD implementation: Lines 770-773, 3031-3151
- MentraLive.swift simulated CTKD: Lines 2931-3088 (to be removed)
- Bridge pattern: `mobile/modules/core/ios/Source/Bridge.swift`
- Event routing: `mobile/src/bridge/MantleBridge.tsx`
