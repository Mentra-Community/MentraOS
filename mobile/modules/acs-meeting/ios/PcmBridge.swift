import Foundation

/// Downmix/resample PCM16 to 16 kHz mono ~20 ms blocks for ACS raw outgoing audio.
final class PcmBridge {
  private var dump = Data()
  private var dumpRate = 0
  private var dumpChannels = 0
  private var dumped = false
  private var pending = Data()
  private let dumpWav: Bool
  private var lastRmsLog = Date.distantPast

  init(dumpWav: Bool) {
    self.dumpWav = dumpWav
  }

  func ingest(pcm16Le: Data, sampleRate: Int, channels: Int) -> [Data] {
    if dumpWav, !dumped {
      dump.append(pcm16Le)
      dumpRate = sampleRate
      dumpChannels = channels
      if dump.count >= 30 * sampleRate * channels * 2 {
        finishDump()
      }
    }
    logLevel(pcm16Le, sampleRate: sampleRate, channels: channels)
    let mono = Self.toMono16k(pcm16Le, sampleRate: sampleRate, channels: channels)
    pending.append(mono)
    let frameBytes = 16000 * 2 / 50
    var frames: [Data] = []
    while pending.count >= frameBytes {
      frames.append(pending.prefix(frameBytes))
      pending.removeFirst(frameBytes)
    }
    return frames
  }

  func finishDump() {
    guard dumpWav, !dumped else { return }
    dumped = true
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("acs-whep-p4.wav")
    try? Self.wav(pcm: dump, sampleRate: dumpRate, channels: dumpChannels).write(to: url)
    NSLog("ACS-SPIKE P4 wrote \(url.path) bytes=\(dump.count) rate=\(dumpRate) ch=\(dumpChannels)")
    dump.removeAll()
  }

  private func logLevel(_ pcm: Data, sampleRate: Int, channels: Int) {
    let now = Date()
    guard now.timeIntervalSince(lastRmsLog) >= 1 else { return }
    lastRmsLog = now
    var acc: Int64 = 0
    var count = 0
    pcm.withUnsafeBytes { raw in
      let samples = raw.bindMemory(to: Int16.self)
      for sample in samples {
        acc += Int64(abs(Int32(sample)))
        count += 1
      }
    }
    let mean = count == 0 ? 0 : acc / Int64(count)
    NSLog("ACS-SPIKE P4 pcm rate=\(sampleRate) ch=\(channels) meanAbs=\(mean) bytes=\(pcm.count)")
  }

  static func toMono16k(_ pcm16Le: Data, sampleRate: Int, channels: Int) -> Data {
    let samples = pcm16Le.withUnsafeBytes { Array($0.bindMemory(to: Int16.self)) }
    let mono: [Int16]
    if channels <= 1 {
      mono = samples
    } else {
      mono = stride(from: 0, to: samples.count, by: channels).map { index in
        var acc = 0
        for channel in 0 ..< channels where index + channel < samples.count {
          acc += Int(samples[index + channel])
        }
        return Int16(acc / channels)
      }
    }
    if sampleRate == 16000 {
      return mono.withUnsafeBufferPointer { Data(buffer: $0) }
    }
    let outCount = max(1, mono.count * 16000 / sampleRate)
    var resampled = [Int16](repeating: 0, count: outCount)
    for i in 0 ..< outCount {
      let src = min(mono.count - 1, i * sampleRate / 16000)
      resampled[i] = mono[src]
    }
    return resampled.withUnsafeBufferPointer { Data(buffer: $0) }
  }

  static func wav(pcm: Data, sampleRate: Int, channels: Int) -> Data {
    var header = Data()
    func put(_ value: UInt32) {
      var le = value.littleEndian
      header.append(Data(bytes: &le, count: 4))
    }
    func put16(_ value: UInt16) {
      var le = value.littleEndian
      header.append(Data(bytes: &le, count: 2))
    }
    header.append(contentsOf: [UInt8]("RIFF".utf8))
    put(UInt32(36 + pcm.count))
    header.append(contentsOf: [UInt8]("WAVE".utf8))
    header.append(contentsOf: [UInt8]("fmt ".utf8))
    put(16)
    put16(1)
    put16(UInt16(channels))
    put(UInt32(sampleRate))
    put(UInt32(sampleRate * channels * 2))
    put16(UInt16(channels * 2))
    put16(16)
    header.append(contentsOf: [UInt8]("data".utf8))
    put(UInt32(pcm.count))
    return header + pcm
  }
}
