//
//  OnboardMicrophoneManager.swift
//  AugmentOS_Manager
//
//  Created on 3/8/25.
//

import Foundation
import AVFoundation
import Combine

protocol MicCallback {
  func onRouteChange(reason: AVAudioSession.RouteChangeReason, availableInputs: [AVAudioSessionPortDescription])
  func onInterruption(began: Bool)
}

class OnboardMicrophoneManager {
  // MARK: - Properties
  
  /// Publisher for voice data
  private let voiceDataSubject = PassthroughSubject<Data, Never>()
  private var audioRecording = [Data]();
  private var audioPlayer: AVAudioPlayer?

  private var micCallback: MicCallback?
  
  /// Public access to voice data stream
  var voiceData: AnyPublisher<Data, Never> {
    return voiceDataSubject.eraseToAnyPublisher()
  }
  
  /// Audio recording components
  private var audioEngine: AVAudioEngine?
  private var audioSession: AVAudioSession?
  
  /// Recording state
  private(set) var isRecording = false
  
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

  func setMicCallback(_ callback: MicCallback) {
    self.micCallback = callback
  }
  
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
      print("No available inputs found")
      return false
    }
    
    // Find input containing the specified name (case insensitive)
    guard let preferredInput = availableInputs.first(where: {
      $0.portName.range(of: deviceName, options: .caseInsensitive) != nil
    }) else {
      print("No input device found containing name: \(deviceName)")
      return false
    }
    
    do {
      try AVAudioSession.sharedInstance().setPreferredInput(preferredInput)
      print("Successfully set preferred input to: \(preferredInput.portName)")
      return true
    } catch {
      print("Failed to set preferred input: \(error)")
      return false
    }
  }
  
  @objc private func handleInterruption(notification: Notification) {
      guard let userInfo = notification.userInfo,
            let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
          return
      }
      
      switch type {
      case .began:
          print("Audio session interrupted - another app took control")
          // Phone call started, pause recording
          if isRecording {
//              stopRecording()
            micCallback?.onInterruption(began: true)
          }
      case .ended:
          print("Audio session interruption ended")
          if let optionsValue = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt {
              let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
              if options.contains(.shouldResume) {
                  // Safe to resume recording
//                  _ = startRecording()
                micCallback?.onInterruption(began: false)
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
          let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else {
      return
    }

    print("handleRouteChange: \(reason) @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@")
    micCallback?.onRouteChange(reason: reason, availableInputs: audioSession?.availableInputs ?? [])
    
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
        routeDescription += "- Input \(index + 1): \(port.portName) (type: \(port.portType.rawValue))\n"
      }
    }
    
    // Log outputs
    if currentRoute.outputs.isEmpty {
      routeDescription += "- No output ports"
    } else {
      for (index, port) in currentRoute.outputs.enumerated() {
        routeDescription += "- Output \(index + 1): \(port.portName) (type: \(port.portType.rawValue))"
        if index < currentRoute.outputs.count - 1 {
          routeDescription += "\n"
        }
      }
    }
    
    print(routeDescription)
  }
  
  // MARK: - Private Helpers
  
  /// Extract Int16 data from a converted buffer
  private func extractInt16Data(from buffer: AVAudioPCMBuffer) -> Data {
    let channelCount = Int(buffer.format.channelCount)
    let frameCount = Int(buffer.frameLength)
    let data = NSMutableData()
    
    // Safely get int16 data (won't be nil if buffer is in Int16 format)
    guard let int16Data = buffer.int16ChannelData else {
      print("Error: Buffer does not contain int16 data")
      return Data()
    }
    
    let channels = UnsafeBufferPointer(start: int16Data, count: channelCount)
    
    // Extract each sample
    for frame in 0..<frameCount {
      for channel in 0..<channelCount {
        var sample = channels[channel][frame]
        data.append(&sample, length: 2)
      }
    }
    
    return data as Data
  }
  
  /// Start recording from the available microphone (built-in, Bluetooth, AirPods, etc.)
  func startRecording() -> Bool {
    // Don't restart if already recording
    if isRecording {
      return true
    }
    
    audioRecording.removeAll()
    
    // Check permissions first
    guard checkPermissions() else {
      print("Microphone permissions not granted")
      return false
    }
    
    // Initialize audio session
    audioSession = AVAudioSession.sharedInstance()
    do {
      // First deactivate the session to reset any previous state
      try audioSession?.setActive(false, options: .notifyOthersOnDeactivation)
      
      // Use playAndRecord instead of record category, as this has better compatibility with iOS 16+
      // and works with Bluetooth headsets more reliably
      try audioSession?.setCategory(.playAndRecord, mode: .default, options: [.allowBluetooth, .defaultToSpeaker])
      
      // Find and prefer AirPods if available
      if let availableInputs = audioSession?.availableInputs, !availableInputs.isEmpty {
        print("Available audio inputs:")
        
        // Log all available inputs for debugging
        for (index, input) in availableInputs.enumerated() {
          print("[\(index)] \(input.portName) (type: \(input.portType.rawValue))")
        }
        
        // Try to find AirPods or other Bluetooth headphones
        let preferredInput = availableInputs.first { input in
          return input.portType == .bluetoothHFP ||
                 input.portType == .bluetoothA2DP
        } ?? availableInputs.first // Fallback to first available input if no AirPods found
        
        // Set the preferred input
        try audioSession?.setPreferredInput(preferredInput)
        print("Set preferred input to: \(preferredInput?.portName ?? "None")")
      }
      
      // Now activate the session
      try audioSession?.setActive(true, options: .notifyOthersOnDeactivation)
      
      // Log the current audio route to see which device is being used
      logCurrentAudioRoute()
    } catch {
      print("Failed to set up audio session: \(error)")
      return false
    }
    
    // Initialize audio engine and input node
    audioEngine = AVAudioEngine()
    guard let inputNode = audioEngine?.inputNode else {
      print("Failed to get audio input node")
      return false
    }
    
    // Get the native input format - typically 48kHz floating point samples
    let inputFormat = inputNode.inputFormat(forBus: 0)
    print("Input format: \(inputFormat)")
    
    // Set up a converter node if you need 16-bit PCM
    let converter = AVAudioConverter(from: inputFormat, to: AVAudioFormat(commonFormat: .pcmFormatInt16,
                                                                          sampleRate: 16000,
                                                                          channels: 1,
                                                                          interleaved: true)!)
    
    guard let converter = converter else {
      print("converter is nil")
      return false
    }
    
    inputNode.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, time in
      guard let self = self else { return }
      
      let frameCount = Int(buffer.frameLength)
      
      // Calculate the correct output buffer capacity based on sample rate conversion
      // For downsampling from inputFormat.sampleRate to 16000 Hz
      let outputCapacity = AVAudioFrameCount(Double(frameCount) * (16000.0 / inputFormat.sampleRate))
      
      // Create a 16-bit PCM data buffer with adjusted capacity
      let convertedBuffer = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: outputCapacity)!
      
      var error: NSError? = nil
      let status = converter.convert(to: convertedBuffer, error: &error, withInputFrom: { _, outStatus in
        outStatus.pointee = .haveData
        return buffer
      })
      
      guard status == .haveData && error == nil else {
        print("Error converting audio buffer: \(error?.localizedDescription ?? "unknown")")
        return
      }
      
      let pcmData = self.extractInt16Data(from: convertedBuffer)
      
      // just publish the PCM data, we'll encode it in the AOSManager:
      self.voiceDataSubject.send(pcmData)
    }
    
    // Start the audio engine
    do {
      try audioEngine?.start()
      isRecording = true
      print("Started recording from: \(getActiveInputDevice() ?? "Unknown device")")
      return true
    } catch {
      print("Failed to start audio engine: \(error)")
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
    guard isRecording else {
      return
    }
    
    // Remove the tap and stop the engine
    audioEngine?.inputNode.removeTap(onBus: 0)
    audioEngine?.stop()
    
    // Clean up
    try? audioSession?.setActive(false)
    audioEngine = nil
    audioSession = nil
    isRecording = false
    
    print("Stopped recording")
    // play back the audio (for testing only):
//    playbackRecordedAudio()
  }
  
  
  /// Play back the recorded audio data
  private func playbackRecordedAudio() {
    guard !audioRecording.isEmpty else {
      print("No audio data to play back")
      return
    }
    
    // Combine all audio chunks into a single data object
    let combinedData = audioRecording.reduce(Data()) { $0 + $1 }
    
    do {
      // Reset audio session for playback
      let playbackSession = AVAudioSession.sharedInstance()
      try playbackSession.setCategory(.playback, mode: .default)
      try playbackSession.setActive(true)
      
      // Create a temporary WAV file with proper headers
      let tempDirectoryURL = FileManager.default.temporaryDirectory
      let tempFileURL = tempDirectoryURL.appendingPathComponent("temp_recording.wav")
      
      // Create WAV file with appropriate headers
      createWavFile(with: combinedData, at: tempFileURL)
      
      // Create audio player from the WAV file
      audioPlayer = try AVAudioPlayer(contentsOf: tempFileURL)
      audioPlayer?.prepareToPlay()
      audioPlayer?.play()
      
      print("Playing back recorded audio, data size: \(combinedData.count) bytes")
    } catch {
      print("Audio playback error: \(error.localizedDescription)")
    }
  }
  
  /// Create a WAV file with the proper headers for the recorded PCM data
  private func createWavFile(with pcmData: Data, at url: URL) {
    // WAV header parameters
    let sampleRate: UInt32 = 16000
    let numChannels: UInt16 = 1
    let bitsPerSample: UInt16 = 16
    
    // Create WAV header
    var header = Data()
    
    // RIFF chunk descriptor
    header.append("RIFF".data(using: .ascii)!)
    let fileSize = UInt32(pcmData.count + 36) // File size minus 8 bytes for RIFF and fileSize
    header.append(withUnsafeBytes(of: fileSize.littleEndian) { Data($0) })
    header.append("WAVE".data(using: .ascii)!)
    
    // fmt sub-chunk
    header.append("fmt ".data(using: .ascii)!)
    var subchunk1Size: UInt32 = 16 // Size of the fmt sub-chunk
    header.append(withUnsafeBytes(of: subchunk1Size.littleEndian) { Data($0) })
    var audioFormat: UInt16 = 1 // PCM = 1
    header.append(withUnsafeBytes(of: audioFormat.littleEndian) { Data($0) })
    header.append(withUnsafeBytes(of: numChannels.littleEndian) { Data($0) })
    header.append(withUnsafeBytes(of: sampleRate.littleEndian) { Data($0) })
    
    let byteRate = UInt32(sampleRate * UInt32(numChannels) * UInt32(bitsPerSample) / 8)
    header.append(withUnsafeBytes(of: byteRate.littleEndian) { Data($0) })
    
    let blockAlign = UInt16(numChannels * bitsPerSample / 8)
    header.append(withUnsafeBytes(of: blockAlign.littleEndian) { Data($0) })
    header.append(withUnsafeBytes(of: bitsPerSample.littleEndian) { Data($0) })
    
    // data sub-chunk
    header.append("data".data(using: .ascii)!)
    let subchunk2Size = UInt32(pcmData.count)
    header.append(withUnsafeBytes(of: subchunk2Size.littleEndian) { Data($0) })
    
    // Combine header with PCM data
    let wavData = header + pcmData
    
    // Write WAV file
    try? wavData.write(to: url)
  }
  
  // MARK: - Cleanup
  
  func cleanup() {
    NotificationCenter.default.removeObserver(self)
    stopRecording()
  }
}
