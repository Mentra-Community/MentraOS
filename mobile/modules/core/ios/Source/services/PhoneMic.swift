//
//  PhoneMic.swift
//  MentraOS_Manager
//
//  Created on 3/8/25.
//

import AVFoundation
import Combine
import Foundation

class PhoneMic {
    static let shared = PhoneMic()

    /// Audio recording components
    private var audioEngine: AVAudioEngine?
    private var audioSession: AVAudioSession?

    /// Recording state - tracked via boolean to avoid EXC_BAD_ACCESS crash
    /// when AVAudioEngine becomes invalid during audio route changes.
    /// See: MENTRA-OS-14P
    private var _isRecording = false
    var isRecording: Bool { _isRecording }

    private var currentMicMode: String = ""
    private var cancellables = Set<AnyCancellable>()

    // MARK: - Initialization

    init() {
        // Set up audio session notification to handle route changes
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleRouteChange),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleInterruption),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - Public Methods

    /// Check (but don't request) microphone permissions
    /// Permissions are requested by React Native UI, not directly by Swift
    func requestPermissions() async -> Bool {
        // Instead of requesting permissions directly, we just check the current status
        // This maintains compatibility with existing code that calls this method
        return checkPermissions()
    }

    /// Check if microphone permissions have been granted
    func checkPermissions() -> Bool {
        return AVAudioSession.sharedInstance().recordPermission == .granted
    }

    /// Get a list of available audio input devices
    func getAvailableInputDevices() -> [String: String] {
        var deviceInfo = [String: String]()

        // Get current route inputs
        let currentRoute = AVAudioSession.sharedInstance().currentRoute
        for input in currentRoute.inputs {
            deviceInfo[input.uid] = input.portName
        }

        // Also check available inputs which may include disconnected but paired devices
        if let availableInputs = AVAudioSession.sharedInstance().availableInputs {
            for input in availableInputs {
                deviceInfo[input.uid] = input.portName
            }
        }

        return deviceInfo
    }

    /// Manually set AirPods or another specific device as preferred input
    func setPreferredInputDevice(named deviceName: String) -> Bool {
        guard let availableInputs = AVAudioSession.sharedInstance().availableInputs else {
            Bridge.log("No available inputs found")
            return false
        }

        // Find input containing the specified name (case insensitive)
        guard
            let preferredInput = availableInputs.first(where: {
                $0.portName.range(of: deviceName, options: .caseInsensitive) != nil
            })
        else {
            Bridge.log("No input device found containing name: \(deviceName)")
            return false
        }

        do {
            try AVAudioSession.sharedInstance().setPreferredInput(preferredInput)
            Bridge.log("Successfully set preferred input to: \(preferredInput.portName)")
            return true
        } catch {
            Bridge.log("Failed to set preferred input: \(error)")
            return false
        }
    }

    /// Check if currently recording with a specific mode
    func isRecordingWithMode(_ mode: String) -> Bool {
        return isRecording && currentMicMode == mode
    }

    /// Start recording with a specific microphone mode
    /// - Parameter mode: One of MicTypes constants (PHONE_INTERNAL, BT_CLASSIC, BT)
    /// - Returns: true if successfully started recording, false otherwise
    func startMode(_ mode: String) -> Bool {
        // Check if already recording with this mode
        if isRecordingWithMode(mode) {
            return true
        }

        // If recording with a different mode, stop first
        if isRecording {
            Bridge.log(
                "MIC: Already recording with different mode (\(currentMicMode)), stopping first")
            // stopRecording()
            // Brief delay to ensure clean stop
            // Thread.sleep(forTimeInterval: 0.05)
            return false
        }

        // Check permissions
        guard checkPermissions() else {
            Bridge.log("MIC: Microphone permissions not granted")
            return false
        }

        // Start recording based on mode
        switch mode {
        case MicTypes.PHONE_INTERNAL:
            Bridge.log("MIC: Starting phone internal mic")
            return startRecordingPhoneInternal()

        // case MicTypes.BT_CLASSIC:
        // Bridge.log("MIC: Starting Bluetooth Classic (SCO)")
        // guard isBluetoothScoAvailable() else {
        //     Bridge.log("MIC: Bluetooth SCO not available")
        //     return false
        // }
        // return startRecordingBtClassic()

        case MicTypes.BT:
            Bridge.log("MIC: Starting high-quality Bluetooth mic")
            guard isHighQualityBluetoothAvailable() else {
                Bridge.log("MIC: High-quality Bluetooth not available")
                return false
            }
            return startRecordingBtHighQuality()

        default:
            Bridge.log("MIC: Unknown mic type: \(mode)")
            return false
        }
    }

    /// Stop recording if currently recording with specified mode
    func stopMode(_ mode: String) -> Bool {
        if isRecordingWithMode(mode) {
            stopRecording()
            return true
        }
        return false
    }

    // MARK: - Private Mode-Specific Recording Methods

    private func startRecordingPhoneInternal() -> Bool {
        do {
            let session = AVAudioSession.sharedInstance()

            // Configure for built-in mic only
            try session.setCategory(
                .playAndRecord,
                mode: .default,
                options: [.allowBluetooth, .defaultToSpeaker, .mixWithOthers, .allowBluetoothA2DP]
            )

            // Override the output to use Bluetooth (AirPods) for speaker
            try session.overrideOutputAudioPort(.none)

            // Try to set built-in mic as preferred input
            if let availableInputs = session.availableInputs {
                let builtInMic = availableInputs.first { input in
                    input.portType == .builtInMic
                }

                if let builtInMic = builtInMic {
                    try session.setPreferredInput(builtInMic)
                }
            }

            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let success = startRecordingInternal()
            if success {
                currentMicMode = MicTypes.PHONE_INTERNAL
            }
            return success

        } catch {
            Bridge.log("MIC: Phone internal recording failed: \(error)")
            return false
        }
    }

    private func startRecordingBtClassic() -> Bool {
        do {
            let session = AVAudioSession.sharedInstance()

            // Configure for Bluetooth SCO
            try session.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.allowBluetooth]
            )

            // Try to set Bluetooth HFP as preferred input
            if let availableInputs = session.availableInputs {
                let bluetoothHFP = availableInputs.first { input in
                    input.portType == .bluetoothHFP
                }

                if let bluetoothHFP = bluetoothHFP {
                    try session.setPreferredInput(bluetoothHFP)
                }
            }

            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let success = startRecordingInternal()
            if success {
                currentMicMode = MicTypes.BT_CLASSIC
            }
            return success

        } catch {
            Bridge.log("MIC: BT Classic recording failed: \(error)")
            return false
        }
    }

    private func startRecordingBtHighQuality() -> Bool {
        do {
            let session = AVAudioSession.sharedInstance()

            // Configure for high-quality Bluetooth audio (A2DP-like)
            try session.setCategory(
                .playAndRecord,
                mode: .default,
                options: [.allowBluetooth, .allowBluetoothA2DP, .mixWithOthers]
            )

            // Try to set Bluetooth A2DP as preferred input
            if let availableInputs = session.availableInputs {
                let bluetoothA2DP = availableInputs.first { input in
                    input.portType == .bluetoothA2DP || input.portType == .bluetoothLE
                }

                if let bluetoothA2DP = bluetoothA2DP {
                    try session.setPreferredInput(bluetoothA2DP)
                }
            }

            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let success = startRecordingInternal()
            if success {
                currentMicMode = MicTypes.BT
            }
            return success

        } catch {
            Bridge.log("MIC: BT high-quality recording failed: \(error)")
            return false
        }
    }

    // MARK: - Bluetooth Availability Checks

    private func isBluetoothScoAvailable() -> Bool {
        guard let availableInputs = AVAudioSession.sharedInstance().availableInputs else {
            return false
        }

        return availableInputs.contains { input in
            input.portType == .bluetoothHFP
        }
    }

    private func isHighQualityBluetoothAvailable() -> Bool {
        guard let availableInputs = AVAudioSession.sharedInstance().availableInputs else {
            return false
        }

        return availableInputs.contains { input in
            input.portType == .bluetoothA2DP || input.portType == .bluetoothLE
        }
    }

    @objc private func handleInterruption(notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue)
        else {
            return
        }

        switch type {
        case .began:
            Bridge.log("Audio session interrupted - another app took control")
            // Phone call started - the system has stopped our audio engine.
            // Reset _isRecording so we can restart when interruption ends.
            if _isRecording {
                _isRecording = false
                currentMicMode = ""
                CoreManager.shared.onInterruption(began: true)
            }
        case .ended:
            Bridge.log("Audio session interruption ended")
            if let optionsValue = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt {
                let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
                if options.contains(.shouldResume) {
                    CoreManager.shared.onInterruption(began: false)
                }
            }
        @unknown default:
            break
        }
    }

    /// Handle audio route changes (e.g. when connecting/disconnecting AirPods)
    @objc private func handleRouteChange(notification: Notification) {
        guard let userInfo = notification.userInfo,
              let reasonValue = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue)
        else {
            return
        }

        Bridge.log("MIC: handleRouteChange: \(reason)")
        CoreManager.shared.onRouteChange(
            reason: reason, availableInputs: audioSession?.availableInputs ?? []
        )

        // // If we're recording and the audio route changed (e.g., AirPods connected/disconnected)
        // if isRecording {
        //   switch reason {
        //   case .newDeviceAvailable, .oldDeviceUnavailable:
        //     // Restart recording to use the new input device
        //     stopRecording()
        //     _ = startRecording()
        //   default:
        //     break
        //   }
        // }

        // Log the current audio route
        logCurrentAudioRoute()
    }

    /// Log the current audio input/output route for debugging
    private func logCurrentAudioRoute() {
        let currentRoute = AVAudioSession.sharedInstance().currentRoute
        var routeDescription = "Current audio route:\n"

        // Log inputs
        if currentRoute.inputs.isEmpty {
            routeDescription += "- No input ports\n"
        } else {
            for (index, port) in currentRoute.inputs.enumerated() {
                routeDescription +=
                    "- Input \(index + 1): \(port.portName) (type: \(port.portType.rawValue))\n"
            }
        }

        // Log outputs
        if currentRoute.outputs.isEmpty {
            routeDescription += "- No output ports"
        } else {
            for (index, port) in currentRoute.outputs.enumerated() {
                routeDescription +=
                    "- Output \(index + 1): \(port.portName) (type: \(port.portType.rawValue))"
                if index < currentRoute.outputs.count - 1 {
                    routeDescription += "\n"
                }
            }
        }

        // CoreCommsService.log(routeDescription)
    }

    // MARK: - Private Helpers

    /// Extract Int16 data from a converted buffer
    private func extractInt16Data(from buffer: AVAudioPCMBuffer) -> Data {
        let channelCount = Int(buffer.format.channelCount)
        let frameCount = Int(buffer.frameLength)
        let data = NSMutableData()

        // Safely get int16 data (won't be nil if buffer is in Int16 format)
        guard let int16Data = buffer.int16ChannelData else {
            Bridge.log("Error: Buffer does not contain int16 data")
            return Data()
        }

        let channels = UnsafeBufferPointer(start: int16Data, count: channelCount)

        // Extract each sample
        for frame in 0 ..< frameCount {
            for channel in 0 ..< channelCount {
                var sample = channels[channel][frame]
                data.append(&sample, length: 2)
            }
        }

        return data as Data
    }

    /// Start recording from the available microphone (built-in, Bluetooth, AirPods, etc.)
    func startRecording() -> Bool {
        // Ensure we're not already recording
        if isRecording {
            //            Core.log("MIC: Microphone is already ON!")
            return true
        }

        // Clean up any existing engine (shouldn't happen if _isRecording is accurate, but be safe)
        if let existingEngine = audioEngine {
            _isRecording = false
            existingEngine.stop()
            audioEngine = nil
        }

        // Check permissions first
        guard checkPermissions() else {
            Bridge.log("MIC: Microphone permissions not granted")
            return false
        }

        // Set up audio session BEFORE creating the engine
        audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession?.setCategory(
                .playAndRecord,
                mode: .default,
                options: [.allowBluetooth, .defaultToSpeaker, .mixWithOthers]
            )

            // Set preferred input if available
            if let availableInputs = audioSession?.availableInputs, !availableInputs.isEmpty {
                let preferredInput =
                    availableInputs.first { input in
                        input.portType == .bluetoothHFP || input.portType == .bluetoothA2DP
                    } ?? availableInputs.first

                try audioSession?.setPreferredInput(preferredInput)
            }

            // Activate the session BEFORE creating the engine
            try audioSession?.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            Bridge.log("MIC: Failed to set up audio session: \(error)")
            return false
        }

        return startRecordingInternal()
    }

    /// Internal recording logic shared by all recording modes
    private func startRecordingInternal() -> Bool {
        // check if we're in the background:
        let appState = UIApplication.shared.applicationState
        if appState == .background {
            Bridge.log("MIC: App is in background, cannot start recording")
            return false
        }

        if let existingEngine = audioEngine {
            _isRecording = false
            existingEngine.inputNode.removeTap(onBus: 0)
            existingEngine.stop()
            audioEngine = nil
        }

        let session = AVAudioSession.sharedInstance()
        guard let availableInputs = session.availableInputs, !availableInputs.isEmpty else {
            Bridge.log("MIC: No audio inputs available, cannot start recording")
            return false
        }

        // NOW create the audio engine:
        audioEngine = AVAudioEngine()

        // Safely get the input node
        guard let engine = audioEngine else {
            Bridge.log("MIC: Failed to create audio engine")
            return false
        }

        // The engine must have an input node, but let's be safe
        let inputNode = engine.inputNode

        // Verify the node is valid before accessing its properties
        guard inputNode.engine != nil else {
            Bridge.log("MIC: Input node is not properly attached to engine")
            audioEngine = nil
            return false
        }

        // Check if the node has inputs available
        guard inputNode.numberOfInputs > 0 else {
            Bridge.log("MIC: Input node has no available inputs")
            audioEngine = nil
            return false
        }

        // Get the native input format - typically 48kHz floating point samples
        // let inputFormat = inputNode.inputFormat(forBus: 0)
        let inputFormat = inputNode.outputFormat(forBus: 0)
        Bridge.log("MIC: Input format: \(inputFormat)")

        // Set up a converter node if you need 16-bit PCM
        let converter = AVAudioConverter(
            from: inputFormat,
            to: AVAudioFormat(
                commonFormat: .pcmFormatInt16,
                sampleRate: 16000,
                channels: 1,
                interleaved: false
            )!
        )

        guard let converter = converter else {
            Bridge.log("MIC: converter is nil")
            // audioEngine = nil
            return false
        }

        // Remove any existing tap before installing new one (prevents crash if tap
        // already exists from previous engine). This is safe even if no tap exists.
        // See: MENTRA-OS-YM, MENTRA-OS-137
        inputNode.removeTap(onBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 256, format: nil) {
            [weak self] buffer, _ in
            guard let self = self else { return }

            let frameCount = Int(buffer.frameLength)

            // Calculate the correct output buffer capacity based on sample rate conversion
            // For downsampling from inputFormat.sampleRate to 16000 Hz
            let outputCapacity = AVAudioFrameCount(
                Double(frameCount) * (16000.0 / inputFormat.sampleRate)
            )

            // Create a 16-bit PCM data buffer with adjusted capacity
            let convertedBuffer = AVAudioPCMBuffer(
                pcmFormat: converter.outputFormat,
                frameCapacity: outputCapacity
            )!

            var error: NSError? = nil
            let status = converter.convert(
                to: convertedBuffer,
                error: &error,
                withInputFrom: { _, outStatus in
                    outStatus.pointee = .haveData
                    return buffer
                }
            )

            guard status == .haveData && error == nil else {
                Bridge.log(
                    "MIC: Error converting audio buffer: \(error?.localizedDescription ?? "unknown")"
                )
                return
            }

            let pcmData = self.extractInt16Data(from: convertedBuffer)
            CoreManager.shared.handlePcm(pcmData)
        }

        // Start the audio engine
        do {
            try audioEngine?.start()
            _isRecording = true
            Bridge.log("MIC: Started recording from: \(getActiveInputDevice() ?? "Unknown device")")
            return true
        } catch {
            Bridge.log("MIC: Failed to start audio engine: \(error)")
            return false
        }
    }

    /// Get the currently active input device name
    func getActiveInputDevice() -> String? {
        let currentRoute = AVAudioSession.sharedInstance().currentRoute
        return currentRoute.inputs.first?.portName
    }

    /// Stop recording from the microphone
    func stopRecording() {
        guard _isRecording else {
            return
        }

        // Set state FIRST before touching engine to prevent crash if
        // route change triggers isRecording check mid-cleanup
        _isRecording = false
        currentMicMode = ""

        // Remove the tap and stop the engine (may fail if engine invalid, that's ok)
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()

        // Clean up
        try? audioSession?.setActive(false)
        audioEngine = nil
        audioSession = nil

        Bridge.log("MIC: Stopped recording")
    }

    // MARK: - Cleanup

    func cleanup() {
        NotificationCenter.default.removeObserver(self)
        stopRecording()
    }
}
