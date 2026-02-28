# iOS CTKD Resolution Plan

## Problem Statement

CTKD (Cross-Transport Key Derivation) allows BES devices to establish both BLE and BT Classic connections simultaneously through a single pairing action. This works automatically on Android but has platform limitations on iOS.

### Current State

**Android (CTKD Native):**

- BLE connection established → `createBond()` called → OS establishes both BLE + BT Classic automatically
- One-tap connection for users
- Fully functional

**iOS (Currently Broken):**

- BLE connection works fine
- CTKD implementation "simulates" BT Classic bonding with fake delays
- Sets `isBtClassicConnected = true` without actually connecting
- Sends messages to void that nothing handles
- **BT Classic never actually connects**

### iOS Platform Limitations

iOS Core Bluetooth API:

- ✅ Full support for BLE (works great)
- ❌ No public API to initiate BT Classic pairing
- ❌ No API to discover unpaired BT Classic devices
- ❌ No equivalent to `NEHotspotConfiguration` for Bluetooth
- ✅ Can detect when BT audio is connected via `AVAudioSession`

The **only** way to pair BT Classic audio on iOS:

1. User manually pairs in Settings > Bluetooth
2. MFi certification (requires Apple hardware chip, $$$, months of certification)
3. Proximity pairing (requires W1/H1 chip like AirPods)

---

## Solution Architecture

### Approach: Guided Manual Pairing with Smart Detection

Since we can't automate pairing, we make the manual process:

1. **Detectable** - Know when pairing is needed vs. already done
2. **Guided** - Clear, visual instructions
3. **Seamless** - Auto-detect completion, one-time setup
4. **Generalized** - Works for any smart glasses with BLE + BT audio

### High-Level Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    User Taps "Connect"                      │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│              iOS: Initiate BLE Connection                   │
│              (Standard Core Bluetooth Flow)                 │
└─────────────────────────────────────────────────────────────┘
                            ↓
                    ┌───────────────┐
                    │ BLE Connected │
                    └───────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│          Check: Is BT Classic Audio Connected?              │
│         (Query AVAudioSession current route)                │
└─────────────────────────────────────────────────────────────┘
                            ↓
                ┌───────────┴───────────┐
                │                       │
         ✅ Yes, Connected      ❌ No, Not Connected
                │                       │
                ↓                       ↓
    ┌─────────────────────┐  ┌──────────────────────────┐
    │ Notify: Fully Ready │  │ Check: Have we shown     │
    │  (BLE + BT Classic) │  │  pairing guide before?   │
    └─────────────────────┘  └──────────────────────────┘
                                        ↓
                            ┌───────────┴───────────┐
                            │                       │
                    Yes, Skip Guide        No, First Time
                            │                       │
                            ↓                       ↓
                ┌─────────────────────┐  ┌──────────────────────┐
                │ Show subtle banner: │  │ Show full pairing    │
                │ "Tap to enable      │  │ guide with visuals   │
                │  audio features"    │  │ and instructions     │
                └─────────────────────┘  └──────────────────────┘
                            │                       │
                            └───────────┬───────────┘
                                        ↓
                            ┌───────────────────────┐
                            │ User Taps Guide       │
                            │ → Open Settings       │
                            └───────────────────────┘
                                        ↓
                            ┌───────────────────────┐
                            │ iOS Settings Opens    │
                            │ User pairs device     │
                            └───────────────────────┘
                                        ↓
                            ┌───────────────────────┐
                            │ User returns to app   │
                            │ (willEnterForeground) │
                            └───────────────────────┘
                                        ↓
                            ┌───────────────────────┐
                            │ Re-check BT audio     │
                            │ (AVAudioSession)      │
                            └───────────────────────┘
                                        ↓
                                ┌───────┴────────┐
                                │                │
                        Connected?        Not yet?
                                │                │
                                ↓                ↓
                    ┌─────────────────┐  ┌──────────────┐
                    │ 🎉 Celebrate!   │  │ Show hint:   │
                    │ Save preference │  │ "Still need  │
                    │ Both connected  │  │  to pair"    │
                    └─────────────────┘  └──────────────┘
```

---

## Detailed Component Design

### 1. Native iOS Module: `BluetoothAudioManager`

**Purpose:** Bridge between iOS AVAudioSession and React Native

**Responsibilities:**

- Check if BT audio is currently connected
- Monitor audio route changes
- Identify if connected audio matches smart glasses
- Notify React Native of connection state changes

**Interface (Generalized):**

```swift
// BluetoothAudioManager.swift
import AVFoundation
import React

@objc(BluetoothAudioManager)
class BluetoothAudioManager: RCTEventEmitter {

    // MARK: - Configuration

    /// Device patterns to match for smart glasses
    /// Can be configured per glasses type
    private var devicePatterns: [String] = []

    // MARK: - State

    private var isMonitoring = false
    private var lastDetectedDevice: String?

    // MARK: - Public API

    /**
     * Configure device patterns to match
     * Example: ["Mentra", "Even Realities", "RayBan"]
     */
    @objc
    func configureDevicePatterns(_ patterns: [String]) {
        devicePatterns = patterns
        RCTLog("BluetoothAudioManager: Configured patterns: \(patterns)")
    }

    /**
     * Check if BT Classic audio is currently connected
     * Returns: { connected: bool, deviceName: string? }
     */
    @objc
    func checkBluetoothAudioConnection(
        _ resolve: @escaping RCTPromiseResolveBlock,
        rejecter reject: @escaping RCTPromiseRejectBlock
    ) {
        let result = getCurrentBluetoothAudioDevice()
        resolve([
            "connected": result.connected,
            "deviceName": result.deviceName ?? NSNull()
        ])
    }

    /**
     * Start monitoring for audio route changes
     */
    @objc
    func startMonitoring() {
        guard !isMonitoring else { return }

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAudioRouteChange),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )

        isMonitoring = true
        RCTLog("BluetoothAudioManager: Started monitoring")
    }

    /**
     * Stop monitoring
     */
    @objc
    func stopMonitoring() {
        NotificationCenter.default.removeObserver(
            self,
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )

        isMonitoring = false
        RCTLog("BluetoothAudioManager: Stopped monitoring")
    }

    // MARK: - Events (sent to React Native)

    override func supportedEvents() -> [String]! {
        return [
            "bluetoothAudioConnected",
            "bluetoothAudioDisconnected",
            "bluetoothAudioDeviceChanged"
        ]
    }

    // MARK: - Internal

    @objc
    private func handleAudioRouteChange(notification: Notification) {
        guard let userInfo = notification.userInfo,
              let reasonValue = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else {
            return
        }

        let result = getCurrentBluetoothAudioDevice()

        switch reason {
        case .newDeviceAvailable:
            if result.connected {
                sendEvent(withName: "bluetoothAudioConnected", body: [
                    "deviceName": result.deviceName ?? NSNull()
                ])
            }

        case .oldDeviceUnavailable:
            if !result.connected && lastDetectedDevice != nil {
                sendEvent(withName: "bluetoothAudioDisconnected", body: [
                    "deviceName": lastDetectedDevice ?? NSNull()
                ])
            }

        default:
            break
        }

        lastDetectedDevice = result.deviceName
    }

    private func getCurrentBluetoothAudioDevice() -> (connected: Bool, deviceName: String?) {
        let audioSession = AVAudioSession.sharedInstance()
        let currentRoute = audioSession.currentRoute

        for output in currentRoute.outputs {
            // Check for Bluetooth audio types
            if output.portType == .bluetoothA2DP ||
               output.portType == .bluetoothHFP ||
               output.portType == .bluetoothLE {

                // Check if device name matches any configured pattern
                let deviceName = output.portName

                if devicePatterns.isEmpty {
                    // No patterns configured, accept any BT audio
                    return (true, deviceName)
                }

                for pattern in devicePatterns {
                    if deviceName.lowercased().contains(pattern.lowercased()) {
                        return (true, deviceName)
                    }
                }
            }
        }

        return (false, nil)
    }

    @objc
    static override func requiresMainQueueSetup() -> Bool {
        return true
    }
}
```

---

### 2. Native iOS Module Bridge

```objc
// BluetoothAudioManager.m
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(BluetoothAudioManager, RCTEventEmitter)

RCT_EXTERN_METHOD(configureDevicePatterns:(NSArray *)patterns)

RCT_EXTERN_METHOD(checkBluetoothAudioConnection:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(startMonitoring)

RCT_EXTERN_METHOD(stopMonitoring)

@end
```

---

### 3. React Native Hook: `useBluetoothAudio`

**Purpose:** Provide React Native components with BT audio state and controls

```typescript
// mobile/src/hooks/useBluetoothAudio.ts
import {useEffect, useState, useCallback} from "react"
import {NativeModules, NativeEventEmitter, Platform} from "react-native"
import AsyncStorage from "@react-native-async-storage/async-storage"

const {BluetoothAudioManager} = NativeModules
const bluetoothAudioEmitter = Platform.OS === "ios" ? new NativeEventEmitter(BluetoothAudioManager) : null

const STORAGE_KEY_PAIRING_GUIDE_SHOWN = "@bluetooth_audio_pairing_guide_shown"

export interface BluetoothAudioState {
  isConnected: boolean
  deviceName: string | null
  isChecking: boolean
}

export interface BluetoothAudioControls {
  checkConnection: () => Promise<void>
  hasPairingGuideBeenShown: boolean
  markPairingGuideShown: () => Promise<void>
  resetPairingGuide: () => Promise<void>
}

export function useBluetoothAudio(devicePatterns?: string[]): [BluetoothAudioState, BluetoothAudioControls] {
  const [state, setState] = useState<BluetoothAudioState>({
    isConnected: false,
    deviceName: null,
    isChecking: false,
  })

  const [hasPairingGuideBeenShown, setHasPairingGuideBeenShown] = useState(false)

  // Configure device patterns on mount
  useEffect(() => {
    if (Platform.OS === "ios" && devicePatterns) {
      BluetoothAudioManager.configureDevicePatterns(devicePatterns)
    }
  }, [devicePatterns])

  // Check if pairing guide has been shown
  useEffect(() => {
    ;(async () => {
      try {
        const shown = await AsyncStorage.getItem(STORAGE_KEY_PAIRING_GUIDE_SHOWN)
        setHasPairingGuideBeenShown(shown === "true")
      } catch (error) {
        console.error("Failed to check pairing guide status:", error)
      }
    })()
  }, [])

  // Check current connection status
  const checkConnection = useCallback(async () => {
    if (Platform.OS !== "ios") {
      return
    }

    setState(prev => ({...prev, isChecking: true}))

    try {
      const result = await BluetoothAudioManager.checkBluetoothAudioConnection()
      setState({
        isConnected: result.connected,
        deviceName: result.deviceName || null,
        isChecking: false,
      })
    } catch (error) {
      console.error("Failed to check Bluetooth audio connection:", error)
      setState(prev => ({...prev, isChecking: false}))
    }
  }, [])

  // Mark pairing guide as shown
  const markPairingGuideShown = useCallback(async () => {
    try {
      await AsyncStorage.setItem(STORAGE_KEY_PAIRING_GUIDE_SHOWN, "true")
      setHasPairingGuideBeenShown(true)
    } catch (error) {
      console.error("Failed to mark pairing guide as shown:", error)
    }
  }, [])

  // Reset pairing guide (for testing/debugging)
  const resetPairingGuide = useCallback(async () => {
    try {
      await AsyncStorage.removeItem(STORAGE_KEY_PAIRING_GUIDE_SHOWN)
      setHasPairingGuideBeenShown(false)
    } catch (error) {
      console.error("Failed to reset pairing guide:", error)
    }
  }, [])

  // Monitor for connection changes
  useEffect(() => {
    if (Platform.OS !== "ios" || !bluetoothAudioEmitter) {
      return
    }

    BluetoothAudioManager.startMonitoring()

    const connectedListener = bluetoothAudioEmitter.addListener(
      "bluetoothAudioConnected",
      (event: {deviceName?: string}) => {
        setState({
          isConnected: true,
          deviceName: event.deviceName || null,
          isChecking: false,
        })
      },
    )

    const disconnectedListener = bluetoothAudioEmitter.addListener("bluetoothAudioDisconnected", () => {
      setState({
        isConnected: false,
        deviceName: null,
        isChecking: false,
      })
    })

    return () => {
      connectedListener.remove()
      disconnectedListener.remove()
      BluetoothAudioManager.stopMonitoring()
    }
  }, [])

  // Check connection on mount and when app comes to foreground
  useEffect(() => {
    checkConnection()
  }, [checkConnection])

  return [
    state,
    {
      checkConnection,
      hasPairingGuideBeenShown,
      markPairingGuideShown,
      resetPairingGuide,
    },
  ]
}
```

---

### 4. React Native Component: `BluetoothAudioPairingGuide`

**Purpose:** Display pairing instructions when needed

```typescript
// mobile/src/components/glasses/BluetoothAudioPairingGuide.tsx
import React from 'react';
import { View, Text, TouchableOpacity, Linking, Platform, StyleSheet } from 'react-native';

export interface BluetoothAudioPairingGuideProps {
  visible: boolean;
  deviceName: string;
  onDismiss: () => void;
  onOpenSettings: () => void;
  fullGuide?: boolean; // Show full guide vs. subtle banner
}

export function BluetoothAudioPairingGuide({
  visible,
  deviceName,
  onDismiss,
  onOpenSettings,
  fullGuide = true,
}: BluetoothAudioPairingGuideProps) {

  if (!visible || Platform.OS !== 'ios') {
    return null;
  }

  const handleOpenSettings = () => {
    Linking.openSettings();
    onOpenSettings();
  };

  if (!fullGuide) {
    // Subtle banner for users who have seen guide before
    return (
      <TouchableOpacity
        style={styles.banner}
        onPress={handleOpenSettings}
      >
        <Text style={styles.bannerText}>
          Tap to enable audio features
        </Text>
        <Text style={styles.bannerArrow}>→</Text>
      </TouchableOpacity>
    );
  }

  // Full guide for first-time users
  return (
    <View style={styles.overlay}>
      <View style={styles.guideContainer}>
        <Text style={styles.title}>One More Step!</Text>

        <Text style={styles.description}>
          Your glasses are connected for controls, but need audio pairing for sound features.
        </Text>

        <View style={styles.steps}>
          <Step number={1}>
            Tap "Open Settings" below
          </Step>

          <Step number={2}>
            Look for "{deviceName}" under "Other Devices"
          </Step>

          <Step number={3}>
            Tap the device name to connect
          </Step>

          <Step number={4}>
            Return to this app - you're all set! 🎉
          </Step>
        </View>

        <TouchableOpacity
          style={styles.primaryButton}
          onPress={handleOpenSettings}
        >
          <Text style={styles.primaryButtonText}>Open Settings</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={onDismiss}
        >
          <Text style={styles.secondaryButtonText}>Skip for now</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function Step({ number, children }: { number: number; children: string }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepNumber}>
        <Text style={styles.stepNumberText}>{number}</Text>
      </View>
      <Text style={styles.stepText}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  guideContainer: {
    backgroundColor: 'white',
    borderRadius: 16,
    padding: 24,
    margin: 20,
    maxWidth: 400,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    marginBottom: 12,
    textAlign: 'center',
  },
  description: {
    fontSize: 16,
    color: '#666',
    marginBottom: 24,
    textAlign: 'center',
    lineHeight: 22,
  },
  steps: {
    marginBottom: 24,
  },
  step: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  stepNumber: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  stepNumberText: {
    color: 'white',
    fontWeight: 'bold',
    fontSize: 16,
  },
  stepText: {
    flex: 1,
    fontSize: 16,
    lineHeight: 24,
    paddingTop: 4,
  },
  primaryButton: {
    backgroundColor: '#007AFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
  },
  primaryButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  secondaryButton: {
    padding: 12,
  },
  secondaryButtonText: {
    color: '#666',
    fontSize: 16,
    textAlign: 'center',
  },
  banner: {
    backgroundColor: '#007AFF',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    marginHorizontal: 16,
    marginVertical: 8,
    borderRadius: 12,
  },
  bannerText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '500',
  },
  bannerArrow: {
    color: 'white',
    fontSize: 20,
  },
});
```

---

### 5. Integration Component: `SmartGlassesConnection`

**Purpose:** Orchestrate BLE + BT audio connection flow

```typescript
// mobile/src/components/glasses/SmartGlassesConnection.tsx
import React, { useEffect, useState } from 'react';
import { View, Platform } from 'react-native';
import { useBluetoothAudio } from '@/hooks/useBluetoothAudio';
import { BluetoothAudioPairingGuide } from './BluetoothAudioPairingGuide';
import { useAugmentOSStatus } from '@/hooks/useAugmentOSStatus';

export interface SmartGlassesConnectionProps {
  devicePatterns: string[]; // e.g., ["Mentra", "XyGlass"]
  onFullyConnected?: () => void;
  onConnectionStateChange?: (state: ConnectionState) => void;
}

export interface ConnectionState {
  bleConnected: boolean;
  btAudioConnected: boolean;
  isFullyConnected: boolean;
}

export function SmartGlassesConnection({
  devicePatterns,
  onFullyConnected,
  onConnectionStateChange,
}: SmartGlassesConnectionProps) {

  const { status } = useAugmentOSStatus();
  const [btAudioState, btAudioControls] = useBluetoothAudio(devicePatterns);

  const [showPairingGuide, setShowPairingGuide] = useState(false);
  const [wasFullyConnectedBefore, setWasFullyConnectedBefore] = useState(false);

  // Track connection state
  const bleConnected = status.core_info?.is_connected || false;
  const btAudioConnected = Platform.OS === 'android' || btAudioState.isConnected;
  const isFullyConnected = bleConnected && btAudioConnected;

  // Notify parent of connection state changes
  useEffect(() => {
    onConnectionStateChange?.({
      bleConnected,
      btAudioConnected,
      isFullyConnected,
    });
  }, [bleConnected, btAudioConnected, isFullyConnected, onConnectionStateChange]);

  // Handle full connection event
  useEffect(() => {
    if (isFullyConnected && !wasFullyConnectedBefore) {
      setWasFullyConnectedBefore(true);
      onFullyConnected?.();
      setShowPairingGuide(false);
    }
  }, [isFullyConnected, wasFullyConnectedBefore, onFullyConnected]);

  // Show pairing guide when BLE connected but BT audio not connected (iOS only)
  useEffect(() => {
    if (Platform.OS !== 'ios') {
      return;
    }

    if (bleConnected && !btAudioConnected) {
      // Check connection status
      btAudioControls.checkConnection();

      // Show guide if needed
      if (!btAudioState.isConnected) {
        setShowPairingGuide(true);
      }
    } else if (isFullyConnected) {
      setShowPairingGuide(false);
    }
  }, [bleConnected, btAudioConnected, btAudioState.isConnected]);

  // Re-check BT audio when app comes to foreground
  useEffect(() => {
    if (Platform.OS !== 'ios') {
      return;
    }

    const subscription = /* AppState listener */;
    return () => subscription?.remove();
  }, []);

  const handleDismissPairingGuide = () => {
    setShowPairingGuide(false);
    btAudioControls.markPairingGuideShown();
  };

  const handleOpenSettings = () => {
    btAudioControls.markPairingGuideShown();
  };

  return (
    <>
      {/* Your normal connection UI */}

      {/* iOS BT audio pairing guide */}
      <BluetoothAudioPairingGuide
        visible={showPairingGuide}
        deviceName={status.glasses_info?.bluetooth_name || 'your glasses'}
        onDismiss={handleDismissPairingGuide}
        onOpenSettings={handleOpenSettings}
        fullGuide={!btAudioControls.hasPairingGuideBeenShown}
      />
    </>
  );
}
```

---

### 6. Update iOS MentraLive.swift

**Purpose:** Replace fake CTKD simulation with real BT audio detection

```swift
// core/ios/Source/sgcs/MentraLive.swift

// MARK: - CTKD Implementation for iOS

/**
 * iOS CTKD Flow:
 * 1. BLE connects automatically (Core Bluetooth)
 * 2. Check if BT Classic audio is connected (AVAudioSession)
 * 3. If not, notify React Native to prompt user
 * 4. Monitor for BT audio connection
 * 5. Notify when both connections are established
 */

private func initiateCtkdBonding(deviceName: String) {
    // Check if this is a BES device that supports CTKD
    let besDevicePatterns = [
        "MENTRA_LIVE_BLE",
        "MENTRA_LIVE_BT",
        "XyBLE_",
        "Xy_A",
    ]

    let isBesDevice = besDevicePatterns.contains { pattern in
        deviceName.hasPrefix(pattern)
    }

    if isBesDevice {
        Bridge.log("CTKD: Detected BES device '\(deviceName)'")
        ctkdSupported = true

        // Check current BT audio status
        checkBtClassicAudioConnection()

        if !isBtClassicConnected {
            // Notify React Native that BT audio pairing is needed
            notifyBtAudioPairingNeeded()
        } else {
            // Already connected
            notifyCtkdBondingComplete()
        }

        // Start monitoring for changes
        startMonitoringAudioRouteChanges()
    } else {
        Bridge.log("CTKD: Device '\(deviceName)' does not support CTKD")
        ctkdSupported = false
    }
}

private func checkBtClassicAudioConnection() {
    let audioSession = AVAudioSession.sharedInstance()
    let currentRoute = audioSession.currentRoute

    for output in currentRoute.outputs {
        if output.portType == .bluetoothA2DP ||
           output.portType == .bluetoothHFP {

            if let deviceName = connectedPeripheral?.name,
               output.portName.contains(deviceName) ||
               output.portName.contains("Mentra") {

                Bridge.log("CTKD: BT Classic audio connected: \(output.portName)")
                isBtClassicConnected = true
                return
            }
        }
    }

    Bridge.log("CTKD: BT Classic audio not connected")
    isBtClassicConnected = false
}

private func notifyBtAudioPairingNeeded() {
    let eventBody: [String: Any] = [
        "ctkd_audio_pairing_needed": [
            "device_name": connectedPeripheral?.name ?? "Unknown",
            "platform": "ios",
            "ble_connected": true,
            "bt_classic_connected": false,
        ]
    ]
    Bridge.sendTypedMessage("ctkd_audio_pairing_needed", body: eventBody)
}

private func notifyCtkdBondingComplete() {
    let eventBody: [String: Any] = [
        "ctkd_bonding_complete": [
            "device_name": connectedPeripheral?.name ?? "Unknown",
            "platform": "ios",
            "ble_connected": true,
            "bt_classic_connected": isBtClassicConnected,
            "bond_state": "BONDED"
        ]
    ]
    Bridge.sendTypedMessage("ctkd_bonding_complete", body: eventBody)
}

private func startMonitoringAudioRouteChanges() {
    NotificationCenter.default.addObserver(
        self,
        selector: #selector(handleAudioRouteChange),
        name: AVAudioSession.routeChangeNotification,
        object: nil
    )
}

@objc private func handleAudioRouteChange(notification: Notification) {
    guard let userInfo = notification.userInfo,
          let reasonValue = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
          let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else {
        return
    }

    let wasConnected = isBtClassicConnected
    checkBtClassicAudioConnection()

    if isBtClassicConnected && !wasConnected {
        // Just connected
        Bridge.log("CTKD: BT Classic audio just connected")
        notifyCtkdBondingComplete()
    } else if !isBtClassicConnected && wasConnected {
        // Just disconnected
        Bridge.log("CTKD: BT Classic audio disconnected")
        notifyBtAudioPairingNeeded()
    }
}

private func cleanupCtkdConnection() {
    NotificationCenter.default.removeObserver(
        self,
        name: AVAudioSession.routeChangeNotification,
        object: nil
    )

    isBtClassicConnected = false
    ctkdSupported = false
}
```

---

## Implementation Steps

### Phase 1: Native Module Foundation

1. Create `BluetoothAudioManager.swift` in `mobile/ios/`
2. Create `BluetoothAudioManager.m` bridge file
3. Add to Xcode project
4. Test basic functionality with React Native

### Phase 2: React Native Infrastructure

1. Create `useBluetoothAudio` hook
2. Create `BluetoothAudioPairingGuide` component
3. Add TypeScript types for all interfaces
4. Test components in isolation

### Phase 3: iOS Core Integration

1. Update `MentraLive.swift` to remove fake CTKD
2. Add real BT audio detection
3. Add audio route monitoring
4. Test with actual hardware

### Phase 4: React Native Integration

1. Create `SmartGlassesConnection` orchestrator component
2. Wire up to existing connection flow
3. Add AsyncStorage for pairing guide state
4. Test full flow end-to-end

### Phase 5: UX Polish

1. Add animations for pairing guide
2. Add haptic feedback for connection success
3. Add celebratory animation when fully connected
4. Test with real users

### Phase 6: Testing & Documentation

1. Unit tests for native module
2. Integration tests for React Native components
3. Manual testing with real glasses
4. Update user documentation
5. Add troubleshooting guide

---

## Generalization Strategy

### Device Configuration System

Allow any smart glasses to register their BT audio patterns:

```typescript
// mobile/src/config/smartGlassesConfig.ts
export interface SmartGlassesConfig {
  id: string
  name: string
  btAudioPatterns: string[] // Patterns to match BT audio device name
  bleNamePatterns: string[] // Patterns to match BLE device name
  supportsCTKD: boolean
  requiresBtAudio: boolean
}

export const SMART_GLASSES_CONFIGS: SmartGlassesConfig[] = [
  {
    id: "mentra-live",
    name: "Mentra Live",
    btAudioPatterns: ["Mentra", "MENTRA_LIVE"],
    bleNamePatterns: ["Mentra_Live", "MENTRA_LIVE_BLE"],
    supportsCTKD: true,
    requiresBtAudio: true,
  },
  {
    id: "even-realities-g1",
    name: "Even Realities G1",
    btAudioPatterns: ["Even Realities", "G1"],
    bleNamePatterns: ["Even_G1", "G1_BLE"],
    supportsCTKD: false,
    requiresBtAudio: false,
  },
  // Future glasses can be added here
]

export function getGlassesConfig(deviceName: string): SmartGlassesConfig | null {
  return SMART_GLASSES_CONFIGS.find(config =>
    config.bleNamePatterns.some(pattern => deviceName.toLowerCase().includes(pattern.toLowerCase())),
  )
}
```

### Usage in Components

```typescript
// Auto-detect glasses type and apply configuration
const detectedGlasses = getGlassesConfig(status.glasses_info?.bluetooth_name || "")

if (detectedGlasses?.supportsCTKD && detectedGlasses?.requiresBtAudio) {
  // Show BT audio pairing guide
}
```

---

## Success Metrics

### Technical Metrics

- ✅ BT audio detection accuracy: >99%
- ✅ Connection detection latency: <1s
- ✅ Pairing guide shown only when needed: 100%
- ✅ Auto-reconnection works: >95%

### User Experience Metrics

- ✅ Users complete pairing on first attempt: >80%
- ✅ Users understand what to do: >90%
- ✅ Users see pairing guide only once: >95%
- ✅ Support tickets about pairing: <5% of users

---

## Known Limitations

1. **Cannot detect paired-but-not-connected devices**
   - iOS only tells us about currently connected audio
   - Can't check if device is paired but not active

2. **Device name matching may be imprecise**
   - iOS sanitizes Bluetooth device names
   - May show slightly different name than expected

3. **User must manually pair first time**
   - No way around iOS platform limitation
   - Best we can do is guide them through it

4. **Audio route may change unexpectedly**
   - User may connect other BT headphones
   - Need to handle switching between devices

---

## Future Enhancements

1. **Visual pairing tutorial video/GIF**
   - Embed 10-second video showing pairing process
   - May improve completion rate

2. **Better device name detection**
   - Try to extract device serial/ID from BLE
   - Match more precisely against BT audio name

3. **Deep link to Bluetooth settings** (if Apple allows)
   - Currently `openSettings()` goes to main Settings
   - Would be better to go directly to Bluetooth

4. **Proactive re-pairing detection**
   - Detect when user unpairs device
   - Offer to guide them to re-pair

5. **Analytics integration**
   - Track pairing success/failure rates
   - Identify where users get stuck
   - A/B test different instruction wording

---

## Testing Plan

### Unit Tests

- Native module: BT audio detection
- React hooks: State management
- Components: Rendering logic

### Integration Tests

- BLE connects → BT audio check triggers
- User opens Settings → Returns → Detection works
- Multiple connection/disconnection cycles

### Manual Testing Scenarios

1. First-time user flow (never paired)
2. Returning user flow (already paired)
3. User pairs during guide
4. User dismisses guide and pairs later
5. User switches between multiple BT audio devices
6. User unpairs and re-pairs
7. iOS Settings app interference
8. App backgrounded during pairing

### Hardware Testing

- Mentra Live glasses (primary target)
- Other BLE + BT audio glasses (compatibility)
- iOS 15, 16, 17, 18 (version compatibility)
- iPhone vs. iPad (form factor differences)

---

## Open Questions

1. **Should we auto-connect BLE when BT audio is detected?**
   - Current: BLE connects first, then prompt for BT audio
   - Alternative: If BT audio connected, try BLE connection?

2. **How to handle multiple paired glasses?**
   - User has 2+ Mentra glasses paired
   - Which one are they trying to connect to?

3. **Should Android also use this system for consistency?**
   - Android has automatic CTKD, but UX could be unified
   - Same components work on both platforms?

4. **What if glasses firmware changes naming convention?**
   - Need version detection?
   - Backward compatibility strategy?

5. **Should we show BT audio status in UI when not connected?**
   - "Controls connected, audio not connected"
   - May confuse users who don't need audio features

---

## Related Documentation

- [iOS Core Bluetooth Documentation](https://developer.apple.com/documentation/corebluetooth)
- [AVAudioSession Documentation](https://developer.apple.com/documentation/avfaudio/avaudiosession)
- [React Native Native Modules](https://reactnative.dev/docs/native-modules-ios)
- [MentraOS CTKD Android Implementation](../android_core/README.md)

---

## Conclusion

This approach provides the best possible iOS UX given platform limitations. While not as seamless as Android's automatic CTKD, it:

- ✅ Works with existing firmware (no hardware changes)
- ✅ Provides clear user guidance
- ✅ Minimizes user friction (one-time setup)
- ✅ Generalizes to future smart glasses
- ✅ Maintains feature parity across platforms

The key insight is: **we can't automate pairing, but we can automate everything around it** - detection, guidance, monitoring, and celebration.
