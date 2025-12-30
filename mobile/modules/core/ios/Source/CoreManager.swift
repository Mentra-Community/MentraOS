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

    // MARK: - End Unique

    // MARK: - Properties

    var coreToken: String = ""
    var coreTokenOwner: String = ""
    var sgc: SGCManager?

    // state
    private var shouldSendBootingMessage = true
    private var lastStatusObj: [String: Any] = [:]
    private var defaultWearable: String = ""
    private var pendingWearable: String = ""
    private var deviceName: String = ""
    var deviceAddress: String = ""
    private var screenDisabled: Bool = false
    private var isSearching: Bool = false
    private var systemMicUnavailable: Bool = false
    var micRanking: [String] = MicMap.map["auto"]!

    // glasses settings
    var contextualDashboard = true
    var headUpAngle = 30
    var brightness = 50
    var autoBrightness: Bool = true
    var dashboardHeight: Int = 4
    var dashboardDepth: Int = 5
    var galleryMode: Bool = false

    // glasses state:
    var isHeadUp: Bool = false

    // core settings
    private var sensingEnabled: Bool = true
    var powerSavingMode: Bool = false
    private var alwaysOnStatusBar: Bool = false
    private var bypassVad: Bool = true
    private var enforceLocalTranscription: Bool = false
    private var bypassAudioEncoding: Bool = false
    private var offlineMode: Bool = false
    private var metricSystem: Bool = false

    // mic:
    private var useOnboardMic = false
    private var preferredMic = "auto"
    private var micEnabled = false

    // button settings:
    var buttonPressMode = "photo"
    var buttonPhotoSize = "medium"
    var buttonVideoWidth = 1280
    var buttonVideoHeight = 720
    var buttonVideoFps = 30
    var buttonMaxRecordingTime = 10
    var buttonCameraLed = true

    // VAD:
    private var vad: SileroVADStrategy?
    private var vadBuffer = [Data]()
    private var isSpeaking = false

    // STT:
    private var transcriber: SherpaOnnxTranscriber?
    private var shouldSendPcmData = false
    private var shouldSendTranscript = false

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
    }

    // MARK: - AUX Voice Data Handling

    private func checkSetVadStatus(speaking: Bool) {
        if speaking != isSpeaking {
            isSpeaking = speaking
            Bridge.sendVadStatus(isSpeaking)
        }
    }

    private func emptyVadBuffer() {
        // go through the buffer, popping from the first element in the array (FIFO):
        while !vadBuffer.isEmpty {
            let chunk = vadBuffer.removeFirst()
            Bridge.sendMicData(chunk)
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

    func handleGlassesMicData(_ lc3Data: Data, _ frameSize: Int = 20) {
        // decode the g1 audio data to PCM and feed to the VAD:

        // Ensure we have enough data to process
        guard lc3Data.count > 2 else {
            Bridge.log("Received invalid PCM data size: \(lc3Data.count)")
            return
        }

        // Ensure we have valid PCM data
        guard lc3Data.count > 0 else {
            Bridge.log("No LC3 data after removing command bytes")
            return
        }

        if bypassVad {
            // Bridge.log("MAN: Glasses mic VAD bypassed - bypassVad=\(bypassVad)")
            checkSetVadStatus(speaking: true)
            // first send out whatever's in the vadBuffer (if there is anything):
            emptyVadBuffer()
            let pcmConverter = PcmConverter()
            let pcmData = pcmConverter.decode(lc3Data, frameSize: frameSize) as Data
            //        self.serverComms.sendAudioChunk(lc3Data)
            Bridge.sendMicData(pcmData)
            return
        }

        let pcmConverter = PcmConverter()
        let pcmData = pcmConverter.decode(lc3Data, frameSize: frameSize) as Data

        guard pcmData.count > 0 else {
            Bridge.log("PCM conversion resulted in empty data")
            return
        }

        // feed PCM to the VAD:
        guard let vad = vad else {
            Bridge.log("VAD not initialized")
            return
        }

        // convert audioData to Int16 array:
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
            //        self.serverComms.sendAudioChunk(lc3Data)
            Bridge.sendMicData(pcmData)
        } else {
            checkSetVadStatus(speaking: false)
            // add to the vadBuffer:
            //        addToVadBuffer(lc3Data)
            addToVadBuffer(pcmData)
        }
    }

    func handlePcm(_ pcmData: Data) {
        // handle incoming PCM data from the microphone manager and feed to the VAD:

        // feed PCM to the VAD:
        guard let vad = vad else {
            Bridge.log("VAD not initialized")
            return
        }

        if bypassVad {
            //          let pcmConverter = PcmConverter()
            //          let lc3Data = pcmConverter.encode(pcmData) as Data
            //          checkSetVadStatus(speaking: true)
            //          // first send out whatever's in the vadBuffer (if there is anything):
            //          emptyVadBuffer()
            //          self.serverComms.sendAudioChunk(lc3Data)
            if shouldSendPcmData {
                // Bridge.log("MAN: Sending PCM data to server")
                Bridge.sendMicData(pcmData)
            }

            // Also send to local transcriber when bypassing VAD
            if shouldSendTranscript {
                transcriber?.acceptAudio(pcm16le: pcmData)
            }
            return
        }

        // convert audioData to Int16 array:
        let pcmDataArray = pcmData.withUnsafeBytes { pointer -> [Int16] in
            Array(
                UnsafeBufferPointer(
                    start: pointer.bindMemory(to: Int16.self).baseAddress,
                    count: pointer.count / MemoryLayout<Int16>.stride
                ))
        }

        vad.checkVAD(pcm: pcmDataArray) { [weak self] state in
            guard let self = self else { return }
            //            self.handler?(state)
            Bridge.log("VAD State: \(state)")
        }

        // encode the pcmData as LC3:
        //        let pcmConverter = PcmConverter()
        //        let lc3Data = pcmConverter.encode(pcmData) as Data

        let vadState = vad.currentState()
        if vadState == .speeching {
            checkSetVadStatus(speaking: true)
            // first send out whatever's in the vadBuffer (if there is anything):
            emptyVadBuffer()
            //          self.serverComms.sendAudioChunk(lc3Data)
            if shouldSendPcmData {
                Bridge.sendMicData(pcmData)
            }

            // Send to local transcriber when speech is detected
            if shouldSendTranscript {
                transcriber?.acceptAudio(pcm16le: pcmData)
            }
        } else {
            checkSetVadStatus(speaking: false)
            // add to the vadBuffer:
            //          addToVadBuffer(lc3Data)
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

    // MARK: - State Management

    func updateHeadUp(_ isHeadUp: Bool) {
        self.isHeadUp = isHeadUp
        sendCurrentState()
        Bridge.sendHeadUp(isHeadUp)
    }

    func updateContextualDashboard(_ enabled: Bool) {
        contextualDashboard = enabled
        getStatus() // to update the UI
    }

    func updatePreferredMic(_ mic: String) {
        preferredMic = mic
        micRanking = MicMap.map[preferredMic] ?? MicMap.map["auto"]!
        setMicState(shouldSendPcmData, shouldSendTranscript, bypassVad)
        getStatus() // to update the UI
    }

    func updateButtonMode(_ mode: String) {
        buttonPressMode = mode
        sgc?.sendButtonModeSetting()
        getStatus() // to update the UI
    }

    func updateButtonPhotoSize(_ size: String) {
        buttonPhotoSize = size
        sgc?.sendButtonPhotoSettings()
        getStatus() // to update the UI
    }

    func updateButtonVideoSettings(width: Int, height: Int, fps: Int) {
        buttonVideoWidth = width
        buttonVideoHeight = height
        buttonVideoFps = fps
        sgc?.sendButtonVideoRecordingSettings()
        getStatus() // to update the UI
    }

    func updateButtonCameraLed(_ enabled: Bool) {
        buttonCameraLed = enabled
        sgc?.sendButtonCameraLedSetting()
        getStatus() // to update the UI
    }

    func updateGalleryMode(_ enabled: Bool) {
        galleryMode = enabled
        sgc?.sendGalleryMode()
        getStatus() // to update the UI
    }

    func updateButtonMaxRecordingTime(_ value: Int) {
        buttonMaxRecordingTime = value
        sgc?.sendButtonMaxRecordingTime()
        getStatus() // to update the UI
    }

    func updateGlassesHeadUpAngle(_ value: Int) {
        headUpAngle = value
        sgc?.setHeadUpAngle(value)
        getStatus() // to update the UI
    }

    func updateGlassesBrightness(_ value: Int, autoBrightness: Bool) {
        let autoBrightnessChanged = self.autoBrightness != autoBrightness
        brightness = value
        self.autoBrightness = autoBrightness
        Task {
            sgc?.setBrightness(value, autoMode: autoBrightness)
            if autoBrightnessChanged {
                sgc?.sendTextWall(
                    autoBrightness ? "Enabled auto brightness" : "Disabled auto brightness")
            } else {
                sgc?.sendTextWall("Set brightness to \(value)%")
            }
            try? await Task.sleep(nanoseconds: 800_000_000) // 0.8 seconds
            sgc?.clearDisplay() // clear screen
        }
        getStatus() // to update the UI
    }

    func updateGlassesDepth(_ value: Int) {
        dashboardDepth = value
        Task {
            await sgc?.setDashboardPosition(self.dashboardHeight, self.dashboardDepth)
            Bridge.log("MAN: Set dashboard depth to \(value)")
        }
        getStatus() // to update the UI
    }

    func updateGlassesHeight(_ value: Int) {
        dashboardHeight = value
        Task {
            await sgc?.setDashboardPosition(self.dashboardHeight, self.dashboardDepth)
            Bridge.log("MAN: Set dashboard height to \(value)")
        }
        getStatus() // to update the UI
    }

    func updatePowerSavingMode(_ enabled: Bool) {
        powerSavingMode = enabled
        getStatus() // to update the UI
    }

    func updateAlwaysOnStatusBar(_ enabled: Bool) {
        alwaysOnStatusBar = enabled
        getStatus() // to update the UI
    }

    func updateBypassVad(_ enabled: Bool) {
        bypassVad = enabled
        getStatus() // to update the UI
    }

    func updateEnforceLocalTranscription(_ enabled: Bool) {
        enforceLocalTranscription = enabled
        setMicState(shouldSendPcmData, shouldSendTranscript, bypassVad)
        getStatus() // to update the UI
    }

    func updateOfflineMode(_ enabled: Bool) {
        offlineMode = enabled
        Bridge.log("MAN: updating offline mode: \(enabled)")
        setMicState(shouldSendPcmData, shouldSendTranscript, bypassVad)
    }

    func updateBypassAudioEncoding(_ enabled: Bool) {
        bypassAudioEncoding = enabled
    }

    func updateMetricSystem(_ enabled: Bool) {
        metricSystem = enabled
        getStatus()
    }

    func updateScreenDisabled(_ enabled: Bool) {
        Bridge.log("MAN: Toggling screen disabled: \(enabled)")
        screenDisabled = enabled
        if enabled {
            sgc?.exit()
        } else {
            sgc?.clearDisplay()
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
            if isHeadUp {
                currentViewState = self.viewStates[1]
            } else {
                currentViewState = self.viewStates[0]
            }
            if isHeadUp && !self.contextualDashboard {
                return
            }

            if sgc?.type.contains(DeviceTypes.SIMULATED) ?? true {
                // dont send the event to glasses that aren't there:
                return
            }

            var ready = sgc?.ready ?? false
            if !ready {
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

    func onRouteChange(
        reason: AVAudioSession.RouteChangeReason, availableInputs: [AVAudioSessionPortDescription]
    ) {
        Bridge.log("MAN: onRouteChange: reason: \(reason)")
        Bridge.log("MAN: onRouteChange: inputs: \(availableInputs)")
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

    func handleConnectionStateChanged() {
        Bridge.log("MAN: Glasses: connection state changed!")
        if sgc == nil { return }
        if sgc!.ready {
            handleDeviceReady()
        } else {
            handleDeviceDisconnected()
            getStatus()
        }
    }

    private func handleDeviceReady() {
        guard let sgc else {
            Bridge.log("MAN: SGC is nil, returning")
            return
        }
        Bridge.log("MAN: handleDeviceReady(): \(sgc.type)")

        pendingWearable = ""
        defaultWearable = sgc.type
        isSearching = false
        getStatus()

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

        // send to the server our battery status:
        Bridge.sendBatteryStatus(level: sgc.batteryLevel ?? -1, charging: false)

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

            self.getStatus()
        }
    }

    private func handleMach1Ready() {
        Task {
            // Mach1-specific setup (if any needed in the future)
            self.getStatus()
        }
    }

    private func handleDeviceDisconnected() {
        Bridge.log("MAN: Device disconnected")
        // setMicState(shouldSendPcmData, shouldSendTranscript, false)
        // shouldSendBootingMessage = true  // Reset for next first connect
        getStatus()
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

        Bridge.log(
            "Updating view state \(stateIndex) with \(layoutType) \(text) \(topText) \(bottomText)")

        viewStates[stateIndex] = newViewState

        let headUp = isHeadUp
        // send the state we just received if the user is currently in that state:
        if stateIndex == 0, !headUp {
            sendCurrentState()
        } else if stateIndex == 1, headUp {
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
        sgc?.requestWifiScan()
    }

    func sendWifiCredentials(_ ssid: String, _ password: String) {
        Bridge.log("MAN: Sending wifi credentials: \(ssid) \(password)")
        sgc?.sendWifiCredentials(ssid, password)
    }

    func setHotspotState(_ enabled: Bool) {
        Bridge.log("MAN: 🔥 Setting glasses hotspot state: \(enabled)")
        sgc?.sendHotspotState(enabled)
    }

    func queryGalleryStatus() {
        Bridge.log("MAN: 📸 Querying gallery status from glasses")
        sgc?.queryGalleryStatus()
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

    func startVideoRecording(_ requestId: String, _ save: Bool) {
        Bridge.log("MAN: onStartVideoRecording: requestId=\(requestId), save=\(save)")
        sgc?.startVideoRecording(requestId: requestId, save: save)
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

        if offlineMode && (!shouldSendPcmData && !shouldSendTranscript) {
            shouldSendTranscript = true
        }

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
        _ compress: String?
    ) {
        Bridge.log(
            "MAN: onPhotoRequest: \(requestId), \(appId), \(webhookUrl), size=\(size), compress=\(compress ?? "none")"
        )
        sgc?.requestPhoto(
            requestId, appId: appId, size: size, webhookUrl: webhookUrl, authToken: authToken,
            compress: compress
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
        isSearching = true
        getStatus()
        sgc?.connectById(deviceName)
    }

    func connectByName(_ dName: String) {
        Bridge.log("MAN: Connecting to wearable: \(dName)")

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
            self.isSearching = true
            self.deviceName = dName

            initSGC(self.pendingWearable)
            sgc?.connectById(self.deviceName)
            getStatus()
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
        isSearching = false
        shouldSendPcmData = false
        shouldSendTranscript = false
        setMicState(shouldSendPcmData, shouldSendTranscript, bypassVad)
        shouldSendBootingMessage = true // Reset for next first connect
        getStatus()
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
        getStatus()
    }

    func findCompatibleDevices(_ modelName: String) {
        Bridge.log("MAN: Searching for compatible device names for: \(modelName)")

        if DeviceTypes.ALL.contains(modelName) {
            pendingWearable = modelName
        }

        initSGC(pendingWearable)
        sgc?.findCompatibleDevices()
        getStatus()
    }

    func getStatus() {
        // ensure this is on the main thread:
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            // construct the status object:
            let simulatedConnected = defaultWearable == DeviceTypes.SIMULATED
            let glassesConnected = sgc?.ready ?? false
            if glassesConnected {
                isSearching = false
            }

            // also referenced as glasses_info:
            var glassesSettings: [String: Any] = [:]
            var glassesInfo: [String: Any] = [:]

            glassesInfo = [
                "modelName": defaultWearable,
                "batteryLevel": sgc?.batteryLevel ?? -1,
                "appVersion": sgc?.glassesAppVersion ?? "",
                "buildNumber": sgc?.glassesBuildNumber ?? "",
                "deviceModel": sgc?.glassesDeviceModel ?? "",
                "androidVersion": sgc?.glassesAndroidVersion ?? "",
                "otaVersionUrl": sgc?.glassesOtaVersionUrl ?? "",
                "fwVersion": sgc?.glassesFirmwareVersion ?? "",
                "btMacAddress": sgc?.glassesBtMacAddress ?? "",
                // state:
                "connected": glassesConnected,
                "micEnabled": sgc?.micEnabled ?? false,
                "connectionState": sgc?.connectionState ?? "disconnected",
            ]

            if sgc is G1 {
                glassesInfo["caseRemoved"] = sgc?.caseRemoved ?? true
                glassesInfo["caseOpen"] = sgc?.caseOpen ?? true
                glassesInfo["caseCharging"] = sgc?.caseCharging ?? false
                glassesInfo["caseBatteryLevel"] = sgc?.caseBatteryLevel ?? -1

                glassesInfo["serialNumber"] = sgc?.glassesSerialNumber ?? ""
                glassesInfo["style"] = sgc?.glassesStyle ?? ""
                glassesInfo["color"] = sgc?.glassesColor ?? ""
            }

            if sgc is MentraLive {
                glassesInfo["wifiSsid"] = sgc?.wifiSsid ?? ""
                glassesInfo["wifiConnected"] = sgc?.wifiConnected ?? false
                glassesInfo["wifiLocalIp"] = sgc?.wifiLocalIp ?? ""
                glassesInfo["hotspotEnabled"] = sgc?.isHotspotEnabled ?? false
                glassesInfo["hotspotSsid"] = sgc?.hotspotSsid ?? ""
                glassesInfo["hotspotPassword"] = sgc?.hotspotPassword ?? ""
                glassesInfo["hotspotGatewayIp"] = sgc?.hotspotGatewayIp ?? ""
            }

            // Add Bluetooth device name if available
            if let bluetoothName = sgc?.getConnectedBluetoothName() {
                glassesInfo["bluetoothName"] = bluetoothName
            }

            glassesSettings = [
                "brightness": brightness,
                "auto_brightness": autoBrightness,
                "dashboard_height": dashboardHeight,
                "dashboard_depth": dashboardDepth,
                "head_up_angle": headUpAngle,
                "button_mode": buttonPressMode,
                "button_photo_size": buttonPhotoSize,
                "button_video_settings": [
                    "width": buttonVideoWidth,
                    "height": buttonVideoHeight,
                    "fps": buttonVideoFps,
                ],
                "button_max_recording_time": buttonMaxRecordingTime,
                "button_camera_led": buttonCameraLed,
            ]

            //        let cloudConnectionStatus =
            //            WebSocketManager.shared.isConnected() ? "CONNECTED" : "DISCONNECTED"

            // TODO: config: remove
            let coreInfo: [String: Any] = [
                // "is_searching": self.isSearching && !self.defaultWearable.isEmpty,
                "is_searching": isSearching,
                // only on if recording from glasses:
                "core_token": coreToken,
            ]

            // hardcoded list of apps:
            var apps: [[String: Any]] = []

            let authObj: [String: Any] = [
                "core_token_owner": coreTokenOwner,
                //      "core_token_status":
            ]

            let statusObj: [String: Any] = [
                "glasses_info": glassesInfo,
                "glasses_settings": glassesSettings,
                "apps": apps,
                "core_info": coreInfo,
                "auth": authObj,
            ]

            lastStatusObj = statusObj

            Bridge.sendStatus(statusObj)
        }
    }

    func updateSettings(_ settings: [String: Any]) {
        Bridge.log("MAN: Received update settings: \(settings)")

        // update our settings with the new values:
        if let newPreferredMic = settings["preferred_mic"] as? String,
           newPreferredMic != preferredMic
        {
            updatePreferredMic(newPreferredMic)
        }

        if let newHeadUpAngle = settings["head_up_angle"] as? Int, newHeadUpAngle != headUpAngle {
            updateGlassesHeadUpAngle(newHeadUpAngle)
        }

        if let newBrightness = settings["brightness"] as? Int, newBrightness != brightness {
            updateGlassesBrightness(newBrightness, autoBrightness: false)
        }

        if let newDashboardHeight = settings["dashboard_height"] as? Int,
           newDashboardHeight != dashboardHeight
        {
            updateGlassesHeight(newDashboardHeight)
        }

        if let newDashboardDepth = settings["dashboard_depth"] as? Int,
           newDashboardDepth != dashboardDepth
        {
            updateGlassesDepth(newDashboardDepth)
        }

        if let newScreenDisabled = settings["screen_disabled"] as? Bool,
           newScreenDisabled != screenDisabled
        {
            updateScreenDisabled(newScreenDisabled)
        }

        if let newAutoBrightness = settings["auto_brightness"] as? Bool,
           newAutoBrightness != autoBrightness
        {
            updateGlassesBrightness(brightness, autoBrightness: newAutoBrightness)
        }

        if let powerSavingMode = settings["power_saving_mode"] as? Bool,
           powerSavingMode != self.powerSavingMode
        {
            updatePowerSavingMode(powerSavingMode)
        }

        if let newAlwaysOnStatusBar = settings["always_on_status_bar"] as? Bool,
           newAlwaysOnStatusBar != alwaysOnStatusBar
        {
            updateAlwaysOnStatusBar(newAlwaysOnStatusBar)
        }

        if let newBypassVad = settings["bypass_vad_for_debugging"] as? Bool,
           newBypassVad != bypassVad
        {
            updateBypassVad(newBypassVad)
        }

        if let newEnforceLocalTranscription = settings["enforce_local_transcription"] as? Bool,
           newEnforceLocalTranscription != enforceLocalTranscription
        {
            updateEnforceLocalTranscription(newEnforceLocalTranscription)
        }

        if let newOfflineMode = settings["offline_captions_running"] as? Bool,
           newOfflineMode != offlineMode
        {
            updateOfflineMode(newOfflineMode)
        }

        if let newMetricSystem = settings["metric_system"] as? Bool,
           newMetricSystem != metricSystem
        {
            updateMetricSystem(newMetricSystem)
        }

        if let newContextualDashboard = settings["contextual_dashboard"] as? Bool,
           newContextualDashboard != contextualDashboard
        {
            updateContextualDashboard(newContextualDashboard)
        }

        if let newButtonMode = settings["button_mode"] as? String, newButtonMode != buttonPressMode {
            updateButtonMode(newButtonMode)
        }

        // Button video settings - handle both nested object and flat keys
        // First check for nested object structure (from AsyncStorage)
        if let videoSettingsObj = settings["button_video_settings"] as? [String: Any] {
            let newWidth = videoSettingsObj["width"] as? Int ?? buttonVideoWidth
            let newHeight = videoSettingsObj["height"] as? Int ?? buttonVideoHeight
            let newFps = videoSettingsObj["fps"] as? Int ?? buttonVideoFps

            if newWidth != buttonVideoWidth || newHeight != buttonVideoHeight
                || newFps != buttonVideoFps
            {
                Bridge.log(
                    "MAN: Updating button video settings: \(newWidth) x \(newHeight) @ \(newFps)fps (was: \(buttonVideoWidth) x \(buttonVideoHeight) @ \(buttonVideoFps)fps)"
                )
                updateButtonVideoSettings(width: newWidth, height: newHeight, fps: newFps)
            }
        } else {
            // Fallback to flat key structure (backwards compatibility)
            var newWidth = buttonVideoWidth
            var newHeight = buttonVideoHeight
            var newFps = buttonVideoFps
            var changed = false

            if let width = settings["button_video_width"] as? Int, width != buttonVideoWidth {
                newWidth = width
                changed = true
            }

            if let height = settings["button_video_height"] as? Int, height != buttonVideoHeight {
                newHeight = height
                changed = true
            }

            if let fps = settings["button_video_fps"] as? Int, fps != buttonVideoFps {
                newFps = fps
                changed = true
            }

            if changed {
                Bridge.log(
                    "MAN: Updating button video settings: \(newWidth) x \(newHeight) @ \(newFps)fps (was: \(buttonVideoWidth) x \(buttonVideoHeight) @ \(buttonVideoFps)fps)"
                )
                updateButtonVideoSettings(width: newWidth, height: newHeight, fps: newFps)
            }
        }

        if let newPhotoSize = settings["button_photo_size"] as? String,
           newPhotoSize != buttonPhotoSize
        {
            updateButtonPhotoSize(newPhotoSize)
        }

        if let newButtonMaxRecordingTime = settings["button_max_recording_time"] as? Int,
           newButtonMaxRecordingTime != buttonMaxRecordingTime
        {
            updateButtonMaxRecordingTime(newButtonMaxRecordingTime)
        }

        if let newButtonCameraLed = settings["button_camera_led"] as? Bool,
           newButtonCameraLed != buttonCameraLed
        {
            updateButtonCameraLed(newButtonCameraLed)
        }

        if let newGalleryMode = settings["gallery_mode"] as? Bool, newGalleryMode != galleryMode {
            updateGalleryMode(newGalleryMode)
        }

        // get default wearable from core_info:
        if let newDefaultWearable = settings["default_wearable"] as? String,
           newDefaultWearable != defaultWearable
        {
            defaultWearable = newDefaultWearable
            Bridge.saveSetting("default_wearable", newDefaultWearable)
        }

        if let newDeviceName = settings["device_name"] as? String,
           newDeviceName != deviceName
        {
            deviceName = newDeviceName
        }

        if let newDeviceAddress = settings["device_address"] as? String,
           newDeviceAddress != deviceAddress
        {
            deviceAddress = newDeviceAddress
        }
    }

    // MARK: - Cleanup

    func cleanup() {
        // Clean up transcriber resources
        transcriber?.shutdown()
        transcriber = nil

        cancellables.removeAll()
    }
}
