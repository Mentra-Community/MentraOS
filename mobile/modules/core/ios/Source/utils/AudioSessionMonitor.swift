//
//  AudioSessionMonitor.swift
//  AOS
//
//  Monitors iOS AVAudioSession for Bluetooth audio device connections
//  Used to detect when Mentra Live glasses are paired/connected for audio
//

import AVFoundation
import Foundation
import UIKit

class AudioSessionMonitor {
    // Singleton instance
    private static var instance: AudioSessionMonitor?

    // Current monitoring state
    static var isMonitoring = false
    static var devicePattern: String?
    static var callback: ((Bool, String?) -> Void)?

    private init() {
        Bridge.log("AudioMonitor: Initialized")
    }

    static func getInstance() -> AudioSessionMonitor {
        if instance == nil {
            instance = AudioSessionMonitor()
        }
        return instance!
    }

    /// Check if AVAudioSession is configured for Bluetooth
    /// Returns true if session allows Bluetooth audio
    /// NOTE: We don't configure the session - PhoneMic.swift handles that when recording
    static func isAudioSessionConfigured() -> Bool {
        let session = AVAudioSession.sharedInstance()

        // Check if category supports Bluetooth
        let category = session.category
        let supportsBluetooth = category == .playAndRecord || category == .record || category == .multiRoute

        Bridge.log("AudioMonitor: Audio session category: \(category.rawValue), supports BT: \(supportsBluetooth)")
        return supportsBluetooth
    }

    /// Check if a Bluetooth audio device matching the pattern is currently the active audio route
    /// Returns true if device is actively routing audio
    static func isAudioDeviceConnected(devicePattern: String) -> Bool {
        let session = AVAudioSession.sharedInstance()
        let outputs = session.currentRoute.outputs

        Bridge.log("AudioMonitor: Checking active route, output count: \(outputs.count)")
        for output in outputs {
            Bridge.log("AudioMonitor:   - \(output.portName) (type: \(output.portType.rawValue))")
            if output.portType == .bluetoothHFP || output.portType == .bluetoothA2DP {
                if output.portName.localizedCaseInsensitiveContains(devicePattern) {
                    Bridge.log("AudioMonitor: ✅ Found active audio device: \(output.portName)")
                    return true
                }
            }
        }

        Bridge.log("AudioMonitor: No active audio device matching '\(devicePattern)'")
        return false
    }

    /// Check if a Bluetooth device matching the pattern is paired (appears in availableInputs)
    /// Returns true if device is found (paired), WITHOUT activating it
    /// This avoids switching A2DP music playback to HFP microphone mode
    static func isDevicePaired(devicePattern: String) -> Bool {
        let session = AVAudioSession.sharedInstance()

        // Check if already active (using A2DP for music or HFP for calls)
        if isAudioDeviceConnected(devicePattern: devicePattern) {
            Bridge.log("AudioMonitor: Device '\(devicePattern)' already active")
            return true
        }

        // Try to find in availableInputs (includes paired devices)
        guard let availableInputs = session.availableInputs else {
            Bridge.log("AudioMonitor: ❌ availableInputs is nil")
            return false
        }

        Bridge.log("AudioMonitor: availableInputs count: \(availableInputs.count)")
        for input in availableInputs {
            Bridge.log("AudioMonitor:   - \(input.portName) (type: \(input.portType.rawValue))")
        }

        let bluetoothInput = availableInputs.first { input in
            input.portType == .bluetoothHFP &&
                input.portName.localizedCaseInsensitiveContains(devicePattern)
        }

        if let btInput = bluetoothInput {
            Bridge.log("AudioMonitor: ✅ Found paired device '\(btInput.portName)' (not activating to preserve A2DP)")
            return true
        } else {
            Bridge.log("AudioMonitor: ❌ Bluetooth HFP device '\(devicePattern)' not found in availableInputs")
            return false
        }
    }

    /// Start monitoring for audio route changes
    /// Callback will be called when device matching pattern connects/disconnects
    static func startMonitoring(devicePattern: String, callback: @escaping (Bool, String?) -> Void) {
        guard !isMonitoring else {
            Bridge.log("AudioMonitor: Already monitoring")
            return
        }

        self.devicePattern = devicePattern
        self.callback = callback

        // Register for route change notifications
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleRouteChange),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )

        // Register for app foreground notifications
        // This handles the case where user pairs in Settings and returns to app
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAppBecameActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )

        isMonitoring = true
        Bridge.log("AudioMonitor: Started monitoring for '\(devicePattern)'")
    }

    /// Stop monitoring for audio route changes
    static func stopMonitoring() {
        guard isMonitoring else {
            Bridge.log("AudioMonitor: Not currently monitoring")
            return
        }

        NotificationCenter.default.removeObserver(
            self,
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )

        NotificationCenter.default.removeObserver(
            self,
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )

        AudioSessionMonitor.isMonitoring = false
        AudioSessionMonitor.devicePattern = nil
        AudioSessionMonitor.callback = nil

        Bridge.log("AudioMonitor: Stopped monitoring")
    }

    @objc private func handleRouteChange(notification: Notification) {
        guard let userInfo = notification.userInfo,
              let reasonValue = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue),
              let pattern = AudioSessionMonitor.devicePattern
        else {
            return
        }

        Bridge.log("AudioMonitor: Route change detected: \(reason.rawValue)")

        switch reason {
        case .newDeviceAvailable:
            // When a new device becomes available, try to set it as preferred
            // This handles the case where user pairs in Settings and returns to app
            Bridge.log("AudioMonitor: New device available, attempting to activate '\(pattern)'")

            // Add small delay to let iOS populate availableInputs
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                if AudioSessionMonitor.isDevicePaired(devicePattern: pattern) {
                    let session = AVAudioSession.sharedInstance()
                    let deviceName = session.availableInputs?.first(where: {
                        $0.portName.localizedCaseInsensitiveContains(pattern)
                    })?.portName
                    Bridge.log("AudioMonitor: ✅ Successfully detected newly paired device '\(pattern)'")
                    AudioSessionMonitor.callback?(true, deviceName)
                } else {
                    Bridge.log("AudioMonitor: New device available but not matching '\(pattern)'")
                }
            }

        case .oldDeviceUnavailable:
            // Check if our device disconnected
            if !AudioSessionMonitor.isAudioDeviceConnected(devicePattern: pattern) {
                Bridge.log("AudioMonitor: Device '\(pattern)' disconnected")
                AudioSessionMonitor.callback?(false, nil)
            }

        default:
            break
        }
    }

    @objc private func handleAppBecameActive() {
        guard let pattern = AudioSessionMonitor.devicePattern else { return }

        Bridge.log("AudioMonitor: App became active, checking for paired device '\(pattern)'")

        // Don't reconfigure session - it's already configured from when monitoring started
        // Just wait a bit for iOS to update availableInputs after returning from background
        // iOS needs time to populate availableInputs after app foreground
        // Use retry with progressive delays: 100ms, 400ms, 500ms = 1s total
        AudioSessionMonitor.attemptActivateDevice(pattern: pattern, attempt: 0, maxAttempts: 3)
    }

    /// Try to detect if the audio device is paired with retry logic
    /// Delays: [100ms, 400ms, 500ms] = 1 second total
    static func attemptActivateDevice(pattern: String, attempt: Int, maxAttempts: Int) {
        // Progressive delays in seconds (total: 1 second)
        let delays: [TimeInterval] = [0.1, 0.4, 0.5]

        if attempt >= maxAttempts {
            Bridge.log("AudioMonitor: ❌ Failed to find paired device '\(pattern)' after \(maxAttempts) attempts")
            return
        }

        let delay = attempt < delays.count ? delays[attempt] : 0.5

        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            Bridge.log("AudioMonitor: Attempt \(attempt + 1)/\(maxAttempts) to detect '\(pattern)'...")

            if AudioSessionMonitor.isDevicePaired(devicePattern: pattern) {
                let session = AVAudioSession.sharedInstance()
                // Try to get device name from availableInputs
                let deviceName = session.availableInputs?.first(where: {
                    $0.portName.localizedCaseInsensitiveContains(pattern)
                })?.portName
                Bridge.log("AudioMonitor: ✅ Found paired device on attempt \(attempt + 1)")
                AudioSessionMonitor.callback?(true, deviceName)
            } else {
                Bridge.log("AudioMonitor: Attempt \(attempt + 1) failed, retrying in \(delays[min(attempt + 1, delays.count - 1)])s...")
                AudioSessionMonitor.attemptActivateDevice(pattern: pattern, attempt: attempt + 1, maxAttempts: maxAttempts)
            }
        }
    }
}
