import AVFoundation
import Foundation

/// Phone-mic uplink for ACS virtual outgoing. Taps the hardware input at
/// whatever rate the session is already using and never switches the session
/// into voice-chat / speaker-default, so A2DP playback can stay on the glasses.
final class PhoneMicCapturer {
  private let engine = AVAudioEngine()
  private var running = false
  var onPcm: ((Data, Int, Int) -> Void)?

  func setEnabled(_ enabled: Bool) {
    if enabled { start() } else { stop() }
  }

  private func start() {
    guard !running else { return }
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playAndRecord, mode: .default, options: [.mixWithOthers, .allowBluetoothA2DP])
      try session.setPreferredSampleRate(48_000)
      try session.setActive(true, options: [])
      let input = engine.inputNode
      let hwFormat = input.inputFormat(forBus: 0)
      input.removeTap(onBus: 0)
      input.installTap(onBus: 0, bufferSize: 960, format: hwFormat) { [weak self] buffer, _ in
        guard let self, let data = Self.pcm16(from: buffer) else { return }
        self.onPcm?(data, Int(buffer.format.sampleRate), Int(buffer.format.channelCount))
      }
      try engine.start()
      running = true
      NSLog("ACS-SPIKE PhoneMicCapturer started")
    } catch {
      NSLog("ACS-SPIKE PhoneMicCapturer start failed: \(error)")
      stop()
    }
  }

  private func stop() {
    engine.inputNode.removeTap(onBus: 0)
    if engine.isRunning { engine.stop() }
    running = false
    NSLog("ACS-SPIKE PhoneMicCapturer stopped")
  }

  private static func pcm16(from buffer: AVAudioPCMBuffer) -> Data? {
    let frames = Int(buffer.frameLength)
    guard frames > 0 else { return nil }
    let channels = Int(buffer.format.channelCount)
    if let int16 = buffer.int16ChannelData {
      return Data(bytes: int16[0], count: frames * channels * 2)
    }
    guard let floats = buffer.floatChannelData else { return nil }
    var out = [Int16](repeating: 0, count: frames * channels)
    for ch in 0..<channels {
      let src = floats[ch]
      for i in 0..<frames {
        let clipped = max(-1.0, min(1.0, src[i]))
        out[i * channels + ch] = Int16(clipped * Float(Int16.max))
      }
    }
    return out.withUnsafeBytes { Data($0) }
  }
}
