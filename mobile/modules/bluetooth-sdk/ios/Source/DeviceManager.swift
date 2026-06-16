//
//  DeviceManager.swift
//  MentraOS_Manager
//
//  Created by Matthew Fosse on 3/5/25.
//

import AVFoundation
import Combine
import CoreBluetooth
import Foundation
import UIKit
#if SWIFT_PACKAGE
import MentraBluetoothSDKCoreObjC
#endif

struct ViewState {
    var topText: String
    var bottomText: String
    var title: String
    var layoutType: String
    var text: String
    var data: String?
    var animationData: [String: Any]?
    // Optional bitmap_view container position/size (used by G2; ignored by others)
    var bmpX: Int32?
    var bmpY: Int32?
    var bmpWidth: Int32?
    var bmpHeight: Int32?
}

@MainActor
@objc(DeviceManager) class DeviceManager: NSObject {
    static let shared = DeviceManager()

    @objc static func getInstance() -> DeviceManager {
        return DeviceManager.shared
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
            glassesBluetoothClassicConnected = true
        } else {
            glassesBluetoothClassicConnected = false
            // Not found in availableInputs - not paired yet

            // Start monitoring for when user pairs manually
            AudioSessionMonitor.startMonitoring(devicePattern: audioDevicePattern) {
                [weak self] (connected: Bool, _: String?) in
                guard let self = self else { return }

                if connected {
                    Bridge.log("Audio: ✅ Device paired and connected")
                    // Don't activate - let PhoneMic.swift handle that when recording starts
                    self.glassesBluetoothClassicConnected = true
                } else {
                    Bridge.log("Audio: Device disconnected")
                    self.glassesBluetoothClassicConnected = false
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
    var controller: ControllerManager?

    // state
    // var lastStatusObj: [String: Any] = [:]

    /// settings:
    private var defaultWearable: String {
        get { DeviceStore.shared.get("bluetooth", "default_wearable") as? String ?? "" }
        set { DeviceStore.shared.apply("bluetooth", "default_wearable", newValue) }
    }

    private var pendingWearable: String {
        get { DeviceStore.shared.get("bluetooth", "pending_wearable") as? String ?? "" }
        set { DeviceStore.shared.apply("bluetooth", "pending_wearable", newValue) }
    }

    private var deviceName: String {
        get { DeviceStore.shared.get("bluetooth", "device_name") as? String ?? "" }
        set { DeviceStore.shared.apply("bluetooth", "device_name", newValue) }
    }

    private var deviceAddress: String {
        get { DeviceStore.shared.get("bluetooth", "device_address") as? String ?? "" }
        set { DeviceStore.shared.apply("bluetooth", "device_address", newValue) }
    }

    private var defaultController: String {
        get { DeviceStore.shared.get("bluetooth", "default_controller") as? String ?? "" }
        set { DeviceStore.shared.apply("bluetooth", "default_controller", newValue) }
    }

    private var pendingController: String {
        get { DeviceStore.shared.get("bluetooth", "pending_controller") as? String ?? "" }
        set { DeviceStore.shared.apply("bluetooth", "pending_controller", newValue) }
    }

    private var controllerDeviceName: String {
        get { DeviceStore.shared.get("bluetooth", "controller_device_name") as? String ?? "" }
        set { DeviceStore.shared.apply("bluetooth", "controller_device_name", newValue) }
    }

    private var screenDisabled: Bool {
        get { DeviceStore.shared.get("bluetooth", "screen_disabled") as? Bool ?? false }
        set { DeviceStore.shared.apply("bluetooth", "screen_disabled", newValue) }
    }

    private var preferredMic: String {
        get { DeviceStore.shared.get("bluetooth", "preferred_mic") as? String ?? "auto" }
        set { DeviceStore.shared.apply("bluetooth", "preferred_mic", newValue) }
    }

    private var autoBrightness: Bool {
        get { DeviceStore.shared.get("bluetooth", "auto_brightness") as? Bool ?? true }
        set { DeviceStore.shared.apply("bluetooth", "auto_brightness", newValue) }
    }

    private var brightness: Int {
        get { DeviceStore.shared.get("bluetooth", "brightness") as? Int ?? 50 }
        set { DeviceStore.shared.apply("bluetooth", "brightness", newValue) }
    }

    private var headUpAngle: Int {
        get { DeviceStore.shared.get("bluetooth", "head_up_angle") as? Int ?? 30 }
        set { DeviceStore.shared.apply("bluetooth", "head_up_angle", newValue) }
    }

    private var sensingEnabled: Bool {
        get { DeviceStore.shared.get("bluetooth", "sensing_enabled") as? Bool ?? true }
        set { DeviceStore.shared.apply("bluetooth", "sensing_enabled", newValue) }
    }

    /// Phone-side VAD gating switch. Default is OFF (VAD runs) so that the
    /// coordinator can drive per-utterance offline/online STT switching from
    /// `vad_status` events. Set to `true` only as an emergency kill-switch.
    private var bypassVad: Bool {
        get { DeviceStore.shared.get("bluetooth", "bypass_vad") as? Bool ?? false }
        set { DeviceStore.shared.apply("bluetooth", "bypass_vad", newValue) }
    }

    private var offlineCaptionsRunning: Bool {
        get { DeviceStore.shared.get("bluetooth", "offline_captions_running") as? Bool ?? false }
        set { DeviceStore.shared.apply("bluetooth", "offline_captions_running", newValue) }
    }

    private var localSttFallbackActive: Bool {
        get { DeviceStore.shared.get("bluetooth", "local_stt_fallback_active") as? Bool ?? false }
        set { DeviceStore.shared.apply("bluetooth", "local_stt_fallback_active", newValue) }
    }

    private var shouldSendPcm: Bool {
        get { DeviceStore.shared.get("bluetooth", "should_send_pcm") as? Bool ?? false }
        set { DeviceStore.shared.apply("bluetooth", "should_send_pcm", newValue) }
    }

    private var shouldSendLc3: Bool {
        get { DeviceStore.shared.get("bluetooth", "should_send_lc3") as? Bool ?? false }
        set { DeviceStore.shared.apply("bluetooth", "should_send_lc3", newValue) }
    }

    private var shouldSendTranscript: Bool {
        get { DeviceStore.shared.get("bluetooth", "should_send_transcript") as? Bool ?? false }
        set { DeviceStore.shared.apply("bluetooth", "should_send_transcript", newValue) }
    }

    private var contextualDashboard: Bool {
        get { DeviceStore.shared.get("bluetooth", "contextual_dashboard") as? Bool ?? true }
        set { DeviceStore.shared.apply("bluetooth", "contextual_dashboard", newValue) }
    }

    // state:

    private var searching: Bool {
        get { DeviceStore.shared.get("bluetooth", "searching") as? Bool ?? false }
        set { DeviceStore.shared.apply("bluetooth", "searching", newValue) }
    }

    private var searchingController: Bool {
        get { DeviceStore.shared.get("bluetooth", "searchingController") as? Bool ?? false }
        set { DeviceStore.shared.apply("bluetooth", "searchingController", newValue) }
    }

    private var glassesBluetoothClassicConnected: Bool {
        get { DeviceStore.shared.get("glasses", "bluetoothClassicConnected") as? Bool ?? false }
        set { DeviceStore.shared.apply("glasses", "bluetoothClassicConnected", newValue) }
    }

    private var micRanking: [String] {
        get {
            DeviceStore.shared.get("bluetooth", "micRanking") as? [String] ?? MicMap.map["auto"]!
        }
        set { DeviceStore.shared.apply("bluetooth", "micRanking", newValue) }
    }

    private var shouldSendBootingMessage: Bool {
        get { DeviceStore.shared.get("bluetooth", "shouldSendBootingMessage") as? Bool ?? true }
        set { DeviceStore.shared.apply("bluetooth", "shouldSendBootingMessage", newValue) }
    }

    private var lastSystemTimeSyncConnectionKey = ""

    private var systemMicUnavailable: Bool {
        get { DeviceStore.shared.get("bluetooth", "systemMicUnavailable") as? Bool ?? false }
        set { DeviceStore.shared.apply("bluetooth", "systemMicUnavailable", newValue) }
    }

    private var headUp: Bool {
        get { DeviceStore.shared.get("glasses", "headUp") as? Bool ?? false }
        set { DeviceStore.shared.apply("glasses", "headUp", newValue) }
    }

    private var micEnabled: Bool {
        get { DeviceStore.shared.get("bluetooth", "micEnabled") as? Bool ?? false }
        set { DeviceStore.shared.apply("bluetooth", "micEnabled", newValue) }
    }

    private var currentMic: String {
        get { DeviceStore.shared.get("bluetooth", "currentMic") as? String ?? "" }
        set { DeviceStore.shared.apply("bluetooth", "currentMic", newValue) }
    }

    private var searchResults: [[String: Any]] {
        get { DeviceStore.shared.get("bluetooth", "searchResults") as? [[String: Any]] ?? [] }
        set { DeviceStore.shared.apply("bluetooth", "searchResults", newValue) }
    }

    private var wifiScanResults: [[String: Any]] {
        get { DeviceStore.shared.get("bluetooth", "wifiScanResults") as? [[String: Any]] ?? [] }
        set { DeviceStore.shared.apply("bluetooth", "wifiScanResults", newValue) }
    }

    private var lastLog: [String] {
        get { DeviceStore.shared.get("bluetooth", "lastLog") as? [String] ?? [] }
        set { DeviceStore.shared.apply("bluetooth", "lastLog", newValue) }
    }

    private var otherBtConnected: Bool {
        get { DeviceStore.shared.get("bluetooth", "otherBtConnected") as? Bool ?? false }
        set { DeviceStore.shared.apply("bluetooth", "otherBtConnected", newValue) }
    }

    /// LC3 Audio Encoding
    /// Audio output format enum
    enum AudioOutputFormat { case lc3, pcm }
    /// Canonical LC3 config: 16kHz sample rate, 10ms frame duration
    /// Frame size is configurable: 20 bytes (16kbps), 40 bytes (32kbps), 60 bytes (48kbps)
    /// Persistent LC3 converter for encoding/decoding
    var lc3Converter: PcmConverter?
    /// Audio output format - defaults to LC3 for bandwidth savings
    private var audioOutputFormat: AudioOutputFormat = .lc3
    /// Last time we received an LC3 frame from the glasses (used by the mic
    /// inactivity watchdog).
    private var lastLc3Event: Date?
    private var micReinitTimer: Timer?

    /// STT:
    #if !SWIFT_PACKAGE || MENTRA_FEATURE_LOCAL_STT
    private var transcriber: SherpaOnnxTranscriber?
    #endif

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
        super.init()

        // Start memory monitoring (logs every 30s to help detect leaks)
        // MemoryMonitor.start()

        // Initialize SherpaOnnx Transcriber
        #if !SWIFT_PACKAGE || MENTRA_FEATURE_LOCAL_STT
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
        #endif

        // Initialize persistent LC3 converter for unified audio encoding
        lc3Converter = PcmConverter()
        Bridge.log("LC3 converter initialized for unified audio encoding")

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.micReinitTimer = Timer.scheduledTimer(
                withTimeInterval: 10.0, repeats: true
            ) { [weak self] _ in
                self?.checkAndReinitGlassesMic()
            }
        }
    }

    // MARK: - AUX Voice Data Handling

    private func convertAndSendMicLc3(_ pcmData: Data) {
        guard let lc3Converter = lc3Converter else {
            Bridge.log("MAN: ERROR - LC3 converter not initialized but format is LC3")
            return
        }
        let frameSize = DeviceStore.shared.get("bluetooth", "lc3_frame_size") as! Int
        let lc3Data = lc3Converter.encode(pcmData, frameSize: frameSize) as Data
        guard lc3Data.count > 0 else {
            Bridge.log("MAN: ERROR - LC3 encoding returned empty data")
            return
        }
        Bridge.sendMicLc3(lc3Data)
    }

    private func handleSendingPcm(_ pcmData: Data) {
        // Bridge.log("MAN: handleSendingPcm() shouldSendPcm: \(shouldSendPcm) shouldSendLc3: \(shouldSendLc3)")
        if shouldSendPcm {
            Bridge.sendMicPcm(pcmData)
        }
        if shouldSendLc3 {
            convertAndSendMicLc3(pcmData)
        }
    }

    /**
     * Handle raw LC3 audio data from glasses.
     * Decodes the glasses LC3 to PCM, then forwards to handlePcm for processing.
     * This matches Android behavior - glasses forward raw LC3, DeviceManager handles encoding.
     */
    func handleGlassesMicData(_ lc3Data: Data, _ frameSize: Int = 20) {
        lastLc3Event = Date()
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
        // Forward to handlePcm which handles SDK audio events and encoding.
        handlePcm(pcmData)
    }

    func handlePcm(_ pcmData: Data) {
        handleSendingPcm(pcmData)

        // Send PCM to local transcriber.
#if !SWIFT_PACKAGE || MENTRA_FEATURE_LOCAL_STT
        if shouldSendTranscript || offlineCaptionsRunning || localSttFallbackActive {
            transcriber?.acceptAudio(pcm16le: pcmData)
        }
#endif
    }

    func updateMicState() {
        // go through the micRanking and find the first mic that is available:
        var micUsed = ""

        // allow the sgc to make changes to the micRanking:
        micRanking = sgc?.sortMicRanking(list: micRanking) ?? micRanking
        // Bridge.log("MAN: updateMicState() micRanking: \(micRanking)")

        var phoneMicUnavailable = systemMicUnavailable

        let appState = UIApplication.shared.applicationState
        if appState == .background {
            // Bridge.log("App is in background - onboard mic unavailable to start!")
            phoneMicUnavailable = true
        }

        if micEnabled {
            for micMode in micRanking {
                if micMode == MicTypes.PHONE_INTERNAL || micMode == MicTypes.BLUETOOTH_CLASSIC
                    || micMode == MicTypes.BLUETOOTH
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

            if micMode == MicTypes.PHONE_INTERNAL || micMode == MicTypes.BLUETOOTH_CLASSIC
                || micMode == MicTypes.BLUETOOTH
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

        /// Function to display the current animation frame
        func displayFrame() {
            // Check if we've completed all cycles
            if cycles >= totalCycles {
                // End animation with final message
                Task { await sgc?.sendTextWall("                  /// MentraOS Connected \\\\\\") }
                animationQueue.asyncAfter(deadline: .now() + 1.0) {
                    self.sgc?.clearDisplay()
                }
                return
            }

            // Display current animation frame
            let frameText =
                "                    \(arrowFrames[frameIndex]) MentraOS Booting \(arrowFrames[frameIndex])"
            Task { await sgc?.sendTextWall(frameText) }

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
            lastSystemTimeSyncConnectionKey = ""
        }

        if sgc != nil {
            Bridge.log("MAN: SGC already initialized")
            return
        }
        if wearable.contains(DeviceTypes.SIMULATED) {
            sgc = Simulated()
        } else if wearable.contains(DeviceTypes.G1) {
            sgc = G1()
        } else if wearable.contains(DeviceTypes.G2) {
            sgc = G2()
        } else if wearable.contains(DeviceTypes.LIVE) {
            sgc = MentraLive()
        } else if wearable.contains(DeviceTypes.FRAME) {
            // sgc = FrameManager()
        }
#if !SWIFT_PACKAGE || MENTRA_FEATURE_NEX
        if sgc == nil && wearable.contains(DeviceTypes.NEX) {
            sgc = MentraNexSGC.getInstance()
        }
#endif
#if !SWIFT_PACKAGE || MENTRA_FEATURE_VUZIX
        if sgc == nil {
            if wearable.contains(DeviceTypes.MACH1) {
                sgc = Mach1()
            } else if wearable.contains(DeviceTypes.Z100) {
                sgc = Mach1() // Z100 uses same hardware/SDK as Mach1
                sgc?.type = DeviceTypes.Z100 // Override type to Z100
            }
        }
#endif
        // update device model:
        DeviceStore.shared.apply("glasses", "deviceModel", sgc?.type ?? "")
    }

    func initController(_ controllerModel: String) {
        Bridge.log("MAN: Initializing controller: \(controllerModel)")
        if controller != nil && controller?.type != controllerModel {
            Bridge.log("MAN: Controller already initialized, cleaning up previous controller")
            controller?.cleanup()
            controller = nil
        }

        if controller != nil {
            Bridge.log("MAN: Controller already initialized")
            return
        }

        if controllerModel == ControllerTypes.R1 {
            controller = R1()
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
                await sgc?.sendTextWall(text)
            case "double_text_wall":
                let topText = currentViewState.topText
                let bottomText = currentViewState.bottomText
                await sgc?.sendDoubleTextWall(topText, bottomText)
            case "reference_card":
                await sgc?.sendTextWall(currentViewState.title + "\n\n" + currentViewState.text)
            case "bitmap_view":
                // Bridge.log("MAN: Processing bitmap_view layout")
                guard let data = currentViewState.data else {
                    Bridge.log("MAN: ERROR: bitmap_view missing data field")
                    return
                }
                // Bridge.log("MAN: Processing bitmap_view with base64 data, length: \(data.count)")
                await sgc?.displayBitmap(
                    base64ImageData: data,
                    x: currentViewState.bmpX,
                    y: currentViewState.bmpY,
                    width: currentViewState.bmpWidth,
                    height: currentViewState.bmpHeight
                )
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

    private func checkAndReinitGlassesMic() {
        // if the glasses mic is marked as enabled (and the glasses are connected), but our last known lc3 event is from > 5 seconds ago, reinitialize the mic:
        let glassesMicEnabled = DeviceStore.shared.get("glasses", "micEnabled") as? Bool ?? false
        let glassesConnected = DeviceStore.shared.get("glasses", "connected") as? Bool ?? false
        if !glassesMicEnabled || !glassesConnected {
            return
        }

        let timeSinceLastLc3Event = Date().timeIntervalSince(lastLc3Event ?? Date())
        if timeSinceLastLc3Event > 5 {
            Bridge.log("MAN: No audio activity in the last 5 seconds from glasses, reinitializing glasses mic")
            sgc?.setMicEnabled(true)
        }
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
            glassesBluetoothClassicConnected = false
            Bridge.log("MAN: Audio device pattern is empty or simulated, returning")
            return
        }

        // check if the device disconnected:
        let isConnected = AudioSessionMonitor.isAudioDeviceConnected(
            devicePattern: audioDevicePattern
        )

        if !isConnected {
            Bridge.log("MAN: Device '\(deviceName)' disconnected")
            glassesBluetoothClassicConnected = false

            let isOtherDeviceConnected = AudioSessionMonitor.isOtherAudioDeviceConnected(
                devicePattern: audioDevicePattern
            )
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
            glassesBluetoothClassicConnected = true
        } else {
            glassesBluetoothClassicConnected = false
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
        #if !SWIFT_PACKAGE || MENTRA_FEATURE_LOCAL_STT
        Bridge.log("MAN: Restarting SherpaOnnxTranscriber via command")
        transcriber?.restart()
        #else
        Bridge.log("MAN: Local STT is not included in this SwiftPM build")
        #endif
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

        let connectionKey = "\(sgc.type):\(deviceName)"
        syncSystemTimeOnceForConnection(sgc, connectionKey: connectionKey)
        
        // re-apply display height/depth after reconnection
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            // Re-read the current sgc rather than capturing the connect-time instance: the user may
            // have disconnected or switched glasses during the 2s window, and we must not push to a
            // stale/torn-down connection.
            guard let sgc = self?.sgc else { return }
            let h = DeviceStore.shared.get("bluetooth", "dashboard_height") as? Int ?? 4
            // Fall back to the canonical default (2), matching DeviceStore — not 1.
            let rawDepth = DeviceStore.shared.get("bluetooth", "dashboard_depth") as? Int ?? 2
            let d = min(max(rawDepth, 1), 4)
            sgc.setDashboardPosition(h, d)
        }

        // Show welcome message on first connect for all display glasses
        if shouldSendBootingMessage {
            Task {
                await sgc.sendTextWall("// MentraOS Connected")
                try? await Task.sleep(nanoseconds: 3_000_000_000) // 1 second
                sgc.clearDisplay()
            }
            shouldSendBootingMessage = false
        }

        // Call device-specific setup handlers
        if defaultWearable.contains(DeviceTypes.G1) {
            handleG1Ready()
        } else if defaultWearable.contains(DeviceTypes.G2) {
            // handleG2Ready()
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
        Bridge.saveSetting("device_address", deviceAddress)

    }

    private func syncSystemTimeOnceForConnection(_ sgc: SGCManager, connectionKey: String) {
        if sgc.type.contains(DeviceTypes.SIMULATED) {
            return
        }
        if connectionKey == lastSystemTimeSyncConnectionKey {
            return
        }

        lastSystemTimeSyncConnectionKey = connectionKey
        let timestampMs = Int64(Date().timeIntervalSince1970 * 1000)
        Bridge.log("MAN: Syncing glasses system time once for connection: \(timestampMs)")
        sgc.sendSetSystemTime(timestampMs)
    }

    func handleControllerReady() {
        guard let controller else {
            Bridge.log("MAN: Controller is nil, returning")
            return
        }
        Bridge.log("MAN: handleControllerReady(): \(controller.type)")

        pendingController = ""
        defaultController = controller.type
        searching = false

        // save the default_controller now that we're connected:
        Bridge.saveSetting("default_controller", defaultController)
        Bridge.saveSetting("controller_device_name", controllerDeviceName)
    }

    func handleControllerDisconnected() {
        Bridge.log("MAN: Controller disconnected")
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
        lastSystemTimeSyncConnectionKey = ""
        DeviceStore.shared.apply("glasses", "headUp", false)
        DeviceStore.shared.apply("glasses", "voiceActivityDetectionEnabled", BluetoothSdkDefaults.voiceActivityDetectionEnabled)
        // shouldSendBootingMessage = true  // Reset for next first connect
    }

    // MARK: - Network Command handlers

    func displayText(_ params: [String: Any]) {
        guard let text = params["text"] as? String else {
            Bridge.log("MAN: display_text missing text parameter")
            return
        }

        Bridge.log("MAN: Displaying text: \(text)")
        Task { await sgc?.sendTextWall(text) }
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

        // Optional bitmap_view container position/size (forwarded to the SGC; used by G2).
        let bmpX = (layout["x"] as? NSNumber).map { $0.int32Value }
        let bmpY = (layout["y"] as? NSNumber).map { $0.int32Value }
        let bmpWidth = (layout["width"] as? NSNumber).map { $0.int32Value }
        let bmpHeight = (layout["height"] as? NSNumber).map { $0.int32Value }

        text = parsePlaceholders(text)
        topText = parsePlaceholders(topText)
        bottomText = parsePlaceholders(bottomText)
        title = parsePlaceholders(title)

        var newViewState = ViewState(
            topText: topText, bottomText: bottomText, title: title, layoutType: layoutType,
            text: text, data: data, animationData: nil,
            bmpX: bmpX, bmpY: bmpY, bmpWidth: bmpWidth, bmpHeight: bmpHeight
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

    func showNotificationsPanel() {
        Task { await sgc?.showNotificationsPanel() }
    }

    func ping() {
        sgc?.ping()
    }

    func dbg1() {
        // sgc?.disconnectController()
        // connectDefaultController()
    }

    func dbg2() {}

    func startStream(_ message: [String: Any]) {
        var message = message
        message["flash"] = true
        Bridge.log("MAN: startStream: \(message)")
        sgc?.startStream(message)
    }

    func stopStream() {
        Bridge.log("MAN: stopStream")
        sgc?.stopStream()
    }

    func keepStreamAlive(_ message: [String: Any]) {
        Bridge.log("MAN: sendStreamKeepAlive: \(message)")
        sgc?.sendStreamKeepAlive(message)
    }

    func requestWifiScan() {
        Bridge.log("MAN: Requesting wifi scan")
        DeviceStore.shared.apply("bluetooth", "wifiScanResults", [])
        sgc?.requestWifiScan()
    }

    func sendIncidentId(_ incidentId: String, apiBaseUrl: String? = nil) {
        Bridge.log("MAN: Sending incidentId to glasses for log upload: \(incidentId)")
        sgc?.sendIncidentId(incidentId, apiBaseUrl: apiBaseUrl)
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

    func setSystemTime(_ timestampMs: Int64) {
        Bridge.log("MAN: Setting glasses system time: \(timestampMs)")
        sgc?.sendSetSystemTime(timestampMs)
    }

    func queryGalleryStatus() {
        Bridge.log("MAN: 📸 Querying gallery status from glasses")
        sgc?.queryGalleryStatus()
    }

    /// Send OTA start command to glasses.
    /// Called when user approves an update (onboarding or background mode).
    /// Triggers glasses to begin download and installation.
    func sendOtaStart(otaVersionUrl: String? = nil) {
        Bridge.log("MAN: 📱 Sending OTA start command to glasses")
        sgc?.sendOtaStart(otaVersionUrl: otaVersionUrl)
    }

    func sendOtaQueryStatus() {
        Bridge.log("MAN: 📱 Sending OTA query status command to glasses")
        (sgc as? MentraLive)?.sendOtaQueryStatus()
    }

    private func liveSgc() throws -> MentraLive {
        guard let live = sgc as? MentraLive else {
            throw BluetoothError(code: "unsupported_device", message: "This command requires Mentra Live glasses.")
        }
        return live
    }

    func sendGalleryMode(requestId: String, enabled: Bool) throws {
        try liveSgc().sendGalleryMode(requestId: requestId, active: enabled)
    }

    func sendButtonPhotoSettings(requestId: String, size: String) throws {
        try sendButtonPhotoSettings(
            requestId: requestId,
            settings: ButtonPhotoSettings(size: ButtonPhotoSize(normalizedRawValue: size))
        )
    }

    func sendButtonPhotoSettings(requestId: String, settings: ButtonPhotoSettings) throws {
        try liveSgc().sendButtonPhotoSettings(requestId: requestId, settings: settings)
    }

    func sendButtonVideoRecordingSettings(requestId: String, width: Int, height: Int, fps: Int) throws {
        try liveSgc().sendButtonVideoRecordingSettings(requestId: requestId, width: width, height: height, fps: fps)
    }

    func sendButtonCameraLedSetting(requestId: String, enabled: Bool) throws {
        try liveSgc().sendButtonCameraLedSetting(requestId: requestId, enabled: enabled)
    }

    func sendButtonMaxRecordingTime(requestId: String, minutes: Int) throws {
        try liveSgc().sendButtonMaxRecordingTime(requestId: requestId, minutes: minutes)
    }

    func sendCameraFovSetting(requestId: String, fov: Int, roiPosition: Int) throws {
        try liveSgc().sendCameraFovSetting(requestId: requestId, fov: fov, roiPosition: roiPosition)
    }

    func retryOtaVersionCheck() {
        Bridge.log("MAN: ⏰ Retrying glasses OTA version check after clock sync")
        (sgc as? MentraLive)?.sendOtaRetryVersionCheck()
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

    func startVideoRecording(
        _ requestId: String, _ save: Bool, _ sound: Bool, _ width: Int = 0, _ height: Int = 0,
        _ fps: Int = 0, _ maxRecordingTimeMinutes: Int = 0
    ) {
        Bridge.log(
            "MAN: onStartVideoRecording: requestId=\(requestId), save=\(save), flash=true, sound=\(sound), resolution=\(width)x\(height)@\(fps)fps, maxRecordingTimeMinutes=\(maxRecordingTimeMinutes)"
        )
        sgc?.startVideoRecording(
            requestId: requestId, save: save, flash: true, sound: sound, width: width, height: height,
            fps: fps, maxRecordingTimeMinutes: maxRecordingTimeMinutes
        )
    }

    func stopVideoRecording(_ requestId: String, _ webhookUrl: String?, _ authToken: String?) {
        Bridge.log(
            "MAN: onStopVideoRecording: requestId=\(requestId), webhook=\((webhookUrl?.isEmpty ?? true) ? "none" : "set")"
        )
        sgc?.stopVideoRecording(requestId: requestId, webhookUrl: webhookUrl, authToken: authToken)
    }

    func setMicState() {
        let willSendPcm = shouldSendPcm || shouldSendLc3
        let willSendTranscript = shouldSendTranscript || offlineCaptionsRunning || localSttFallbackActive
        micEnabled = willSendPcm || willSendTranscript
        updateMicState()
    }

    func rgbLedControl(
        requestId: String,
        packageName: String?,
        action: String,
        color: String?,
        onDurationMs: Int,
        offDurationMs: Int,
        count: Int
    ) {
        sgc?.sendRgbLedControl(
            requestId: requestId,
            packageName: packageName,
            action: action,
            color: color,
            onDurationMs: onDurationMs,
            offDurationMs: offDurationMs,
            count: count
        )
    }

    /// Mentra Live only: K900 `cs_getvol` / `sr_getvol` (step volume 0–15).
    func getGlassesMediaVolume() async throws -> [String: Any] {
        guard let live = sgc as? MentraLive else {
            throw NSError(
                domain: "DeviceManager",
                code: 100,
                userInfo: [NSLocalizedDescriptionKey: "unsupported_device"]
            )
        }
        return try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<[String: Any], Error>) in
            live.getGlassesMediaVolume { result in
                continuation.resume(with: result)
            }
        }
    }

    /// Mentra Live only: K900 `cs_vol` / `sr_vol`.
    func setGlassesMediaVolume(level: Int) async throws -> [String: Any] {
        guard let live = sgc as? MentraLive else {
            throw NSError(
                domain: "DeviceManager",
                code: 100,
                userInfo: [NSLocalizedDescriptionKey: "unsupported_device"]
            )
        }
        return try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<[String: Any], Error>) in
            live.setGlassesMediaVolume(level: level) { result in
                continuation.resume(with: result)
            }
        }
    }

    func requestPhoto(_ request: PhotoRequest) {
        let manualExposureNs = request.exposureTimeNs.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        let manualIso = manualExposureNs != nil ? request.iso.flatMap { $0 > 0 ? $0 : nil } : nil
        let routed = PhotoRequest(
            requestId: request.requestId,
            appId: request.appId,
            size: request.size,
            webhookUrl: request.webhookUrl,
            authToken: request.authToken,
            compress: request.compress,
            flash: request.flash,
            save: request.save,
            sound: request.sound,
            exposureTimeNs: manualExposureNs,
            iso: manualIso,
            aeExposureDivisor: request.aeExposureDivisor,
            isoCap: request.isoCap,
            noiseReduction: request.noiseReduction,
            edgeEnhancement: request.edgeEnhancement,
            mfnr: request.mfnr,
            zsl: request.zsl,
            ispDigitalGain: request.ispDigitalGain,
            ispAnalogGain: request.ispAnalogGain
        )
        Bridge.log(
            "MAN: PHOTO PIPELINE [4/6] DeviceManager.requestPhoto requestId=\(routed.requestId) appId=\(routed.appId) webhookUrl=\(routed.webhookUrl ?? "nil") size=\(routed.size.rawValue) compress=\(routed.compress?.rawValue ?? "none") flash=\(routed.flash) save=\(routed.save) sound=\(routed.sound) exposureTimeNs=\(manualExposureNs.map { String($0) } ?? "nil") iso=\(manualIso.map { String($0) } ?? "auto") aeDivisor=\(routed.aeExposureDivisor.map { String($0) } ?? "nil") isoCap=\(routed.isoCap.map { String($0) } ?? "nil") sgc=\(sgc != nil ? String(describing: type(of: sgc!)) : "null")"
        )
        guard let sgc else {
            Bridge.log(
                "MAN: PHOTO PIPELINE — sgc is null (glasses not connected); dropping requestId=\(routed.requestId)"
            )
            return
        }
        sgc.requestPhoto(routed)
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
        connectDefaultController()
    }

    func connectDefaultController() {
        if defaultController.isEmpty {
            Bridge.log("MAN: No default controller, returning")
            return
        }
        if controllerDeviceName.isEmpty {
            Bridge.log("MAN: No controller device name, returning")
            return
        }
        initController(defaultController)
        searchingController = true
        controller?.connectById(controllerDeviceName)
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

        // if the pending wearable is a controller, don't disconnect, use the controller manager to connect
        if ControllerTypes.ALL.contains(pendingWearable) {
            controller?.disconnect()
            controller?.connectById(name)
            return
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

    func connectDevice(_ deviceModel: String, _ deviceName: String) {
        Bridge.log("MAN: Connecting to device: \(deviceModel) \(deviceName)")
        if DeviceTypes.ALL.contains(deviceModel) {
            pendingWearable = deviceModel
            initSGC(pendingWearable)
            sgc?.connectById(deviceName)
            return
        }
        if ControllerTypes.ALL.contains(deviceModel) {
            pendingWearable = deviceModel
            initController(deviceModel)
            controller?.connectById(deviceName)
            return
        }
        Bridge.log("MAN: No compatible device model, returning")
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
        lastSystemTimeSyncConnectionKey = ""
        searching = false
        micEnabled = false
        updateMicState()
        shouldSendBootingMessage = true // Reset for next first connect
        // clear glasses properties:
        DeviceStore.shared.apply("glasses", "deviceModel", "")
        DeviceStore.shared.apply("glasses", "fullyBooted", false)
        DeviceStore.shared.apply("glasses", "connected", false)
        DeviceStore.shared.apply("glasses", "connectionState", ConnTypes.DISCONNECTED)
        DeviceStore.shared.apply("glasses", "voiceActivityDetectionEnabled", BluetoothSdkDefaults.voiceActivityDetectionEnabled)
        // disconnect the controller as well:
        searchingController = false
        DeviceStore.shared.apply("glasses", "controllerConnected", false)
        controller?.disconnect()
        controller = nil // Clear the controller reference after disconnect
    }

    func disconnectController() {
        searchingController = false
        // disconnect the controller from the glasses if applicable:
        sgc?.disconnectController()
        controller?.disconnect()
        controller = nil // Clear the controller reference after disconnect
    }

    func forget() {
        Bridge.log("MAN: Forgetting smart glasses")
        // Call forget first to stop timers/handlers/reconnect logic
        sgc?.forget()
        disconnect()
        // Clear state
        defaultWearable = ""
        deviceName = ""
        deviceAddress = ""
        Bridge.saveSetting("default_wearable", "")
        Bridge.saveSetting("device_name", "")
        Bridge.saveSetting("device_address", "")
    }

    func forgetController() {
        Bridge.log("MAN: Forgetting controller")
        controller?.forget()
        disconnectController()
        // Clear state
        defaultController = ""
        controllerDeviceName = ""
        Bridge.saveSetting("controller_device_name", "")
        Bridge.saveSetting("default_controller", "")
        DeviceStore.shared.apply("glasses", "controllerConnected", false)
    }

    func findCompatibleDevices(_ deviceModel: String) {
        Bridge.log("MAN: Searching for compatible device names for: \(deviceModel)")

        // reset the search results:
        searchResults = []

        if DeviceTypes.ALL.contains(deviceModel) {
            pendingWearable = deviceModel
        }

        if ControllerTypes.ALL.contains(deviceModel) {
            pendingWearable = deviceModel
        }

        if ControllerTypes.ALL.contains(deviceModel) {
            initController(deviceModel)
            controller?.findCompatibleDevices()
            return
        }

        initSGC(pendingWearable)
        sgc?.findCompatibleDevices()
    }

    func stopScan() {
        controller?.stopScan()
        sgc?.stopScan()
        DeviceStore.shared.apply("bluetooth", "searching", false)
        DeviceStore.shared.apply("bluetooth", "searchingController", false)
    }

    func cleanup() {
        // Clean up transcriber resources
#if !SWIFT_PACKAGE || MENTRA_FEATURE_LOCAL_STT
        transcriber?.shutdown()
        transcriber = nil
#endif

        // Clean up LC3 converter
        lc3Converter = nil

        cancellables.removeAll()
    }
}
