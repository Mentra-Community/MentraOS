import AppKit
import AVFoundation
import CoreImage
import ScreenCaptureKit

final class RecordingObserver: NSObject, SCRecordingOutputDelegate, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var started = false
  private var finished = false
  private var failure: String?
  private var firstPTS: Double?
  private var latestBuffer: CVPixelBuffer?
  private var latestPTS: Double = 0
  private var latestHash: UInt64 = 0
  private var changedAt: Double = 0
  private var observedAt: Double = 0
  private var frameStatus: SCFrameStatus?
  private var frameCounts: [Int: Int] = [:]
  private var rejectedSamples = 0
  private var lastCallbackAt: Double = 0
  private var minimumSourcePTS: Double = 0

  func state() -> (Bool, Bool, String?, Double?) {
    lock.lock(); defer { lock.unlock() }
    return (started, finished, failure, firstPTS)
  }

  func diagnostic() -> String {
    lock.lock(); defer { lock.unlock() }
    let now = CMClockGetTime(CMClockGetHostTimeClock()).seconds
    return "recording started=\(started), last status=\(frameStatus?.rawValue ?? -1), frame status counts=\(frameCounts), rejected samples=\(rejectedSamples), complete image=\(latestBuffer != nil), callback age=\(now - lastCallbackAt), observation age=\(now - observedAt)"
  }

  func invalidateSource() {
    lock.lock(); defer { lock.unlock() }
    minimumSourcePTS = CMClockGetTime(CMClockGetHostTimeClock()).seconds
    latestBuffer = nil
    observedAt = 0
    frameStatus = nil
  }

  func recordingOutputDidStartRecording(_: SCRecordingOutput) {
    lock.lock(); started = true; lock.unlock()
  }

  func recordingOutputDidFinishRecording(_: SCRecordingOutput) {
    lock.lock(); finished = true; lock.unlock()
  }

  func recordingOutput(_: SCRecordingOutput, didFailWithError error: Error) {
    lock.lock(); failure = String(describing: error); lock.unlock()
  }

  func stream(_: SCStream, didStopWithError error: Error) {
    lock.lock(); failure = "Screen capture stopped: \(error)"; lock.unlock()
  }

  func stream(_: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    lock.lock()
    defer { lock.unlock() }
    lastCallbackAt = CMClockGetTime(CMClockGetHostTimeClock()).seconds
    guard type == .screen, sampleBuffer.isValid,
          let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
          let rawStatus = attachments.first?[.status] as? Int,
          let status = SCFrameStatus(rawValue: rawStatus) else { rejectedSamples += 1; return }
    frameCounts[rawStatus, default: 0] += 1
    guard CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds >= minimumSourcePTS else { return }
    frameStatus = status
    // Idle means the window server observed an unchanged screen. It confirms
    // liveness without replacing the last complete image with an empty buffer.
    if status == .complete || status == .idle {
      observedAt = CMClockGetTime(CMClockGetHostTimeClock()).seconds
    }
    guard status == .complete else { return }
    if firstPTS == nil { firstPTS = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds }
    latestBuffer = CMSampleBufferGetImageBuffer(sampleBuffer)
    latestPTS = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
    if let buffer = latestBuffer {
      CVPixelBufferLockBaseAddress(buffer, .readOnly)
      if let base = CVPixelBufferGetBaseAddress(buffer) {
        let rows = CVPixelBufferGetHeight(buffer), stride = CVPixelBufferGetBytesPerRow(buffer)
        let bytes = base.assumingMemoryBound(to: UInt8.self)
        var hash: UInt64 = 1_469_598_103_934_665_603
        for y in Swift.stride(from: 0, to: rows, by: max(1, rows / 64)) {
          for x in Swift.stride(from: 0, to: stride, by: max(1, stride / 128)) {
            hash = (hash ^ UInt64(bytes[y * stride + x])) &* 1_099_511_628_211
          }
        }
        if hash != latestHash { changedAt = CMClockGetTime(CMClockGetHostTimeClock()).seconds; latestHash = hash }
      }
      CVPixelBufferUnlockBaseAddress(buffer, .readOnly)
    }
  }

  func isSettled() -> Bool {
    lock.lock(); defer { lock.unlock() }
    let now = CMClockGetTime(CMClockGetHostTimeClock()).seconds
    return failure == nil && latestBuffer != nil && (frameStatus == .complete || frameStatus == .idle)
      && now - observedAt <= 1 && now - changedAt >= 0.2
  }

  func screenshot(path: String) throws -> [String: Any] {
    lock.lock()
    let buffer = latestBuffer
    let time = latestPTS - (firstPTS ?? latestPTS)
    let observationTime = observedAt - (firstPTS ?? observedAt)
    let age = CMClockGetTime(CMClockGetHostTimeClock()).seconds - observedAt
    let error = failure
    let status = frameStatus
    lock.unlock()
    if let error { throw DriverFailure(error) }
    guard age <= 1, status == .complete || status == .idle else {
      throw DriverFailure("No live video frame: last status \(status?.rawValue ?? -1), observation age \(age) seconds; \(diagnostic())")
    }
    guard let buffer else { throw DriverFailure("No video frame is available for a screenshot") }
    let image = CIImage(cvPixelBuffer: buffer)
    guard let cg = CIContext().createCGImage(image, from: image.extent),
          let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) else { throw DriverFailure("Video-frame PNG encoding failed") }
    try png.write(to: URL(fileURLWithPath: path), options: .atomic)
    return ["event": "screenshot", "width": cg.width, "height": cg.height, "bytes": png.count, "frameTime": time,
            "observationTime": observationTime, "observationAgeSeconds": age]
  }
}

func emitJSON(_ value: [String: Any]) throws {
  try FileHandle.standardOutput.write(JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) + Data("\n".utf8))
}

func readRecorderLine() async -> String? {
  await withCheckedContinuation { continuation in
    DispatchQueue.global().async { continuation.resume(returning: readLine()) }
  }
}

extension Driver {
  @MainActor func recordVideo(path: String) async throws {
    guard CGPreflightScreenCaptureAccess() else { throw DriverFailure("Screen Recording permission is missing") }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    let target = try capturableWindow(in: content)
    // The display compositor keeps producing observations when the standalone
    // window surface stalls. The allowlist still excludes every other app.
    let placement = try windowCapturePlacement(window: target.frame, displays: content.displays.map(\.frame))
    let display = content.displays[placement.displayIndex]
    let filter = SCContentFilter(display: display, including: [target])
    let configuration = SCStreamConfiguration()
    configuration.width = Int(target.frame.width * 2) / 2 * 2
    configuration.height = Int(target.frame.height * 2) / 2 * 2
    configuration.sourceRect = placement.sourceRect
    // External displays can provide 1x frames for this fixed 2x canvas. Scale
    // both up and down so moving displays cannot leave a quarter-sized image.
    configuration.scalesToFit = true
    configuration.preservesAspectRatio = true
    configuration.minimumFrameInterval = CMTime(value: 1, timescale: 15)
    configuration.capturesAudio = false
    configuration.captureMicrophone = false
    configuration.showsCursor = false
    configuration.ignoreShadowsSingleWindow = true
    configuration.includeChildWindows = true
    var currentPID = app.processIdentifier
    var currentWindowID = target.windowID
    var currentFrame = target.frame
    var currentDisplayID = display.displayID
    var parked = false
    let observer = RecordingObserver()
    let stream = SCStream(filter: filter, configuration: configuration, delegate: observer)
    try stream.addStreamOutput(observer, type: .screen, sampleHandlerQueue: DispatchQueue(label: "mentra.e2e.frames"))
    let recordingConfig = SCRecordingOutputConfiguration()
    recordingConfig.outputURL = URL(fileURLWithPath: path)
    recordingConfig.videoCodecType = .h264
    recordingConfig.outputFileType = .mp4
    let recording = SCRecordingOutput(configuration: recordingConfig, delegate: observer)
    try stream.addRecordingOutput(recording)
    func refreshSource(allowRelaunch: Bool = false) async throws {
      guard !parked || allowRelaunch else { throw DriverFailure("Recording is parked during app relaunch") }
      let fresh = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
      let running = try Driver(bundleID: bundleID)
      guard allowRelaunch || running.app.processIdentifier == currentPID else {
        throw DriverFailure("The app process changed without recording reattachment")
      }
      let window = try running.capturableWindow(in: fresh)
      guard abs(window.frame.width - target.frame.width) < 2,
            abs(window.frame.height - target.frame.height) < 2 else {
        throw DriverFailure("Window size changed during recording; restore the initial size")
      }
      let next = try windowCapturePlacement(window: window.frame, displays: fresh.displays.map(\.frame))
      let nextDisplay = fresh.displays[next.displayIndex]
      if parked || window.windowID != currentWindowID || window.frame != currentFrame || nextDisplay.displayID != currentDisplayID {
        configuration.sourceRect = next.sourceRect
        try await stream.updateContentFilter(SCContentFilter(display: nextDisplay, including: [window]))
        try await stream.updateConfiguration(configuration)
        // Discard queued images captured before the new crop/filter committed.
        // Keep the original video clock; require an actual subsequent callback.
        observer.invalidateSource()
        currentPID = running.app.processIdentifier
        currentWindowID = window.windowID
        currentFrame = window.frame
        currentDisplayID = nextDisplay.displayID
        parked = false
      }
    }
    try await stream.startCapture()
    let deadline = Date().addingTimeInterval(10)
    while !observer.state().0 || observer.state().3 == nil, Date() < deadline {
      if let error = observer.state().2 { throw DriverFailure(error) }
      try await Task.sleep(for: .milliseconds(20))
    }
    guard let origin = observer.state().3, observer.state().0 else {
      try? await stream.stopCapture()
      throw DriverFailure("Video did not produce its first frame: \(observer.diagnostic())")
    }
    func timestamp() -> Double {
      max(0, CMClockGetTime(CMClockGetHostTimeClock()).seconds - origin)
    }
    try emitJSON(["event": "ready", "time": timestamp(), "path": path, "width": configuration.width, "height": configuration.height,
                  "queueDepth": configuration.queueDepth, "windowID": target.windowID, "windowFrame": frameJSON(target.frame), "isOnScreen": target.isOnScreen,
                  "displays": content.displays.map { ["id": $0.displayID, "frame": frameJSON($0.frame)] as [String: Any] },
                  "screens": NSScreen.screens.map { frameJSON($0.frame) }])
    while let line = await readRecorderLine() {
      if let error = observer.state().2 { throw DriverFailure(error) }
      if line == "stop" { break }
      if line == "park" {
        let fresh = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        guard let display = fresh.displays.first else { throw DriverFailure("No display available during relaunch") }
        try await stream.updateContentFilter(SCContentFilter(display: display, including: []))
        parked = true
        observer.invalidateSource()
        try emitJSON(["event": "parked", "time": timestamp()])
        continue
      }
      if line == "mark" { try await refreshSource(); try emitJSON(["event": "mark", "time": timestamp()]); continue }
      if line == "diagnostic" { try emitJSON(["event": "diagnostic", "time": timestamp(), "detail": observer.diagnostic()]); continue }
      if line.hasPrefix("{") {
        guard let request = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: String],
              request["op"] == "screenshot", let path = request["path"] else { throw DriverFailure("Invalid recorder request") }
        try await refreshSource()
        let settleDeadline = Date().addingTimeInterval(2)
        while !observer.isSettled(), Date() < settleDeadline {
          if let error = observer.state().2 { throw DriverFailure(error) }
          try await Task.sleep(for: .milliseconds(30))
        }
        var capture = try observer.screenshot(path: path)
        capture["settled"] = observer.isSettled()
        try emitJSON(capture)
        continue
      }
      if line == "reattach" {
        var restoredWindow: SCWindow?
        let restoreDeadline = Date().addingTimeInterval(8)
        while restoredWindow == nil, Date() < restoreDeadline {
          let fresh = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
          if let running = try? Driver(bundleID: bundleID),
             let candidate = try? running.capturableWindow(in: fresh)
          {
            if abs(candidate.frame.width - target.frame.width) < 2, abs(candidate.frame.height - target.frame.height) < 2 { restoredWindow = candidate }
          }
          if restoredWindow == nil { try await Task.sleep(for: .milliseconds(100)) }
        }
        guard let newWindow = restoredWindow else { throw DriverFailure("Window size changed during recording; restore the initial size") }
        _ = newWindow
        try await refreshSource(allowRelaunch: true)
        try emitJSON(["event": "reattached", "time": timestamp()])
      }
    }
    try await stream.stopCapture()
    let finishDeadline = Date().addingTimeInterval(10)
    while !observer.state().1, Date() < finishDeadline {
      if let error = observer.state().2 { throw DriverFailure(error) }
      try await Task.sleep(for: .milliseconds(20))
    }
    guard observer.state().1 else { throw DriverFailure("Video finalization timed out") }
    // SCRecordingOutput's progress duration can be rounded to whole seconds.
    // Use the finalized MP4 timeline so late chapter/screenshot times stay valid.
    let asset = AVURLAsset(url: URL(fileURLWithPath: path))
    let duration = try await asset.load(.duration).seconds
    try emitJSON(["event": "finished", "duration": duration, "bytes": recording.recordedFileSize])
  }
}
