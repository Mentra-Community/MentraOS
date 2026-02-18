//
//  CoreManager.swift
//  MentraOS_Manager
//
//  Created by Matthew Fosse on 3/5/25.
//

import AVFoundation
import Combine
import CoreBluetooth
import Foundation
import React
import UIKit

struct ViewState {
    var topText: String
    var bottomText: String
    var title: String
    var layoutType: String
    var text: String
    var data: String?
    var animationData: [String: Any]?
}

@MainActor
@objc(CoreManager) class CoreManager: NSObject {
    static let shared = CoreManager()

    @objc static func getInstance() -> CoreManager {
        return CoreManager.shared
    }

    // MARK: - Unique (iOS)

    private var cancellables = Set<AnyCancellable>()
    var sendStateWorkItem: DispatchWorkItem?
    let sendStateQueue = DispatchQueue(label: "sendStateQueue", qos: .userInitiated)

    /**
     * Setup Bluetooth audio pairing after BLE connection is established
     * Attempts to automatically activate Mentra Live as the system audio device
     * If not paired yet, prompts user to pair in Settings
     */
    func setupAudioPairing(deviceName _: String) {
        // Don't configure audio session - PhoneMic.swift handles that
        // Just check if audio session supports Bluetooth (informational only)
        if !AudioSessionMonitor.isAudioSessionConfigured() {
            Bridge.log(
                "Audio: Audio session not configured for Bluetooth yet - mic system will configure it when recording"
            )
        }

        // Extract device ID pattern to match the specific device
        // BLE name: "MENTRA_LIVE_BLE_ABC123"
        // BT Classic could be: "MENTRA_LIVE_BLE_ABC123" or "MENTRA_LIVE_BT_ABC123"
        // We need to match on the unique device ID part (e.g., "ABC123")
        let audioDevicePattern = getAudioDevicePattern()

        if audioDevicePattern.isEmpty || audioDevicePattern == DeviceTypes.SIMULATED {
            Bridge.log("Audio: Device pattern is empty or simulated, returning")
            return
        }

        // Check if device is paired (don't activate to preserve A2DP music playback)
        let isPaired = AudioSessionMonitor.isDevicePaired(devicePattern: audioDevicePattern)

        if isPaired {
            // Device is paired! Don't activate it - let PhoneMic.swift activate when recording starts
            Bridge.log("Audio: ✅ Mentra Live is paired (preserving A2DP for music)")
            glassesBtcConnected = true
        } else {
            glassesBtcConnected = false
            // Not found in availableInputs - not paired yet

            // Start monitoring for when user pairs manually
            AudioSessionMonitor.startMonitoring(devicePattern: audioDevicePattern) {
                [weak self] (connected: Bool, _: String?) in
                guard let self = self else { return }

                if connected {
                    Bridge.log("Audio: ✅ Device paired and connected")
                    // Don't activate - let PhoneMic.swift handle that when recording starts
                    self.glassesBtcConnected = true
                } else {
                    Bridge.log("Audio: Device disconnected")
                    self.glassesBtcConnected = false
                }
            }
        }
    }

    // MARK: - End Unique

    // MARK: - Properties

    var coreToken: String = ""
    var coreTokenOwner: String = ""
    var userEmail: String = ""
    var sgc: SGCManager?

    // state
    // var lastStatusObj: [String: Any] = [:]

    // settings:
    private var defaultWearable: String {
        get { GlassesStore.shared.get("core", "default_wearable") as? String ?? "" }
        set { GlassesStore.shared.apply("core", "default_wearable", newValue) }
    }

    private var pendingWearable: String {
        get { GlassesStore.shared.get("core", "pending_wearable") as? String ?? "" }
        set { GlassesStore.shared.apply("core", "pending_wearable", newValue) }
    }

    private var deviceName: String {
        get { GlassesStore.shared.get("core", "device_name") as? String ?? "" }
        set { GlassesStore.shared.apply("core", "device_name", newValue) }
    }

    private var deviceAddress: String {
        get { GlassesStore.shared.get("core", "deviceAddress") as? String ?? "" }
        set { GlassesStore.shared.apply("core", "deviceAddress", newValue) }
    }

    private var screenDisabled: Bool {
        get { GlassesStore.shared.get("core", "screen_disabled") as? Bool ?? false }
        set { GlassesStore.shared.apply("core", "screen_disabled", newValue) }
    }

    private var preferredMic: String {
        get { GlassesStore.shared.get("core", "preferred_mic") as? String ?? "auto" }
        set { GlassesStore.shared.apply("core", "preferred_mic", newValue) }
    }

    private var autoBrightness: Bool {
        get { GlassesStore.shared.get("core", "auto_brightness") as? Bool ?? true }
        set { GlassesStore.shared.apply("core", "auto_brightness", newValue) }
    }

    private var brightness: Int {
        get { GlassesStore.shared.get("core", "brightness") as? Int ?? 50 }
        set { GlassesStore.shared.apply("core", "brightness", newValue) }
    }

    private var headUpAngle: Int {
        get { GlassesStore.shared.get("core", "head_up_angle") as? Int ?? 30 }
        set { GlassesStore.shared.apply("core", "head_up_angle", newValue) }
    }

    private var sensingEnabled: Bool {
        get { GlassesStore.shared.get("core", "sensing_enabled") as? Bool ?? true }
        set { GlassesStore.shared.apply("core", "sensing_enabled", newValue) }
    }

    var powerSavingMode: Bool {
        get { GlassesStore.shared.get("core", "power_saving_mode") as? Bool ?? false }
        set { GlassesStore.shared.apply("core", "power_saving_mode", newValue) }
    }

    private var alwaysOnStatusBar: Bool {
        get { GlassesStore.shared.get("core", "always_on_status_bar") as? Bool ?? false }
        set { GlassesStore.shared.apply("core", "always_on_status_bar", newValue) }
    }

    private var bypassVad: Bool {
        get { GlassesStore.shared.get("core", "bypass_vad") as? Bool ?? true }
        set { GlassesStore.shared.apply("core", "bypass_vad", newValue) }
    }

    private var enforceLocalTranscription: Bool {
        get {
            GlassesStore.shared.get("core", "enforce_local_transcription") as? Bool ?? false
        }
        set { GlassesStore.shared.apply("core", "enforce_local_transcription", newValue) }
    }

    private var offlineMode: Bool {
        get { GlassesStore.shared.get("core", "offline_mode") as? Bool ?? false }
        set { GlassesStore.shared.apply("core", "offline_mode", newValue) }
    }

    private var metricSystem: Bool {
        get { GlassesStore.shared.get("core", "metric_system") as? Bool ?? false }
        set { GlassesStore.shared.apply("core", "metric_system", newValue) }
    }

    private var contextualDashboard: Bool {
        get { GlassesStore.shared.get("core", "contextual_dashboard") as? Bool ?? true }
        set { GlassesStore.shared.apply("core", "contextual_dashboard", newValue) }
    }

    // state:
    private var shouldSendPcmData: Bool {
        get { GlassesStore.shared.get("core", "shouldSendPcmData") as? Bool ?? false }
        set { GlassesStore.shared.apply("core", "shouldSendPcmData", newValue) }
    }

    private var shouldSendTranscript: Bool {
        get { GlassesStore.shared.get("core", "shouldSendTranscript") as? Bool ?? false }
        set { GlassesStore.shared.apply("core", "shouldSendTranscript", newValue) }
    }

    private var searching: Bool {
        get { GlassesStore.shared.get("core", "searching") as? Bool ?? false }
        set { GlassesStore.shared.apply("core", "searching", newValue) }
    }

    private var glassesBtcConnected: Bool {
        get { GlassesStore.shared.get("glasses", "btcConnected") as? Bool ?? false }
        set { GlassesStore.shared.apply("glasses", "btcConnected", newValue) }
    }

    private var micRanking: [String] {
        get {
            GlassesStore.shared.get("core", "micRanking") as? [String] ?? MicMap.map["auto"]!
        }
        set { GlassesStore.shared.apply("core", "micRanking", newValue) }
    }

    private var shouldSendBootingMessage: Bool {
        get { GlassesStore.shared.get("core", "shouldSendBootingMessage") as? Bool ?? true }
        set { GlassesStore.shared.apply("core", "shouldSendBootingMessage", newValue) }
    }

    private var systemMicUnavailable: Bool {
        get { GlassesStore.shared.get("core", "systemMicUnavailable") as? Bool ?? false }
        set { GlassesStore.shared.apply("core", "systemMicUnavailable", newValue) }
    }

    private var headUp: Bool {
        get { GlassesStore.shared.get("glasses", "headUp") as? Bool ?? false }
        set { GlassesStore.shared.apply("glasses", "headUp", newValue) }
    }

    private var micEnabled: Bool {
        get { GlassesStore.shared.get("core", "micEnabled") as? Bool ?? false }
        set { GlassesStore.shared.apply("core", "micEnabled", newValue) }
    }

    private var currentMic: String {
        get { GlassesStore.shared.get("core", "currentMic") as? String ?? "" }
        set { GlassesStore.shared.apply("core", "currentMic", newValue) }
    }

    private var searchResults: [[String: Any]] {
        get { GlassesStore.shared.get("core", "searchResults") as? [[String: Any]] ?? [] }
        set { GlassesStore.shared.apply("core", "searchResults", newValue) }
    }

    private var wifiScanResults: [[String: Any]] {
        get { GlassesStore.shared.get("core", "wifiScanResults") as? [[String: Any]] ?? [] }
        set { GlassesStore.shared.apply("core", "wifiScanResults", newValue) }
    }

    private var lastLog: [String] {
        get { GlassesStore.shared.get("core", "lastLog") as? [String] ?? [] }
        set { GlassesStore.shared.apply("core", "lastLog", newValue) }
    }

    private var otherBtConnected: Bool {
        get { GlassesStore.shared.get("core", "otherBtConnected") as? Bool ?? false }
        set { GlassesStore.shared.apply("core", "otherBtConnected", newValue) }
    }

    // LC3 Audio Encoding
    // Audio output format enum
    enum AudioOutputFormat { case lc3, pcm }
    // Canonical LC3 config: 16kHz sample rate, 10ms frame duration
    // Frame size is configurable: 20 bytes (16kbps), 40 bytes (32kbps), 60 bytes (48kbps)
    // Persistent LC3 converter for encoding/decoding
    var lc3Converter: PcmConverter?
    // Audio output format - defaults to LC3 for bandwidth savings
    private var audioOutputFormat: AudioOutputFormat = .lc3

    // VAD:
    private var vad: SileroVADStrategy?
    private var vadBuffer = [Data]()
    private var isSpeaking = false

    // STT:
    private var transcriber: SherpaOnnxTranscriber?

    var viewStates: [ViewState] = [
        ViewState(
            topText: " ", bottomText: " ", title: " ", layoutType: "text_wall", text: ""
        ),
        ViewState(
            topText: " ", bottomText: " ", title: " ", layoutType: "text_wall",
            text: "$TIME12$ $DATE$ $GBATT$ $CONNECTION_STATUS$"
        ),
        ViewState(
            topText: " ", bottomText: " ", title: " ", layoutType: "text_wall", text: "",
            data: nil, animationData: nil
        ),
        ViewState(
            topText: " ", bottomText: " ", title: " ", layoutType: "text_wall",
            text: "$TIME12$ $DATE$ $GBATT$ $CONNECTION_STATUS$", data: nil,
            animationData: nil
        ),
    ]

    override init() {
        Bridge.log("MAN: init()")
        vad = SileroVADStrategy()
        super.init()

        // Start memory monitoring (logs every 30s to help detect leaks)
        // MemoryMonitor.start()

        // Initialize SherpaOnnx Transcriber
        if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
           let window = windowScene.windows.first,
           let rootViewController = window.rootViewController
        {
            transcriber = SherpaOnnxTranscriber(context: rootViewController)
        } else {
            Bridge.log("Failed to create SherpaOnnxTranscriber - no root view controller found")
        }

        // Initialize the transcriber
        if let transcriber = transcriber {
            transcriber.initialize()
            Bridge.log("SherpaOnnxTranscriber fully initialized")
        }

        Task {
            self.vad?.setup(
                sampleRate: .rate_16k,
                frameSize: .size_1024,
                quality: .normal,
                silenceTriggerDurationMs: 4000,
                speechTriggerDurationMs: 50
            )
        }

        // Initialize persistent LC3 converter for unified audio encoding
        lc3Converter = PcmConverter()
        Bridge.log("LC3 converter initialized for unified audio encoding")
    }

    // MARK: - AUX Voice Data Handling

    private func checkSetVadStatus(speaking: Bool) {
        if speaking != isSpeaking {
            isSpeaking = speaking
            Bridge.sendVadStatus(isSpeaking)
        }
    }

    /**
     * Send audio data to cloud via Bridge.
     * Encodes to LC3 if audioOutputFormat is .lc3, otherwise sends raw PCM.
     * All audio destined for cloud should go through this function.
     */
    private func sendMicData(_ pcmData: Data) {
        switch audioOutputFormat {
        case .lc3:
            guard let lc3Converter = lc3Converter else {
                Bridge.log("MAN: ERROR - LC3 converter not initialized but format is LC3")
                return
            }
            let frameSize = GlassesStore.shared.get("core", "lc3_frame_size") as! Int
            let lc3Data = lc3Converter.encode(pcmData, frameSize: frameSize) as Data
            guard lc3Data.count > 0 else {
                Bridge.log("MAN: ERROR - LC3 encoding returned empty data")
                return
            }
            Bridge.sendMicData(lc3Data)
        case .pcm:
            Bridge.sendMicData(pcmData)
        }
    }

    private func emptyVadBuffer() {
        // go through the buffer, popping from the first element in the array (FIFO):
        while !vadBuffer.isEmpty {
            let chunk = vadBuffer.removeFirst()
            sendMicData(chunk) // Uses our encoder, not Bridge directly
        }
    }

    private func addToVadBuffer(_ chunk: Data) {
        let MAX_BUFFER_SIZE = 20
        vadBuffer.append(chunk)
        while vadBuffer.count > MAX_BUFFER_SIZE {
            // pop from the front of the array:
            vadBuffer.removeFirst()
        }
    }

    /**
     * Handle raw LC3 audio data from glasses.
     * Decodes the glasses LC3 to PCM, then forwards to handlePcm for processing.
     * This matches Android behavior - glasses forward raw LC3, CoreManager handles encoding.
     */
    func handleGlassesMicData(_ lc3Data: Data, _ frameSize: Int = 20) {
        guard let lc3Converter = lc3Converter else {
            Bridge.log("MAN: LC3 converter not initialized")
            return
        }

        guard lc3Data.count > 2 else {
            Bridge.log("MAN: Received invalid LC3 data size: \(lc3Data.count)")
            return
        }

        let pcmData = lc3Converter.decode(lc3Data, frameSize: frameSize) as Data
        guard pcmData.count > 0 else {
            Bridge.log("MAN: Failed to decode glasses LC3 audio")
            return
        }

        // Forward to handlePcm which handles VAD and encoding
        handlePcm(pcmData)
    }

    func handlePcm(_ pcmData: Data) {
        // handle incoming PCM data from the microphone manager and feed to the VAD:

        // feed PCM to the VAD:
        guard let vad = vad else {
            Bridge.log("VAD not initialized")
            return
        }

        if bypassVad {
            // Send audio to cloud (encoding handled by sendMicData)
            if shouldSendPcmData {
                sendMicData(pcmData)
            }

            // Send PCM to local transcriber (always needs raw PCM)
            if shouldSendTranscript {
                transcriber?.acceptAudio(pcm16le: pcmData)
            }
            return
        }

        // convert audioData to Int16 array for VAD:
        let pcmDataArray = pcmData.withUnsafeBytes { pointer -> [Int16] in
            Array(
                UnsafeBufferPointer(
                    start: pointer.bindMemory(to: Int16.self).baseAddress,
                    count: pointer.count / MemoryLayout<Int16>.stride
                ))
        }

        vad.checkVAD(pcm: pcmDataArray) { [weak self] state in
            guard let self = self else { return }
            Bridge.log("VAD State: \(state)")
        }

        let vadState = vad.currentState()
        if vadState == .speeching {
            checkSetVadStatus(speaking: true)
            // first send out whatever's in the vadBuffer (if there is anything):
            emptyVadBuffer()

            // Send audio to cloud (encoding handled by sendMicData)
            if shouldSendPcmData {
                sendMicData(pcmData)
            }

            // Send PCM to local transcriber (always needs raw PCM)
            if shouldSendTranscript {
                transcriber?.acceptAudio(pcm16le: pcmData)
            }
        } else {
            checkSetVadStatus(speaking: false)
            // add to the vadBuffer (stores PCM for potential later sending):
            addToVadBuffer(pcmData)
        }
    }

    func updateMicState() {
        // go through the micRanking and find the first mic that is available:
        var micUsed = ""

        // allow the sgc to make changes to the micRanking:
        micRanking = sgc?.sortMicRanking(list: micRanking) ?? micRanking
        Bridge.log("MAN: updateMicState() micRanking: \(micRanking)")

        var phoneMicUnavailable = systemMicUnavailable

        let appState = UIApplication.shared.applicationState
        if appState == .background {
            // Bridge.log("App is in background - onboard mic unavailable to start!")
            phoneMicUnavailable = true
        }

        if micEnabled {
            for micMode in micRanking {
                if micMode == MicTypes.PHONE_INTERNAL || micMode == MicTypes.BT_CLASSIC
                    || micMode == MicTypes.BT
                {
                    if PhoneMic.shared.isRecordingWithMode(micMode) {
                        micUsed = micMode
                        break
                    }

                    if phoneMicUnavailable {
                        continue
                    }

                    // if the phone mic is not recording, start recording:
                    let success = PhoneMic.shared.startMode(micMode)
                    Bridge.log("MAN: starting mic mode: \(micMode) -> \(success)")
                    if success {
                        micUsed = micMode
                        break
                    }
                }

                if micMode == MicTypes.GLASSES_CUSTOM {
                    // Bridge.log(
                    //     "MAN: glasses custom mic found - hasMic: \(sgc?.hasMic ?? false), micEnabled: \(sgc?.micEnabled ?? false)"
                    // )
                    // if the glasses has a mic that's already on, mark it as used and break:
                    if sgc?.hasMic ?? false {
                        // enable the mic if it's not already on:
                        if sgc?.micEnabled == false {
                            sgc?.setMicEnabled(true)
                            micUsed = micMode
                            break
                        } else {
                            // the mic is already on, mark it as used and break:
                            micUsed = micMode
                            break
                        }
                    }
                    // if the glasses doesn't have a mic, continue to the next mic:
                    continue
                }
            }
        }

        currentMic = micUsed

        // log if no mic was found:
        if micUsed == "" && micEnabled {
            Bridge.log("MAN: No available mic found!")
            return
        }

        // go through and disable all mics after the first used one:
        var allMics = micRanking
        // add any missing mics to the list:
        for micMode in MicMap.map["auto"]! {
            if !allMics.contains(micMode) {
                allMics.append(micMode)
            }
        }

        for micMode in allMics {
            if micMode == micUsed {
                continue
            }

            if micMode == MicTypes.PHONE_INTERNAL || micMode == MicTypes.BT_CLASSIC
                || micMode == MicTypes.BT
            {
                PhoneMic.shared.stopMode(micMode)
            }

            if micMode == MicTypes.GLASSES_CUSTOM && sgc?.hasMic == true && sgc?.micEnabled == true {
                sgc?.setMicEnabled(false)
            }
        }
    }

    func setOnboardMicEnabled(_ isEnabled: Bool) {
        Task {
            if isEnabled {
                // Just check permissions - we no longer request them directly from Swift
                // Permissions should already be granted via React Native UI flow
                if !(PhoneMic.shared.checkPermissions()) {
                    Bridge.log("Microphone permissions not granted. Cannot enable microphone.")
                    return
                }

                let success = PhoneMic.shared.startRecording()
                if !success {
                    // fallback to glasses mic if possible:
                    if sgc?.hasMic ?? false {
                        await sgc?.setMicEnabled(true)
                    }
                }
            } else {
                PhoneMic.shared.stopRecording()
            }
        }
    }

    // MARK: - Glasses Commands

    private func playStartupSequence() {
        Bridge.log("MAN: playStartupSequence()")
        // Arrow frames for the animation
        let arrowFrames = ["↑", "↗", "↑", "↖"]

        let delay = 0.25 // Frame delay in seconds
        let totalCycles = 2 // Number of animation cycles

        // Variables to track animation state
        var frameIndex = 0
        var cycles = 0

        // Create a dispatch queue for the animation
        let animationQueue = DispatchQueue.global(qos: .userInteractive)

        // Function to display the current animation frame
        func displayFrame() {
            // Check if we've completed all cycles
            if cycles >= totalCycles {
                // End animation with final message
                sgc?.sendTextWall("                  /// MentraOS Connected \\\\\\")
                animationQueue.asyncAfter(deadline: .now() + 1.0) {
                    self.sgc?.clearDisplay()
                }
                return
            }

            // Display current animation frame
            let frameText =
                "                    \(arrowFrames[frameIndex]) MentraOS Booting \(arrowFrames[frameIndex])"
            sgc?.sendTextWall(frameText)

            // Move to next frame
            frameIndex = (frameIndex + 1) % arrowFrames.count

            // Count completed cycles
            if frameIndex == 0 {
                cycles += 1
            }

            // Schedule next frame
            animationQueue.asyncAfter(deadline: .now() + delay) {
                displayFrame()
            }
        }

        // Start the animation after a short initial delay
        animationQueue.asyncAfter(deadline: .now() + 0.35) {
            displayFrame()
        }
    }

    // MARK: - Auxiliary Commands

    func initSGC(_ wearable: String) {
        Bridge.log("Initializing manager for wearable: \(wearable)")
        if sgc != nil && sgc?.type != wearable {
            Bridge.log("MAN: Manager already initialized, cleaning up previous sgc")
            sgc?.cleanup()
            sgc = nil
        }

        if sgc != nil {
            Bridge.log("MAN: SGC already initialized")
            return
        }

        if wearable.contains(DeviceTypes.SIMULATED) {
            sgc = Simulated()
        } else if wearable.contains(DeviceTypes.G1) {
            sgc = G1()
        } else if wearable.contains(DeviceTypes.LIVE) {
            sgc = MentraLive()
        } else if wearable.contains(DeviceTypes.MACH1) {
            sgc = Mach1()
        } else if wearable.contains(DeviceTypes.Z100) {
            sgc = Mach1() // Z100 uses same hardware/SDK as Mach1
            sgc?.type = DeviceTypes.Z100 // Override type to Z100
        } else if wearable.contains(DeviceTypes.FRAME) {
            // sgc = FrameManager()
        }
    }

    func sendCurrentState() {
        if screenDisabled {
            return
        }

        Task {
            var currentViewState: ViewState!
            if headUp {
                currentViewState = self.viewStates[1]
            } else {
                currentViewState = self.viewStates[0]
            }
            if headUp && !self.contextualDashboard {
                currentViewState = self.viewStates[0]
            }

            if sgc?.type.contains(DeviceTypes.SIMULATED) ?? true {
                // dont send the event to glasses that aren't there:
                return
            }

            var fullyBooted = sgc?.fullyBooted ?? false
            if !fullyBooted {
                return
            }

            // cancel any pending clear display work item:
            sendStateWorkItem?.cancel()

            let layoutType = currentViewState.layoutType
            switch layoutType {
            case "text_wall":
                let text = currentViewState.text
                sgc?.sendTextWall(text)
            case "double_text_wall":
                let topText = currentViewState.topText
                let bottomText = currentViewState.bottomText
                sgc?.sendDoubleTextWall(topText, bottomText)
            case "reference_card":
                sgc?.sendTextWall(currentViewState.title + "\n\n" + currentViewState.text)
            case "bitmap_view":
                Bridge.log("MAN: Processing bitmap_view layout")
                guard let data = currentViewState.data else {
                    Bridge.log("MAN: ERROR: bitmap_view missing data field")
                    return
                }
                Bridge.log("MAN: Processing bitmap_view with base64 data, length: \(data.count)")
                await sgc?.displayBitmap(base64ImageData: data)
            case "clear_view":
                sgc?.clearDisplay()
            default:
                Bridge.log("UNHANDLED LAYOUT_TYPE \(layoutType)")
            }
        }
    }

    func parsePlaceholders(_ text: String) -> String {
        let dateFormatter = DateFormatter()
        dateFormatter.dateFormat = "M/dd, h:mm"
        let formattedDate = dateFormatter.string(from: Date())

        // 12-hour time format (with leading zeros for hours)
        let time12Format = DateFormatter()
        time12Format.dateFormat = "hh:mm"
        let time12 = time12Format.string(from: Date())

        // 24-hour time format
        let time24Format = DateFormatter()
        time24Format.dateFormat = "HH:mm"
        let time24 = time24Format.string(from: Date())

        // Current date with format MM/dd
        let dateFormat = DateFormatter()
        dateFormat.dateFormat = "MM/dd"
        let currentDate = dateFormat.string(from: Date())

        var placeholders: [String: String] = [:]
        placeholders["$no_datetime$"] = formattedDate
        placeholders["$DATE$"] = currentDate
        placeholders["$TIME12$"] = time12
        placeholders["$TIME24$"] = time24

        if (sgc?.batteryLevel ?? -1) == -1 {
            placeholders["$GBATT$"] = ""
        } else {
            placeholders["$GBATT$"] = "\(sgc!.batteryLevel)%"
        }

        //        placeholders["$CONNECTION_STATUS$"] =
        //            WebSocketManager.shared.isConnected() ? "Connected" : "Disconnected"
        // TODO: config:
        placeholders["$CONNECTION_STATUS$"] = "Connected"

        var result = text
        for (key, value) in placeholders {
            result = result.replacingOccurrences(of: key, with: value)
        }

        return result
    }

    func getAudioDevicePattern() -> String {
        let audioDevicePattern: String
        if let idRange = deviceName.range(of: "_BLE_", options: .caseInsensitive) {
            // Extract the ID after "_BLE_" (e.g., "ABC123")
            audioDevicePattern = String(deviceName[idRange.upperBound...])
        } else if let idRange = deviceName.range(of: "_BT_", options: .caseInsensitive) {
            // Extract the ID after "_BT_"
            audioDevicePattern = String(deviceName[idRange.upperBound...])
        } else {
            // Fallback: use the full device name
            audioDevicePattern = deviceName
        }
        return audioDevicePattern
    }

    func checkCurrentAudioDevice() {
        let audioDevicePattern = getAudioDevicePattern()
        Bridge.log("MAN: checkCurrentAudioDevice: audioDevicePattern: \(audioDevicePattern)")

        if audioDevicePattern.isEmpty || audioDevicePattern == DeviceTypes.SIMULATED {
            glassesBtcConnected = false
            Bridge.log("MAN: Audio device pattern is empty or simulated, returning")
            return
        }

        // check if the device disconnected:
        let isConnected = AudioSessionMonitor.isAudioDeviceConnected(
            devicePattern: audioDevicePattern)

        if !isConnected {
            Bridge.log("MAN: Device '\(deviceName)' disconnected")
            glassesBtcConnected = false

            let isOtherDeviceConnected = AudioSessionMonitor.isOtherAudioDeviceConnected(devicePattern: audioDevicePattern)
            if isOtherDeviceConnected {
                Bridge.log("MAN: Other device connected, returning")
                otherBtConnected = true
            }
            return
        }

        let isPaired = AudioSessionMonitor.isDevicePaired(devicePattern: audioDevicePattern)
        if isPaired {
            let session = AVAudioSession.sharedInstance()
            let deviceName = session.availableInputs?.first(where: {
                $0.portName.localizedCaseInsensitiveContains(audioDevicePattern)
            })?.portName
            Bridge.log("MAN: ✅ Successfully detected newly paired device '\(deviceName)'")
            glassesBtcConnected = true
        } else {
            glassesBtcConnected = false
        }
    }

    func onRouteChange(
        reason: AVAudioSession.RouteChangeReason, availableInputs: [AVAudioSessionPortDescription]
    ) {
        Bridge.log("MAN: onRouteChange: reason: \(reason)")
        Bridge.log("MAN: onRouteChange: inputs: \(availableInputs)")

        // check if our deviceName is connected:
        // (return if deviceName is empty):
        if deviceName.isEmpty {
            Bridge.log("MAN: Device name is empty, returning")
            return
        }

        // Add small delay to let iOS populate availableInputs
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
            guard let self = self else { return }
            checkCurrentAudioDevice()
        }

        updateMicState()
    }

    func onInterruption(began: Bool) {
        Bridge.log("MAN: Interruption: \(began)")
        systemMicUnavailable = began
        updateMicState()
    }

    func restartTranscriber() {
        Bridge.log("MAN: Restarting SherpaOnnxTranscriber via command")
        transcriber?.restart()
    }

    // MARK: - connection state management

    func handleDeviceReady() {
        guard let sgc else {
            Bridge.log("MAN: SGC is nil, returning")
            return
        }
        Bridge.log("MAN: handleDeviceReady(): \(sgc.type)")

        pendingWearable = ""
        defaultWearable = sgc.type
        searching = false

        // Show welcome message on first connect for all display glasses
        if shouldSendBootingMessage {
            Task {
                sgc.sendTextWall("// MentraOS Connected")
                try? await Task.sleep(nanoseconds: 3_000_000_000) // 1 second
                sgc.clearDisplay()
            }
            shouldSendBootingMessage = false
        }

        // Call device-specific setup handlers
        if defaultWearable.contains(DeviceTypes.G1) {
            handleG1Ready()
        } else if defaultWearable.contains(DeviceTypes.MACH1) {
            handleMach1Ready()
        } else if defaultWearable.contains(DeviceTypes.Z100) {
            handleMach1Ready() // Z100 uses same initialization as Mach1
        }

        // check current audio device:
        checkCurrentAudioDevice()

        // save the default_wearable now that we're connected:
        Bridge.saveSetting("default_wearable", defaultWearable)
        Bridge.saveSetting("device_name", deviceName)
        //        Bridge.saveSetting("device_address", deviceAddress)
    }

    private func handleG1Ready() {
        // G1-specific setup and configuration
        Task {
            // give the glasses some extra time to finish booting:
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            await sgc?.setSilentMode(false) // turn off silent mode
            await sgc?.getBatteryStatus()

            // send loaded settings to glasses:
            try? await Task.sleep(nanoseconds: 400_000_000)
            sgc?.setHeadUpAngle(headUpAngle)
            try? await Task.sleep(nanoseconds: 400_000_000)
            sgc?.setBrightness(brightness, autoMode: autoBrightness)
            try? await Task.sleep(nanoseconds: 400_000_000)
            // self.g1Manager?.RN_setDashboardPosition(self.dashboardHeight, self.dashboardDepth)
            // try? await Task.sleep(nanoseconds: 400_000_000)
            //      playStartupSequence()
        }
    }

    private func handleMach1Ready() {}

    func handleDeviceDisconnected() {
        Bridge.log("MAN: Device disconnected")
        // setMicState(shouldSendPcmData, shouldSendTranscript, false)
        // shouldSendBootingMessage = true  // Reset for next first connect
    }

    // MARK: - Network Command handlers

    func displayText(_ params: [String: Any]) {
        guard let text = params["text"] as? String else {
            Bridge.log("MAN: display_text missing text parameter")
            return
        }

        Bridge.log("MAN: Displaying text: \(text)")
        sgc?.sendTextWall(text)
    }

    func displayEvent(_ event: [String: Any]) {
        guard let view = event["view"] as? String else {
            Bridge.log("MAN: invalid view")
            return
        }
        let isDashboard = view == "dashboard"

        var stateIndex = 0
        if isDashboard {
            stateIndex = 1
        } else {
            stateIndex = 0
        }

        let layout = event["layout"] as! [String: Any]
        let layoutType = layout["layoutType"] as! String
        var text = layout["text"] as? String ?? " "
        var topText = layout["topText"] as? String ?? " "
        var bottomText = layout["bottomText"] as? String ?? " "
        var title = layout["title"] as? String ?? " "
        var data = layout["data"] as? String ?? ""

        text = parsePlaceholders(text)
        topText = parsePlaceholders(topText)
        bottomText = parsePlaceholders(bottomText)
        title = parsePlaceholders(title)

        var newViewState = ViewState(
            topText: topText, bottomText: bottomText, title: title, layoutType: layoutType,
            text: text, data: data, animationData: nil
        )

        if layoutType == "bitmap_animation" {
            if let frames = layout["frames"] as? [String],
               let interval = layout["interval"] as? Double
            {
                let animationData: [String: Any] = [
                    "frames": frames,
                    "interval": interval,
                    "repeat": layout["repeat"] as? Bool ?? true,
                ]
                newViewState.animationData = animationData
                Bridge.log(
                    "MAN: Parsed bitmap_animation with \(frames.count) frames, interval: \(interval)ms"
                )
            } else {
                Bridge.log("MAN: ERROR: bitmap_animation missing frames or interval")
            }
        }

        let cS = viewStates[stateIndex]
        let nS = newViewState
        let currentState =
            cS.layoutType + cS.text + cS.topText + cS.bottomText + cS.title + (cS.data ?? "")
        let newState =
            nS.layoutType + nS.text + nS.topText + nS.bottomText + nS.title + (nS.data ?? "")

        if currentState == newState {
            // Core.log("MAN: View state is the same, skipping update")
            return
        }

        // Bridge.log("MAN: Updating view state \(stateIndex) with \(layoutType) \(text) \(topText) \(bottomText)")

        viewStates[stateIndex] = newViewState

        let hUp = headUp && contextualDashboard
        // send the state we just received if the user is currently in that state:
        if stateIndex == 0 && !hUp {
            sendCurrentState()
        } else if stateIndex == 1 && hUp {
            sendCurrentState()
        }
    }

    func showDashboard() {
        sgc?.showDashboard()
    }

    func startRtmpStream(_ message: [String: Any]) {
        Bridge.log("MAN: startRtmpStream: \(message)")
        sgc?.startRtmpStream(message)
    }

    func stopRtmpStream() {
        Bridge.log("MAN: stopRtmpStream")
        sgc?.stopRtmpStream()
    }

    func keepRtmpStreamAlive(_ message: [String: Any]) {
        Bridge.log("MAN: sendRtmpKeepAlive: \(message)")
        sgc?.sendRtmpKeepAlive(message)
    }

    func requestWifiScan() {
        Bridge.log("MAN: Requesting wifi scan")
        GlassesStore.shared.apply("core", "wifiScanResults", [])
        sgc?.requestWifiScan()
    }

    func sendWifiCredentials(_ ssid: String, _ password: String) {
        Bridge.log("MAN: Sending wifi credentials: \(ssid) \(password)")
        sgc?.sendWifiCredentials(ssid, password)
    }

    func forgetWifiNetwork(_ ssid: String) {
        Bridge.log("MAN: Forgetting wifi network: \(ssid)")
        sgc?.forgetWifiNetwork(ssid)
    }

    func setHotspotState(_ enabled: Bool) {
        Bridge.log("MAN: 🔥 Setting glasses hotspot state: \(enabled)")
        sgc?.sendHotspotState(enabled)
    }

    func queryGalleryStatus() {
        Bridge.log("MAN: 📸 Querying gallery status from glasses")
        sgc?.queryGalleryStatus()
    }

    /// Send OTA start command to glasses.
    /// Called when user approves an update (onboarding or background mode).
    /// Triggers glasses to begin download and installation.
    func sendOtaStart() {
        Bridge.log("MAN: 📱 Sending OTA start command to glasses")
        sgc?.sendOtaStart()
    }

    /// Request version info from glasses.
    /// Glasses will respond with version_info message containing build number, firmware version, etc.
    func requestVersionInfo() {
        Bridge.log("MAN: 📱 Requesting version info from glasses")
        sgc?.requestVersionInfo()
    }

    /// Send shutdown command to glasses.
    /// This will initiate a graceful shutdown of the device.
    func sendShutdown() {
        Bridge.log("MAN: 🔌 Sending shutdown command to glasses")
        sgc?.sendShutdown()
    }

    /// Send reboot command to glasses.
    /// This will initiate a reboot of the device.
    func sendReboot() {
        Bridge.log("MAN: 🔄 Sending reboot command to glasses")
        sgc?.sendReboot()
    }

    func startBufferRecording() {
        Bridge.log("MAN: onStartBufferRecording")
        sgc?.startBufferRecording()
    }

    func stopBufferRecording() {
        Bridge.log("MAN: onStopBufferRecording")
        sgc?.stopBufferRecording()
    }

    func saveBufferVideo(_ requestId: String, _ durationSeconds: Int) {
        Bridge.log(
            "MAN: onSaveBufferVideo: requestId=\(requestId), duration=\(durationSeconds)s")
        sgc?.saveBufferVideo(requestId: requestId, durationSeconds: durationSeconds)
    }

    func startVideoRecording(_ requestId: String, _ save: Bool, _ silent: Bool) {
        Bridge.log(
            "MAN: onStartVideoRecording: requestId=\(requestId), save=\(save), silent=\(silent)")
        sgc?.startVideoRecording(requestId: requestId, save: save, silent: silent)
    }

    func stopVideoRecording(_ requestId: String) {
        Bridge.log("MAN: onStopVideoRecording: requestId=\(requestId)")
        sgc?.stopVideoRecording(requestId: requestId)
    }

    func setMicState(_ sendPcm: Bool, _ sendTranscript: Bool, _ bypassVadForPCM: Bool) {
        Bridge.log("MAN: setMicState(\(sendPcm),\(sendTranscript),\(bypassVadForPCM))")

        shouldSendPcmData = sendPcm
        shouldSendTranscript = sendTranscript
        bypassVad = bypassVadForPCM

        micEnabled = shouldSendPcmData || shouldSendTranscript
        updateMicState()
    }

    func rgbLedControl(
        requestId: String,
        packageName: String?,
        action: String,
        color: String?,
        ontime: Int,
        offtime: Int,
        count: Int
    ) {
        sgc?.sendRgbLedControl(
            requestId: requestId,
            packageName: packageName,
            action: action,
            color: color,
            ontime: ontime,
            offtime: offtime,
            count: count
        )
    }

    func photoRequest(
        _ requestId: String,
        _ appId: String,
        _ size: String,
        _ webhookUrl: String?,
        _ authToken: String?,
        _ compress: String?,
        _ silent: Bool
    ) {
        Bridge.log(
            "MAN: onPhotoRequest: \(requestId), \(appId), \(webhookUrl), size=\(size), compress=\(compress ?? "none"), silent=\(silent)"
        )
        sgc?.requestPhoto(
            requestId, appId: appId, size: size, webhookUrl: webhookUrl, authToken: authToken,
            compress: compress, silent: silent
        )
    }

    func connectDefault() {
        if defaultWearable.isEmpty {
            Bridge.log("MAN: No default wearable, returning")
            return
        }
        if deviceName.isEmpty {
            Bridge.log("MAN: No device name, returning")
            return
        }
        initSGC(defaultWearable)
        searching = true
        sgc?.connectById(deviceName)
    }

    func connectByName(_ dName: String) {
        Bridge.log("MAN: Connecting to wearable: \(dName)")
        var name = dName

        // use stored device name if available:
        if dName.isEmpty && !deviceName.isEmpty {
            name = deviceName
        }

        if pendingWearable.isEmpty, defaultWearable.isEmpty {
            Bridge.log("MAN: No pending or default wearable, returning")
            return
        }

        if pendingWearable.isEmpty, !defaultWearable.isEmpty {
            Bridge.log("MAN: No pending wearable, using default wearable: \(defaultWearable)")
            pendingWearable = defaultWearable
        }

        Task {
            disconnect()
            try? await Task.sleep(nanoseconds: 100 * 1_000_000) // 100ms
            self.searching = true
            self.deviceName = name

            initSGC(self.pendingWearable)
            sgc?.connectById(self.deviceName)
        }
    }

    func connectSimulated() {
        defaultWearable = DeviceTypes.SIMULATED
        deviceName = DeviceTypes.SIMULATED
        initSGC(defaultWearable)
        handleDeviceReady()
    }

    func disconnect() {
        sgc?.clearDisplay() // clear the screen
        sgc?.disconnect()
        sgc = nil // Clear the SGC reference after disconnect
        searching = false
        shouldSendPcmData = false
        shouldSendTranscript = false
        setMicState(shouldSendPcmData, shouldSendTranscript, bypassVad)
        shouldSendBootingMessage = true // Reset for next first connect
        GlassesStore.shared.apply("glasses", "fullyBooted", false)
        GlassesStore.shared.apply("glasses", "connected", false)
    }

    func forget() {
        Bridge.log("MAN: Forgetting smart glasses")

        // Call forget first to stop timers/handlers/reconnect logic
        sgc?.forget()

        disconnect()

        // Clear state
        defaultWearable = ""
        deviceName = ""
        Bridge.saveSetting("default_wearable", "")
        Bridge.saveSetting("device_name", "")
    }

    func findCompatibleDevices(_ deviceModel: String) {
        Bridge.log("MAN: Searching for compatible device names for: \(deviceModel)")

        // reset the search results:
        searchResults = []

        if DeviceTypes.ALL.contains(deviceModel) {
            pendingWearable = deviceModel
        }

        initSGC(pendingWearable)
        sgc?.findCompatibleDevices()
    }

    func cleanup() {
        // Clean up transcriber resources
        transcriber?.shutdown()
        transcriber = nil

        // Clean up LC3 converter
        lc3Converter = nil

        cancellables.removeAll()
    }
}
