//
//  PhoneAudioMonitor.swift
//  AOS
//
//  Monitors iOS system audio playback state
//
//  Used to detect when the phone is playing audio (music, podcasts, etc.)
//  so we can temporarily suspend the LC3 microphone on MentraLive glasses
//  to avoid overloading the MCU when both A2DP output and LC3 mic input
//  are active simultaneously.
//
//  This class mirrors the Android PhoneAudioMonitor.kt implementation.
//

import AVFoundation
import Foundation

/// Listener protocol for phone audio state changes
protocol PhoneAudioMonitorListener: AnyObject {
    func onPhoneAudioStateChanged(isPlaying: Bool)
}

/// Monitors system audio playback to detect when the phone is playing audio
class PhoneAudioMonitor {
    // Singleton instance
    private static var instance: PhoneAudioMonitor?

    private weak var listener: PhoneAudioMonitorListener?
    private var isMonitoring = false
    private var lastKnownState = false

    // Track our own app's audio playback state
    // isOtherAudioPlaying only detects OTHER apps, not our own
    private var ownAppAudioPlaying = false

    // Polling timer for fallback detection
    private var pollingTimer: Timer?
    private let pollingIntervalSeconds: TimeInterval = 1.0

    private init() {
        Bridge.log("PhoneAudioMonitor: Initialized")
    }

    static func getInstance() -> PhoneAudioMonitor {
        if instance == nil {
            instance = PhoneAudioMonitor()
        }
        return instance!
    }

    /// Check if any audio is currently playing on the device (including our own app)
    func isPlaying() -> Bool {
        let session = AVAudioSession.sharedInstance()
        // Combine: other apps playing OR our own app playing
        return session.isOtherAudioPlaying || ownAppAudioPlaying
    }

    /// Notify the monitor that our own app started/stopped playing audio
    /// Called from RN AudioPlaybackService via Bridge
    func setOwnAppAudioPlaying(_ playing: Bool) {
        guard ownAppAudioPlaying != playing else { return }

        ownAppAudioPlaying = playing
        Bridge.log("PhoneAudioMonitor: Own app audio -> \(playing ? "PLAYING" : "STOPPED")")

        // Immediately notify listener if overall state changed
        notifyIfStateChanged(isPlaying())
    }

    /// Start monitoring for phone audio playback changes
    ///
    /// - Parameter listener: Callback to receive audio state change notifications
    func startMonitoring(listener: PhoneAudioMonitorListener) {
        guard !isMonitoring else {
            Bridge.log("PhoneAudioMonitor: Already monitoring")
            return
        }

        self.listener = listener
        self.lastKnownState = isPlaying()
        self.isMonitoring = true

        Bridge.log(
            "PhoneAudioMonitor: Starting audio playback monitoring (initial state: \(lastKnownState ? "playing" : "not playing"))"
        )

        // Register for silenceSecondaryAudioHint notification
        // This is fired when other apps start/stop playing audio
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleSilenceSecondaryAudioHint),
            name: AVAudioSession.silenceSecondaryAudioHintNotification,
            object: nil
        )

        // Also register for interruption notifications as a supplement
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleAudioInterruption),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )

        // Start polling as a fallback mechanism
        // Some audio sources might not trigger notifications reliably
        startPolling()
    }

    /// Stop monitoring for phone audio playback changes
    func stopMonitoring() {
        guard isMonitoring else {
            Bridge.log("PhoneAudioMonitor: Not currently monitoring")
            return
        }

        Bridge.log("PhoneAudioMonitor: Stopping audio playback monitoring")

        NotificationCenter.default.removeObserver(
            self,
            name: AVAudioSession.silenceSecondaryAudioHintNotification,
            object: nil
        )

        NotificationCenter.default.removeObserver(
            self,
            name: AVAudioSession.interruptionNotification,
            object: nil
        )

        stopPolling()

        listener = nil
        isMonitoring = false
    }

    /// Handle silenceSecondaryAudioHint notification
    @objc private func handleSilenceSecondaryAudioHint(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
            let typeValue = userInfo[AVAudioSessionSilenceSecondaryAudioHintTypeKey] as? UInt,
            let type = AVAudioSession.SilenceSecondaryAudioHintType(rawValue: typeValue)
        else {
            return
        }

        let isPlaying: Bool
        switch type {
        case .begin:
            // Another app started playing audio
            isPlaying = true
            Bridge.log("PhoneAudioMonitor: Received silenceSecondaryAudioHint - begin")
        case .end:
            // Another app stopped playing audio
            isPlaying = false
            Bridge.log("PhoneAudioMonitor: Received silenceSecondaryAudioHint - end")
        @unknown default:
            // Check actual state for unknown types
            isPlaying = self.isPlaying()
        }

        notifyIfStateChanged(isPlaying)
    }

    /// Handle audio interruption notifications
    @objc private func handleAudioInterruption(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
            let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: typeValue)
        else {
            return
        }

        switch type {
        case .began:
            // Audio was interrupted (e.g., phone call, other app took audio focus)
            Bridge.log("PhoneAudioMonitor: Audio interruption began")
            // Don't necessarily mean audio is playing - check actual state
            notifyIfStateChanged(isPlaying())
        case .ended:
            Bridge.log("PhoneAudioMonitor: Audio interruption ended")
            // Small delay to let audio state settle
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                guard let self = self else { return }
                self.notifyIfStateChanged(self.isPlaying())
            }
        @unknown default:
            break
        }
    }

    /// Start polling isOtherAudioPlaying as a fallback mechanism
    private func startPolling() {
        pollingTimer = Timer.scheduledTimer(
            withTimeInterval: pollingIntervalSeconds,
            repeats: true
        ) { [weak self] _ in
            guard let self = self, self.isMonitoring else { return }

            let currentState = self.isPlaying()
            self.notifyIfStateChanged(currentState)
        }
    }

    /// Stop the polling mechanism
    private func stopPolling() {
        pollingTimer?.invalidate()
        pollingTimer = nil
    }

    /// Notify listener if state has changed
    private func notifyIfStateChanged(_ isPlaying: Bool) {
        guard isPlaying != lastKnownState else { return }

        lastKnownState = isPlaying
        Bridge.log("PhoneAudioMonitor: Audio state changed -> \(isPlaying ? "PLAYING" : "STOPPED")")

        DispatchQueue.main.async { [weak self] in
            self?.listener?.onPhoneAudioStateChanged(isPlaying: isPlaying)
        }
    }

    /// Clean up resources
    func destroy() {
        stopMonitoring()
        PhoneAudioMonitor.instance = nil
    }
}
