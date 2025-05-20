//
//  AOSManager.swift
//  AugmentOS_Manager
//
//  Created by Matthew Fosse on 3/5/25.
//

import Foundation
import Combine
import CoreBluetooth
import UIKit
import React
import AVFoundation

struct ViewState {
  var topText: String
  var bottomText: String
  var layoutType: String
  var text: String
  var eventStr: String
}

// This class handles logic for managing devices and connections to AugmentOS servers
@objc(AOSManager) class AOSManager: NSObject, ServerCommsCallback, MicCallback {
  
  private var coreToken: String = ""
  private var coreTokenOwner: String = ""
  
  @objc var g1Manager: ERG1Manager?
  var micManager: OnboardMicrophoneManager!
  var serverComms: ServerComms!
  
  private var cancellables = Set<AnyCancellable>()
  private var cachedThirdPartyAppList: [ThirdPartyCloudApp] = []
  //  private var cachedWhatToStream = [String]()
  private var defaultWearable: String = ""
  private var deviceName: String = ""
  private var somethingConnected: Bool = false;
  private var shouldEnableMic: Bool = false;
  private var contextualDashboard = true;
  private var headUpAngle = 30;
  private var brightness = 50;
  private var batteryLevel = -1;
  private var autoBrightness: Bool = true;
  private var dashboardHeight: Int = 4;
  private var dashboardDepth: Int = 5;
  private var sensingEnabled: Bool = true;
  private var isSearching: Bool = true;
  private var alwaysOnStatusBar: Bool = false;
  private var bypassVad: Bool = false;
  private var bypassAudioEncoding: Bool = false;
  private var onboardMicUnavailable: Bool = false;
  private var metricSystemEnabled: Bool = false;
  private var settingsLoaded = false
  private let settingsLoadedSemaphore = DispatchSemaphore(value: 0)
  private var connectTask: Task<Void, Never>?
  
  var viewStates: [ViewState] = [
    ViewState(topText: " ", bottomText: " ", layoutType: "text_wall", text: "", eventStr: ""),
    ViewState(topText: " ", bottomText: " ", layoutType: "text_wall", text: "$TIME12$ $DATE$ $GBATT$ $CONNECTION_STATUS", eventStr: ""),
  ]
  
  
  // mic:
  private var useOnboardMic = false;
  private var preferredMic = "glasses";
  private var micEnabled = false;
  
  // VAD:
  private var vad: SileroVADStrategy?
  private var vadBuffer = [Data]();
  private var isSpeaking = false;
  
  override init() {
    self.vad = SileroVADStrategy()
    self.serverComms = ServerComms.getInstance()
    super.init()
    Task {
        await loadSettings()
        self.vad?.setup(sampleRate: .rate_16k,
                       frameSize: .size_1024,
                       quality: .normal,
                       silenceTriggerDurationMs: 4000,
                       speechTriggerDurationMs: 50)
    }
  }
  
  // MARK: - Public Methods (for React Native)
  
  @objc public func setup() {
    
    self.g1Manager = ERG1Manager()
    self.micManager = OnboardMicrophoneManager()
    self.serverComms.locationManager.setup()
    self.serverComms.mediaManager.setup()
    
    guard g1Manager != nil else {
      return
    }
    
    // Set up the ServerComms callback
    self.serverComms.setServerCommsCallback(self)
    self.micManager.setMicCallback(self)
    
    // Set up voice data handling
    setupVoiceDataHandling()
    
    // configure on board mic:
    //    setupOnboardMicrophoneIfNeeded()
    
    // calback to handle actions when the connectionState changes (when g1 is ready)
    g1Manager!.onConnectionStateChanged = { [weak self] in
      guard let self = self else { return }
      print("G1 glasses connection changed to: \(self.g1Manager!.g1Ready ? "Connected" : "Disconnected")")
      //      self.handleRequestStatus()
      if (self.g1Manager!.g1Ready) {
        handleDeviceReady()
      } else {
        handleDeviceDisconnected()
        handleRequestStatus()
      }
    }
    
    // listen to changes in battery level:
    g1Manager!.$batteryLevel.sink { [weak self] (level: Int) in
      guard let self = self else { return }
      guard level >= 0 else { return }
      self.batteryLevel = level
      self.serverComms.sendBatteryStatus(level: self.batteryLevel, charging: false);
    }.store(in: &cancellables)
    
    // listen to headUp events:
    g1Manager!.$isHeadUp.sink { [weak self] (value: Bool) in
        guard let self = self else { return }
        self.sendCurrentState(value)
    }.store(in: &cancellables)
    
    
    // Subscribe to WebSocket status changes
    serverComms.wsManager.status
      .sink { [weak self] status in
        guard let self = self else { return }
        handleRequestStatus()
      }
      .store(in: &cancellables)
  }
  
  @objc func connectServer() {
    serverComms.connectWebSocket()
  }
  
  @objc func setCoreToken(_ coreToken: String) {
    serverComms.setAuthCredentials("", coreToken)
  }
  
  @objc func startApp(_ packageName: String) {
    serverComms.startApp(packageName: packageName)
  }
  
  @objc func stopApp(_ packageName: String) {
    serverComms.stopApp(packageName: packageName)
  }
  
  func onConnectionAck() {
    handleRequestStatus()
  }
  
  func onAppStateChange(_ apps: [ThirdPartyCloudApp]/*, _ whatToStream: [String]*/) {
    self.cachedThirdPartyAppList = apps
    handleRequestStatus()
  }
  
  func onConnectionError(_ error: String) {
    handleRequestStatus()
  }
  
  func onAuthError() {}
  
  // MARK: - Voice Data Handling
  
  private func checkSetVadStatus(speaking: Bool) {
    if (speaking != self.isSpeaking) {
      self.isSpeaking = speaking
      serverComms.sendVadStatus(self.isSpeaking)
    }
  }
  
  private func emptyVadBuffer() {
    // go through the buffer, popping from the first element in the array (FIFO):
    while !vadBuffer.isEmpty {
      let chunk = vadBuffer.removeFirst()
      serverComms.sendAudioChunk(chunk)
    }
  }
  
  private func addToVadBuffer(_ chunk: Data) {
    let MAX_BUFFER_SIZE = 20;
    vadBuffer.append(chunk)
    while(vadBuffer.count > MAX_BUFFER_SIZE) {
      // pop from the front of the array:
      vadBuffer.removeFirst()
    }
  }
  
  private func setupVoiceDataHandling() {
    
    // handle incoming PCM data from the microphone manager and feed to the VAD:
    micManager.voiceData
      .sink { [weak self] pcmData in
        guard let self = self else { return }
        
        
        // feed PCM to the VAD:
        guard let vad = self.vad else {
          print("VAD not initialized")
          return
        }
        
        
        if self.bypassVad {
//          let pcmConverter = PcmConverter()
//          let lc3Data = pcmConverter.encode(pcmData) as Data
//          checkSetVadStatus(speaking: true)
//          // first send out whatever's in the vadBuffer (if there is anything):
//          emptyVadBuffer()
//          self.serverComms.sendAudioChunk(lc3Data)
          self.serverComms.sendAudioChunk(pcmData)
          return
        }
        
        // convert audioData to Int16 array:
        let pcmDataArray = pcmData.withUnsafeBytes { pointer -> [Int16] in
          Array(UnsafeBufferPointer(
            start: pointer.bindMemory(to: Int16.self).baseAddress,
            count: pointer.count / MemoryLayout<Int16>.stride
          ))
        }
      
        vad.checkVAD(pcm: pcmDataArray) { [weak self] state in
          guard let self = self else { return }
          //            self.handler?(state)
          print("VAD State: \(state)")
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
          self.serverComms.sendAudioChunk(pcmData)
        } else {
          checkSetVadStatus(speaking: false)
          // add to the vadBuffer:
//          addToVadBuffer(lc3Data)
          addToVadBuffer(pcmData)
        }
        
      }
      .store(in: &cancellables)
    
    // decode the g1 audio data to PCM and feed to the VAD:
    self.g1Manager!.$compressedVoiceData.sink { [weak self] rawLC3Data in
      guard let self = self else { return }
      
      // Ensure we have enough data to process
      guard rawLC3Data.count > 2 else {
        print("Received invalid PCM data size: \(rawLC3Data.count)")
        return
      }
      
      // Skip the first 2 bytes which are command bytes
      let lc3Data = rawLC3Data.subdata(in: 2..<rawLC3Data.count)
      
      // Ensure we have valid PCM data
      guard lc3Data.count > 0 else {
        print("No PCM data after removing command bytes")
        return
      }
      
      
      if self.bypassVad {
        checkSetVadStatus(speaking: true)
        // first send out whatever's in the vadBuffer (if there is anything):
        emptyVadBuffer()
        let pcmConverter = PcmConverter()
        let pcmData = pcmConverter.decode(lc3Data) as Data
//        self.serverComms.sendAudioChunk(lc3Data)
        self.serverComms.sendAudioChunk(pcmData)
        return
      }
        
      let pcmConverter = PcmConverter()
      let pcmData = pcmConverter.decode(lc3Data) as Data
      
      guard pcmData.count > 0 else {
        print("PCM conversion resulted in empty data")
        return
      }
      
      // feed PCM to the VAD:
      guard let vad = self.vad else {
        print("VAD not initialized")
        return
      }
      
      // convert audioData to Int16 array:
      let pcmDataArray = pcmData.withUnsafeBytes { pointer -> [Int16] in
        Array(UnsafeBufferPointer(
          start: pointer.bindMemory(to: Int16.self).baseAddress,
          count: pointer.count / MemoryLayout<Int16>.stride
        ))
      }
      
      vad.checkVAD(pcm: pcmDataArray) { [weak self] state in
        guard let self = self else { return }
        print("VAD State: \(state)")
      }
      
      let vadState = vad.currentState()
      if vadState == .speeching {
        checkSetVadStatus(speaking: true)
        // first send out whatever's in the vadBuffer (if there is anything):
        emptyVadBuffer()
//        self.serverComms.sendAudioChunk(lc3Data)
        self.serverComms.sendAudioChunk(pcmData)
      } else {
        checkSetVadStatus(speaking: false)
        // add to the vadBuffer:
//        addToVadBuffer(lc3Data)
        addToVadBuffer(pcmData)
      }
    }
    .store(in: &cancellables)
  }
  
  // MARK: - ServerCommsCallback Implementation
  
  func onMicrophoneStateChange(_ isEnabled: Bool) {
    
    print("@@@@@@@ changing microphone state to: \(isEnabled) @@@@@@@@@@@@@@@@")
    // in any case, clear the vadBuffer:
    self.vadBuffer.removeAll()
    self.micEnabled = isEnabled
    
    // Handle microphone state change if needed
    Task {
      // Only enable microphone if sensing is also enabled
      var actuallyEnabled = isEnabled && self.sensingEnabled
      if (!self.somethingConnected) {
        actuallyEnabled = false
      }

      let glassesHasMic = getGlassesHasMic()
      
      var useGlassesMic = false
      var useOnboardMic = false

      useOnboardMic = self.preferredMic == "phone"
      useGlassesMic = self.preferredMic == "glasses"
      
      if (self.onboardMicUnavailable) {
        useOnboardMic = false
      }
      
      if (!glassesHasMic) {
        useGlassesMic = false
      }

      if (!useGlassesMic && !useOnboardMic) {
        // if we have a non-preferred mic, use it:
        if (glassesHasMic) {
          useGlassesMic = true
        } else if (!self.onboardMicUnavailable) {
          useOnboardMic = true
        }

        if (!useGlassesMic && !useOnboardMic) {
          print("no mic to use!!!!!!")
        }
      }
      
      useGlassesMic = actuallyEnabled && useGlassesMic
      useOnboardMic = actuallyEnabled && useOnboardMic

      print("user enabled microphone: \(isEnabled) sensingEnabled: \(self.sensingEnabled) useOnboardMic: \(useOnboardMic) useGlassesMic: \(useGlassesMic) glassesHasMic: \(glassesHasMic) preferredMic: \(self.preferredMic) somethingConnected: \(self.somethingConnected) onboardMicUnavailable: \(self.onboardMicUnavailable)")

      if (self.somethingConnected) {
        await self.g1Manager?.setMicEnabled(enabled: useGlassesMic)
      }
      
      setOnboardMicEnabled(useOnboardMic)
    }
  }
  
  // TODO: ios this name is a bit misleading:
  func setOnboardMicEnabled(_ isEnabled: Bool) {
    Task {
      if isEnabled {
        // Just check permissions - we no longer request them directly from Swift
        // Permissions should already be granted via React Native UI flow
        if !(micManager?.checkPermissions() ?? false) {
          print("Microphone permissions not granted. Cannot enable microphone.")
          return
        }
        
        micManager?.startRecording()
      } else {
        micManager?.stopRecording()
      }
    }
  }
  
  //  func onDashboardDisplayEvent(_ event: [String: Any]) {
  //    print("got dashboard display event")
  ////    onDisplayEvent?(["event": event, "type": "dashboard"])
  //    print(event)
  ////    Task {
  ////      await self.g1Manager.sendText(text: "\(event)")
  ////    }
  //  }
  
  // send whatever was there before sending something else:
  public func clearState() -> Void {
    sendCurrentState(self.g1Manager?.isHeadUp ?? false)
  }
  
  public func sendCurrentState(_ isDashboard: Bool) -> Void {
    Task {
      var currentViewState: ViewState!;
      if (isDashboard) {
        currentViewState = self.viewStates[1]
      } else {
        currentViewState = self.viewStates[0]
      }
      
      if (isDashboard && !self.contextualDashboard) {
        return
      }
      
      let eventStr = currentViewState.eventStr
      if eventStr != "" {
        CoreCommsService.emitter.sendEvent(withName: "CoreMessageEvent", body: eventStr)
      }
      
      if self.defaultWearable.contains("Simulated") || self.defaultWearable.isEmpty {
        // dont send the event to glasses that aren't there:
        return
      }
      
      if (!self.somethingConnected) {
        return
      }
      
      let layoutType = currentViewState.layoutType
      switch layoutType {
      case "text_wall":
        let text = currentViewState.text
        //        let chunks = textHelper.createTextWallChunks(text)
        //        for chunk in chunks {
        //          print("Sending chunk: \(chunk)")
        //          await sendCommand(chunk)
        //        }
        sendText(text);
        break
      case "double_text_wall":
        let topText = currentViewState.topText
        let bottomText = currentViewState.bottomText
        self.g1Manager?.RN_sendDoubleTextWall(topText, bottomText);
        break
      case "reference_card":
        sendText(currentViewState.topText + "\n\n" + currentViewState.bottomText);
        break
      default:
        print("UNHANDLED LAYOUT_TYPE \(layoutType)")
        break
      }
      
    }
  }
  
  public func parsePlaceholders(_ text: String) -> String {
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
    
      if batteryLevel == -1 {
        placeholders["$GBATT$"] = ""
      } else {
        placeholders["$GBATT$"] = "\(batteryLevel)%"
      }
    
      placeholders["$CONNECTION_STATUS$"] = serverComms.isWebSocketConnected() ? "Connected" : "Disconnected"
      
      var result = text
      for (key, value) in placeholders {
          result = result.replacingOccurrences(of: key, with: value)
      }
      
      return result
  }
  
  public func handleDisplayEvent(_ event: [String: Any]) -> Void {
    
    guard let view = event["view"] as? String else {
      print("invalid view")
      return
    }
    let isDashboard = view == "dashboard"
    
    var stateIndex = 0;
    if (isDashboard) {
      stateIndex = 1
    } else {
      stateIndex = 0
    }
    
    // save the state string to forward to the mirror:
    // forward to the glasses mirror:
    let wrapperObj: [String: Any] = ["glasses_display_event": event]
    var eventStr = ""
    do {
      let jsonData = try JSONSerialization.data(withJSONObject: wrapperObj, options: [])
      eventStr = String(data: jsonData, encoding: .utf8) ?? ""
    } catch {
      print("Error converting to JSON: \(error)")
    }
    
    self.viewStates[stateIndex].eventStr = eventStr
    let layout = event["layout"] as! [String: Any];
    let layoutType = layout["layoutType"] as! String
    self.viewStates[stateIndex].layoutType = layoutType
    
    
    var text = layout["text"] as? String ?? " "
    var topText = layout["topText"] as? String ?? " "
    var bottomText = layout["bottomText"] as? String ?? " "
    var title = layout["title"] as? String ?? " "
    
    text = parsePlaceholders(text)
    topText = parsePlaceholders(topText)
    bottomText = parsePlaceholders(bottomText)
    title = parsePlaceholders(title)
    
    // print("Updating view state \(stateIndex) with \(layoutType) \(text) \(topText) \(bottomText)")
    
    switch layoutType {
    case "text_wall":
      self.viewStates[stateIndex].text = text
      break
    case "double_text_wall":
      self.viewStates[stateIndex].topText = topText
      self.viewStates[stateIndex].bottomText = bottomText
      break
    case "reference_card":
      self.viewStates[stateIndex].topText = text
      self.viewStates[stateIndex].bottomText = title
    default:
      print("UNHANDLED LAYOUT_TYPE \(layoutType)")
      break
    }
    
    let headUp = self.g1Manager?.isHeadUp ?? false
    // send the state we just received if the user is currently in that state:
    if (stateIndex == 0 && !headUp) {
      sendCurrentState(false)
    } else if (stateIndex == 1 && headUp) {
      sendCurrentState(true)
    }
  }
  
  func onDisplayEvent(_ event: [String: Any]) {
    handleDisplayEvent(event)
  }
  
  func onRequestSingle(_ dataType: String) {
    // Handle single data request
    if dataType == "battery" {
      // Send battery status if needed
    }
    // TODO:
    handleRequestStatus()
  }

  func onRouteChange(reason: AVAudioSession.RouteChangeReason, availableInputs: [AVAudioSessionPortDescription]) {
    print("onRouteChange: \(reason)")
    
    // print the available inputs and see if any are an onboard mic:
    // for input in availableInputs {
    //   print("input: \(input.portType)")
    // }

    // if availableInputs.isEmpty {
    //   self.onboardMicUnavailable = true
    //   self.setOnboardMicEnabled(false)
    //   onMicrophoneStateChange(self.micEnabled)
    //   return
    // } else {
    //   self.onboardMicUnavailable = false
    // }

    switch reason {
    case .newDeviceAvailable:
      self.micManager?.stopRecording()
      self.micManager?.startRecording()
    case .oldDeviceUnavailable:
      self.micManager?.stopRecording()
      self.micManager?.startRecording()
    default:
      break
    }
  }
  
  func onInterruption(began: Bool) {
    print("Interruption: \(began)")
    if began {
      self.onboardMicUnavailable = true
      onMicrophoneStateChange(self.micEnabled)
    } else {
      self.onboardMicUnavailable = false
      onMicrophoneStateChange(self.micEnabled)
    }
  }
  
  func handleSearchForCompatibleDeviceNames(_ modelName: String) {
    print("Searching for compatible device names for: \(modelName)")
    if (modelName.contains("Simulated")) {
      self.defaultWearable = "Simulated Glasses"
      self.preferredMic = "phone"
      saveSettings()
      handleRequestStatus()
    } else if (modelName.contains("Audio")) {
      self.defaultWearable = "Audio Wearable"
      self.preferredMic = "phone"
      saveSettings()
      handleRequestStatus()
    } else if (modelName.contains("G1")) {
      self.defaultWearable = "Even Realities G1"
      self.g1Manager?.RN_startScan()
    }
  }

  private func handleSetServerUrl(url: String) {
    print("Setting server URL to: \(url)")
   self.serverComms.setServerUrl(url)
  }
  
  private func sendText(_ text: String) {
    print("Sending text: \(text)")
    if self.defaultWearable.contains("Simulated") || self.defaultWearable.isEmpty {
      return
    }
    self.g1Manager?.RN_sendText(text)
  }
  
  private func disconnect() {

    self.somethingConnected = false

    // save the mic state:
    // let micWasEnabled = self.micEnabled
    // onMicrophoneStateChange(false)
    // restore the mic state (so that we know to turn it on when we connect again)
    // self.micEnabled = micWasEnabled
    
    self.g1Manager?.disconnect()
    
//    if self.defaultWearable.contains("Simulated") || self.defaultWearable.isEmpty {
//      return
//    }
    
  }
  
  @objc func handleCommand(_ command: String) {
    print("Received command: \(command)")
    
    if !settingsLoaded {
        // Wait for settings to load with a timeout
        let timeout = DispatchTime.now() + .seconds(5) // 5 second timeout
        let result = settingsLoadedSemaphore.wait(timeout: timeout)
        
        if result == .timedOut {
            print("Warning: Settings load timed out, proceeding with default values")
        }
    }
    
    // Define command types enum
    enum CommandType: String {
      case setAuthSecretKey = "set_auth_secret_key"
      case requestStatus = "request_status"
      case connectWearable = "connect_wearable"
      case disconnectWearable = "disconnect_wearable"
      case searchForCompatibleDeviceNames = "search_for_compatible_device_names"
      case enableContextualDashboard = "enable_contextual_dashboard"
      case forceCoreOnboardMic = "force_core_onboard_mic"
      case setPreferredMic = "set_preferred_mic"
      case ping = "ping"
      case forgetSmartGlasses = "forget_smart_glasses"
      case startApp = "start_app"
      case stopApp = "stop_app"
      case updateGlassesHeadUpAngle = "update_glasses_head_up_angle"
      case updateGlassesBrightness = "update_glasses_brightness"
      case updateGlassesDashboardHeight = "update_glasses_dashboard_height"
      case updateGlassesDepth = "update_glasses_depth"
      case enableSensing = "enable_sensing"
      case enableAlwaysOnStatusBar = "enable_always_on_status_bar"
      case bypassVad = "bypass_vad_for_debugging"
      case bypassAudioEncoding = "bypass_audio_encoding_for_debugging"
      case setServerUrl = "set_server_url"
      case setMetricSystemEnabled = "set_metric_system_enabled"
      case showDashboard = "show_dashboard"
      case unknown
    }
    
    // Try to parse JSON
    guard let data = command.data(using: .utf8) else {
      print("Could not convert command string to data")
      return
    }
    
    do {
      if let jsonDict = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] {
        // Extract command type
        guard let commandString = jsonDict["command"] as? String else {
          print("Invalid command format: missing 'command' field")
          return
        }
        
        let commandType = CommandType(rawValue: commandString) ?? .unknown
        let params = jsonDict["params"] as? [String: Any]
        
        // Process based on command type
        switch commandType {
        case .setServerUrl:
          guard let params = params, let url = params["url"] as? String else {
            print("set_server_url invalid params")
            break
          }
          handleSetServerUrl(url: url)
          break
        case .setAuthSecretKey:
          if let params = params,
             let userId = params["userId"] as? String,
             let authSecretKey = params["authSecretKey"] as? String {
            handleSetAuthSecretKey(userId: userId, authSecretKey: authSecretKey)
          } else {
            print("set_auth_secret_key invalid params")
          }
          handleRequestStatus()
          
        case .requestStatus:
          handleRequestStatus()
          
        case .connectWearable:
          guard let params = params, let modelName = params["model_name"] as? String, let deviceName = params["device_name"] as? String else {
            print("connect_wearable invalid params")
            handleConnectWearable(modelName: self.defaultWearable, deviceName: "")
            break
          }
          handleConnectWearable(modelName: modelName, deviceName: deviceName)
          break
        case .disconnectWearable:
          self.sendText(" ")// clear the screen
          handleDisconnectWearable()
          break
          
        case .forgetSmartGlasses:
          handleDisconnectWearable()
          self.defaultWearable = ""
          self.deviceName = ""
          self.g1Manager?.DEVICE_SEARCH_ID = ""
          saveSettings()
          handleRequestStatus()
          break
          
        case .searchForCompatibleDeviceNames:
          if let params = params, let modelName = params["model_name"] as? String {
            print("Searching for compatible device names for: \(modelName)")
            handleSearchForCompatibleDeviceNames(modelName)
          } else {
            print("search_for_compatible_device_names invalid params")
          }
          
        case .enableContextualDashboard:
          guard let params = params, let enabled = params["enabled"] as? Bool else {
            print("enable_contextual_dashboard invalid params")
            break
          }
          self.contextualDashboard = enabled
          saveSettings()
          handleRequestStatus()// to update the UI
          break
        case .setPreferredMic:
          guard let params = params, let mic = params["mic"] as? String else {
            print("set_preferred_mic invalid params")
            break
          }
          self.preferredMic = mic
          onMicrophoneStateChange(self.micEnabled)
          saveSettings()
          handleRequestStatus()// to update the UI
          break
        case .startApp:
          if let params = params, let target = params["target"] as? String {
            print("Starting app: \(target)")
            serverComms.startApp(packageName: target)
          } else {
            print("start_app invalid params")
          }
          handleRequestStatus()
          break
        case .stopApp:
          if let params = params, let target = params["target"] as? String {
            print("Stopping app: \(target)")
            serverComms.stopApp(packageName: target)
          } else {
            print("stop_app invalid params")
          }
          break
        case .unknown:
          print("Unknown command type: \(commandString)")
          handleRequestStatus()
        case .ping:
          break
        case .updateGlassesHeadUpAngle:
          guard let params = params, let value = params["headUpAngle"] as? Int else {
            print("update_glasses_head_up_angle invalid params")
            break
          }
          self.headUpAngle = value
          self.g1Manager?.RN_setHeadUpAngle(value)
          saveSettings()
          handleRequestStatus()// to update the UI
          break
        case .updateGlassesBrightness:
          guard let params = params, let value = params["brightness"] as? Int, let autoBrightness = params["autoBrightness"] as? Bool else {
            print("update_glasses_brightness invalid params")
            break
          }
          let autoBrightnessChanged = self.autoBrightness != autoBrightness
          self.brightness = value
          self.autoBrightness = autoBrightness
          Task {
            self.g1Manager?.RN_setBrightness(value, autoMode: autoBrightness)
            if autoBrightnessChanged {
              sendText(autoBrightness ? "Enabled auto brightness" : "Disabled auto brightness")
            } else {
              sendText("Set brightness to \(value)%")
            }
            try? await Task.sleep(nanoseconds: 800_000_000) // 0.8 seconds
            sendText(" ")// clear screen
          }
          saveSettings()
          handleRequestStatus()// to update the UI
          break
        case .updateGlassesDashboardHeight:
          guard let params = params, let value = params["height"] as? Int else {
            print("update_glasses_brightness invalid params")
            break
          }
          self.dashboardHeight = value
          Task {
            await self.g1Manager?.RN_setDashboardPosition(self.dashboardHeight, self.dashboardDepth)
            // sendText("Set dashboard position to \(value)")
            // try? await Task.sleep(nanoseconds: 2_000_000_000) // 2 seconds
            // sendText(" ")// clear screen
          }
          saveSettings()
          handleRequestStatus()// to update the UI
          break
        case .showDashboard:
          Task {
            await self.g1Manager?.RN_showDashboard()
          }
        case .updateGlassesDepth:
          guard let params = params, let value = params["depth"] as? Int else {
            print("update_glasses_depth invalid params")
            break
          }
          self.dashboardDepth = value
          Task {
            await self.g1Manager?.RN_setDashboardPosition(self.dashboardHeight, self.dashboardDepth)
          }
          saveSettings()
        case .enableSensing:
          guard let params = params, let enabled = params["enabled"] as? Bool else {
            print("enable_sensing invalid params")
            break
          }
          self.sensingEnabled = enabled
          saveSettings()
          // Update microphone state when sensing is toggled
          onMicrophoneStateChange(self.micEnabled)
          handleRequestStatus()// to update the UI
          break
        case .enableAlwaysOnStatusBar:
          guard let params = params, let enabled = params["enabled"] as? Bool else {
            print("enable_always_on_status_bar invalid params")
            break
          }
          self.alwaysOnStatusBar = enabled
          saveSettings()
          handleRequestStatus()// to update the UI
          break
        case .bypassVad:
          guard let params = params, let enabled = params["enabled"] as? Bool else {
            print("bypass_vad invalid params")
            break
          }
          self.bypassVad = enabled
          saveSettings()
          handleRequestStatus()// to update the UI
          break
        case .bypassAudioEncoding:
          guard let params = params, let enabled = params["enabled"] as? Bool else {
            print("bypass_audio_encoding invalid params")
            break
          }
          self.bypassAudioEncoding = enabled
          break
        case .forceCoreOnboardMic:
          print("force_core_onboard_mic deprecated")
          // guard let params = params, let enabled = params["enabled"] as? Bool else {
          //   print("force_core_onboard_mic invalid params")
          //   break
          // }
          // self.useOnboardMic = enabled
          break
        case .setMetricSystemEnabled:
          guard let params = params, let enabled = params["enabled"] as? Bool else {
            print("set_metric_system_enabled invalid params")
            break
          }
          self.metricSystemEnabled = enabled
          saveSettings()
          handleRequestStatus()
          break
        case .unknown:
          print("Unknown command type: \(commandString)")
          handleRequestStatus()
        case .ping:
          break
        }
      }
    } catch {
      print("Error parsing JSON command: \(error.localizedDescription)")
    }
  }
  
  // Handler methods for each command type
  private func handleSetAuthSecretKey(userId: String, authSecretKey: String) {
    self.setup()// finish init():
    self.coreToken = authSecretKey
    self.coreTokenOwner = userId
    print("Setting auth secret key for user: \(userId)")
    serverComms.setAuthCredentials(userId, authSecretKey)
    print("Connecting to AugmentOS...")
    serverComms.connectWebSocket()
  }
  
  private func handleDisconnectWearable() {
    Task {
      connectTask?.cancel()
      disconnect()
      self.isSearching = false
      handleRequestStatus()
    }
  }

  private func getGlassesHasMic() -> Bool {
    if self.defaultWearable.contains("G1") {
      return true
    }
    return false
  }
  
  private func handleRequestStatus() {
    // construct the status object:

    let isGlassesConnected = self.g1Manager?.g1Ready ?? false
    
    // also referenced as glasses_info:
    var connectedGlasses: [String: Any] = [:];
    var glassesSettings: [String: Any] = [:];
    
    self.somethingConnected = false
    if (self.defaultWearable == "Simulated Glasses") {
      connectedGlasses = [
        "model_name": self.defaultWearable,
      ]
      self.somethingConnected = true
    }
    
    if isGlassesConnected {
      connectedGlasses = [
        "model_name": self.defaultWearable,
        "battery_life": self.batteryLevel,
      ]
      self.somethingConnected = true
    }

    glassesSettings = [
        "brightness": self.brightness,
        "auto_brightness": self.autoBrightness,
        "dashboard_height": self.dashboardHeight,
        "dashboard_depth": self.dashboardDepth,
        "head_up_angle": self.headUpAngle,
    ]
    
    let cloudConnectionStatus = self.serverComms.isWebSocketConnected() ? "CONNECTED" : "DISCONNECTED"
    
    let coreInfo: [String: Any] = [
      "augmentos_core_version": "Unknown",
      "cloud_connection_status": cloudConnectionStatus,
      "default_wearable": self.defaultWearable as Any,
      "force_core_onboard_mic": self.useOnboardMic,
      "preferred_mic": self.preferredMic,
      "is_searching": self.isSearching && !self.defaultWearable.isEmpty,
      // only on if recording from glasses:
      // todo: this isn't robust:
      "is_mic_enabled_for_frontend": self.micEnabled && (self.preferredMic == "glasses") && self.somethingConnected,
      "sensing_enabled": self.sensingEnabled,
      "always_on_status_bar": self.alwaysOnStatusBar,
      "bypass_vad_for_debugging": self.bypassVad,
      "bypass_audio_encoding_for_debugging": self.bypassAudioEncoding,
      "core_token": self.coreToken,
      "puck_connected": true,
      "metric_system_enabled": self.metricSystemEnabled,
    ]
    
    // hardcoded list of apps:
    var apps: [[String: Any]] = []
    
    // for tpa in self.cachedThirdPartyAppList {
    //   if tpa.name == "Notify" { continue }// TODO: ios notifications don't work so don't display the TPA
    //   let tpaDict = [
    //     "packageName": tpa.packageName,
    //     "name": tpa.name,
    //     "description": tpa.description,
    //     "webhookURL": tpa.webhookURL,
    //     "logoURL": tpa.logoURL,
    //     "is_running": tpa.isRunning,
    //     "is_foreground": false
    //   ] as [String: Any]
    //   // apps.append(tpaDict)
    // }
    
    let authObj: [String: Any] = [
      "core_token_owner": self.coreTokenOwner,
      //      "core_token_status":
    ]
    
    let statusObj: [String: Any] = [
      "connected_glasses": connectedGlasses,
      "glasses_settings": glassesSettings,
      "apps": apps,
      "core_info": coreInfo,
      "auth": authObj
    ]
    let wrapperObj: [String: Any] = ["status": statusObj]
    
    // print("wrapperStatusObj \(wrapperObj)")
    // must convert to string before sending:
    do {
      let jsonData = try JSONSerialization.data(withJSONObject: wrapperObj, options: [])
      if let jsonString = String(data: jsonData, encoding: .utf8) {
        CoreCommsService.emitter.sendEvent(withName: "CoreMessageEvent", body: jsonString)
      }
    } catch {
      print("Error converting to JSON: \(error)")
    }
    saveSettings()
  }
  
  private func playStartupSequence() {
    print("playStartupSequence()")
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
        self.sendText("                  /// AugmentOS Connected \\\\\\")
        animationQueue.asyncAfter(deadline: .now() + 1.0) {
          self.sendText(" ")
        }
        return
      }
      
      // Display current animation frame
      let frameText = "                    \(arrowFrames[frameIndex]) AugmentOS Booting \(arrowFrames[frameIndex])"
      self.sendText(frameText)
      
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
  
  private func handleDeviceReady() {
    self.isSearching = false
    self.defaultWearable = "Even Realities G1"
    self.handleRequestStatus()
    // load settings and send the animation:
    Task {
      
      // give the glasses some extra time to finish booting:
      try? await Task.sleep(nanoseconds: 1_000_000_000) // 3 seconds
      await self.g1Manager?.setSilentMode(false)// turn off silent mode
      await self.g1Manager?.getBatteryStatus()
      sendText("// BOOTING AUGMENTOS")
      
      // send loaded settings to glasses:
      self.g1Manager?.RN_getBatteryStatus()
      try? await Task.sleep(nanoseconds: 400_000_000)
      self.g1Manager?.RN_setHeadUpAngle(headUpAngle)
      try? await Task.sleep(nanoseconds: 400_000_000)
      self.g1Manager?.RN_setHeadUpAngle(headUpAngle)
      try? await Task.sleep(nanoseconds: 400_000_000)
      self.g1Manager?.RN_setBrightness(brightness, autoMode: autoBrightness)
      try? await Task.sleep(nanoseconds: 400_000_000)
      self.g1Manager?.RN_setDashboardPosition(self.dashboardHeight, self.dashboardDepth)
     try? await Task.sleep(nanoseconds: 400_000_000)
//      playStartupSequence()
      sendText("// AUGMENTOS CONNECTED")
      try? await Task.sleep(nanoseconds: 1_000_000_000) // 1 second
      sendText(" ")// clear screen
      
      
      // send to the server our battery status:
      self.serverComms.sendBatteryStatus(level: self.batteryLevel, charging: false)
      self.serverComms.sendGlassesConnectionState(modelName: self.defaultWearable, status: "CONNECTED")
      
      // enable the mic if it was last on:
      // print("ENABLING MIC STATE: \(self.micEnabled)")
      // onMicrophoneStateChange(self.micEnabled)
      self.handleRequestStatus()
    }
  }

  private func handleDeviceDisconnected() {
    print("Device disconnected")
    onMicrophoneStateChange(false)// technically shouldn't be necessary
    self.serverComms.sendGlassesConnectionState(modelName: self.defaultWearable, status: "DISCONNECTED")
    self.handleRequestStatus()
  }
  
  private func handleConnectWearable(modelName: String, deviceName: String) {
    print("Connecting to wearable: \(modelName)")
    
    if (modelName.contains("Virtual") || self.defaultWearable.contains("Virtual")) {
      // we don't need to search for a virtual device
      return
    }

    if (self.defaultWearable.isEmpty) {
      return
    }
    
    self.isSearching = true
    handleRequestStatus()// update the UI
    
    print("deviceName: \(deviceName) selfDeviceName: \(self.deviceName)")

    Task {
      disconnect()
      if (deviceName != "") {
        self.deviceName = deviceName
        saveSettings()
        self.g1Manager?.RN_pairById(deviceName)
      } else if self.deviceName != "" {
        self.g1Manager?.RN_pairById(self.deviceName)
      } else {
        print("this shouldn't happen (we don't have a deviceName saved, connecting will fail if we aren't already paired)")
        
      }
    }
    
    // wait for the g1's to be fully ready:
//    connectTask?.cancel()
//    connectTask = Task {
//      while !(connectTask?.isCancelled ?? true) {
//        print("checking if g1 is ready... \(self.g1Manager?.g1Ready ?? false)")
//        print("leftReady \(self.g1Manager?.leftReady ?? false) rightReady \(self.g1Manager?.rightReady ?? false)")
//        if self.g1Manager?.g1Ready ?? false {
//          // we actualy don't need this line:
//          //          handleDeviceReady()
//          handleRequestStatus()
//          break
//        } else {
//          // todo: ios not the cleanest solution here
//          self.g1Manager?.RN_startScan()
//        }
//        
//        try? await Task.sleep(nanoseconds: 15_000_000_000) // 15 seconds
//      }
//    }
  }
  
  
  // MARK: - Settings Management
  
  private enum SettingsKeys {
    static let defaultWearable = "defaultWearable"
    static let deviceName = "deviceName"
    static let useOnboardMic = "useBoardMic"
    static let contextualDashboard = "contextualDashboard"
    static let headUpAngle = "headUpAngle"
    static let brightness = "brightness"
    static let autoBrightness = "autoBrightness"
    static let sensingEnabled = "sensingEnabled"
    static let dashboardHeight = "dashboardHeight"
    static let dashboardDepth = "dashboardDepth"
    static let alwaysOnStatusBar = "alwaysOnStatusBar"
    static let bypassVad = "bypassVad"
    static let bypassAudioEncoding = "bypassAudioEncoding"
    static let preferredMic = "preferredMic"
    static let metricSystemEnabled = "metricSystemEnabled"
  }
  
  private func saveSettings() {
    
    print("about to save settings, waiting for loaded settings first: \(settingsLoaded)")
    if !settingsLoaded {
        // Wait for settings to load with a timeout
        let timeout = DispatchTime.now() + .seconds(5) // 5 second timeout
        let result = settingsLoadedSemaphore.wait(timeout: timeout)
        
        if result == .timedOut {
            print("Warning: Settings load timed out, proceeding with default values")
        }
    }
    
    let defaults = UserDefaults.standard
    
    // Save each setting with its corresponding key
    defaults.set(defaultWearable, forKey: SettingsKeys.defaultWearable)
    defaults.set(deviceName, forKey: SettingsKeys.deviceName)
    defaults.set(contextualDashboard, forKey: SettingsKeys.contextualDashboard)
    defaults.set(headUpAngle, forKey: SettingsKeys.headUpAngle)
    defaults.set(brightness, forKey: SettingsKeys.brightness)
    defaults.set(autoBrightness, forKey: SettingsKeys.autoBrightness)
    defaults.set(sensingEnabled, forKey: SettingsKeys.sensingEnabled)
    defaults.set(dashboardHeight, forKey: SettingsKeys.dashboardHeight)
    defaults.set(dashboardDepth, forKey: SettingsKeys.dashboardDepth)
    defaults.set(alwaysOnStatusBar, forKey: SettingsKeys.alwaysOnStatusBar)
    defaults.set(bypassVad, forKey: SettingsKeys.bypassVad)
    defaults.set(bypassAudioEncoding, forKey: SettingsKeys.bypassAudioEncoding)
    defaults.set(preferredMic, forKey: SettingsKeys.preferredMic)
    defaults.set(metricSystemEnabled, forKey: SettingsKeys.metricSystemEnabled)
    
    // Force immediate save (optional, as UserDefaults typically saves when appropriate)
    defaults.synchronize()
    
    print("Settings saved: Default Wearable: \(defaultWearable ?? "None"), Preferred Mic: \(preferredMic), " +
          "Contextual Dashboard: \(contextualDashboard), Head Up Angle: \(headUpAngle), Brightness: \(brightness)")
  }
  
  private func loadSettings() async {
    
    UserDefaults.standard.register(defaults: [SettingsKeys.sensingEnabled: true])
    UserDefaults.standard.register(defaults: [SettingsKeys.contextualDashboard: true])
    UserDefaults.standard.register(defaults: [SettingsKeys.bypassVad: false])
    UserDefaults.standard.register(defaults: [SettingsKeys.sensingEnabled: true])
    UserDefaults.standard.register(defaults: [SettingsKeys.preferredMic: "glasses"])
    UserDefaults.standard.register(defaults: [SettingsKeys.brightness: 50])
    UserDefaults.standard.register(defaults: [SettingsKeys.headUpAngle: 30])
    UserDefaults.standard.register(defaults: [SettingsKeys.metricSystemEnabled: false])
    UserDefaults.standard.register(defaults: [SettingsKeys.autoBrightness: true])
    
    let defaults = UserDefaults.standard
    
    // Load each setting with appropriate type handling
    defaultWearable = defaults.string(forKey: SettingsKeys.defaultWearable) ?? ""
    deviceName = defaults.string(forKey: SettingsKeys.deviceName) ?? ""
    preferredMic = defaults.string(forKey: SettingsKeys.preferredMic) ?? "glasses"
    contextualDashboard = defaults.bool(forKey: SettingsKeys.contextualDashboard)
    autoBrightness = defaults.bool(forKey: SettingsKeys.autoBrightness)
    sensingEnabled = defaults.bool(forKey: SettingsKeys.sensingEnabled)
    dashboardHeight = defaults.integer(forKey: SettingsKeys.dashboardHeight)
    dashboardDepth = defaults.integer(forKey: SettingsKeys.dashboardDepth)
    alwaysOnStatusBar = defaults.bool(forKey: SettingsKeys.alwaysOnStatusBar)
    bypassVad = defaults.bool(forKey: SettingsKeys.bypassVad)
    bypassAudioEncoding = defaults.bool(forKey: SettingsKeys.bypassAudioEncoding)
    headUpAngle = defaults.integer(forKey: SettingsKeys.headUpAngle)
    brightness = defaults.integer(forKey: SettingsKeys.brightness)
    metricSystemEnabled = defaults.bool(forKey: SettingsKeys.metricSystemEnabled)
  
    // Mark settings as loaded and signal completion
    self.settingsLoaded = true
    self.settingsLoadedSemaphore.signal()
    
    print("Settings loaded: Default Wearable: \(defaultWearable ?? "None"), Preferred Mic: \(preferredMic), " +
          "Contextual Dashboard: \(contextualDashboard), Head Up Angle: \(headUpAngle), Brightness: \(brightness)")
  }
  
  // MARK: - Cleanup
  
  @objc func cleanup() {
    cancellables.removeAll()
    saveSettings()
  }
}
