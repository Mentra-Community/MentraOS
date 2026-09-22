import AppKit
import AVFoundation
import CoreImage
import ScreenCaptureKit

final class RecordingObserver: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  private let writer: AVAssetWriter
  private let writerInput: AVAssetWriterInput
  private let pixelAdaptor: AVAssetWriterInputPixelBufferAdaptor
  private let outputWidth: Int
  private let outputHeight: Int
  private var lastWrittenPTS: CMTime?
  private var finishing = false
  private var writtenFrames = 0
  private var encodingPending = false
  private var readinessWaits = 0
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

  init(path: String, width: Int, height: Int) throws {
    outputWidth = width
    outputHeight = height
    writer = try AVAssetWriter(outputURL: URL(fileURLWithPath: path), fileType: .mp4)
    writerInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: width,
      AVVideoHeightKey: height,
      AVVideoCompressionPropertiesKey: [AVVideoAllowFrameReorderingKey: false],
    ])
    writerInput.expectsMediaDataInRealTime = true
    writerInput.mediaTimeScale = 60_000
    pixelAdaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: writerInput,
                                                        sourcePixelBufferAttributes: [
                                                          kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                                                          kCVPixelBufferWidthKey as String: width,
                                                          kCVPixelBufferHeightKey as String: height,
                                                        ])
    super.init()
    guard writer.canAdd(writerInput) else { throw DriverFailure("Cannot add the native video encoder") }
    writer.add(writerInput)
  }

  private func checkWriterFailure() {
    if failure == nil, writer.status == .failed || writer.status == .cancelled {
      failure = "Video encoder failed: \(writer.error.map(String.init(describing:)) ?? "writer cancelled")"
    }
  }

  func state() -> (Bool, Bool, String?, Double?) {
    lock.lock(); defer { lock.unlock() }
    checkWriterFailure()
    return (started, finished, failure, firstPTS)
  }

  func diagnostic() -> String {
    lock.lock(); defer { lock.unlock() }
    let now = CMClockGetTime(CMClockGetHostTimeClock()).seconds
    return "recording started=\(started), written frames=\(writtenFrames), encoder pending=\(encodingPending), readiness waits=\(readinessWaits), writer status=\(writer.status.rawValue), last status=\(frameStatus?.rawValue ?? -1), frame status counts=\(frameCounts), rejected samples=\(rejectedSamples), complete image=\(latestBuffer != nil), callback age=\(now - lastCallbackAt), observation age=\(now - observedAt)"
  }

  func invalidateSource() {
    lock.lock(); defer { lock.unlock() }
    minimumSourcePTS = CMClockGetTime(CMClockGetHostTimeClock()).seconds
    latestBuffer = nil
    observedAt = 0
    frameStatus = nil
  }

  // Called on the same serial queue after stopCapture has drained its callbacks.
  // A single session retains the original SCStream clock across owned relaunches.
  func finish(at stoppedAt: CMTime) {
    lock.lock()
    guard !finishing else { lock.unlock(); return }
    finishing = true
    checkWriterFailure()
    guard failure == nil, writer.status == .writing, started, let lastWrittenPTS,
          stoppedAt.isNumeric, stoppedAt >= lastWrittenPTS else {
      if failure == nil { failure = "Cannot finalize an empty or invalid video timeline" }
      if writer.status == .writing { writer.cancelWriting() }
      lock.unlock()
      return
    }
    // Preserve the real last frame until capture actually stopped, including an
    // unchanged (idle) tail. Source frame PTS are never synthesized or shifted.
    writer.endSession(atSourceTime: stoppedAt)
    writerInput.markAsFinished()
    lock.unlock()
    writer.finishWriting { [self] in
      lock.lock(); defer { lock.unlock() }
      if writer.status == .completed { finished = true }
      else { failure = "Video finalization failed: \(writer.error.map(String.init(describing:)) ?? "unknown encoder failure")" }
    }
  }

  func stream(_: SCStream, didStopWithError error: Error) {
    lock.lock(); failure = "Screen capture stopped: \(error)"; lock.unlock()
  }

  func stream(_: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    accept(sampleBuffer, of: type)
  }

  // The same entry is exercised with generated sample buffers in offline tests.
  func accept(_ sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    lock.lock()
    defer { lock.unlock() }
    lastCallbackAt = CMClockGetTime(CMClockGetHostTimeClock()).seconds
    checkWriterFailure()
    guard failure == nil, !finishing else { return }
    guard type == .screen, sampleBuffer.isValid,
          let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
          let rawStatus = attachments.first?[.status] as? Int,
          let status = SCFrameStatus(rawValue: rawStatus) else { rejectedSamples += 1; return }
    frameCounts[rawStatus, default: 0] += 1
    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    guard pts.isNumeric, pts.seconds.isFinite else { rejectedSamples += 1; return }
    guard pts.seconds >= minimumSourcePTS else { return }
    frameStatus = status
    // Idle means the window server observed an unchanged screen. It confirms
    // liveness without replacing the last complete image with an empty buffer.
    if status == .complete || status == .idle {
      // SCStream PTS uses the host clock. A callback delayed by the encoder
      // must not relabel an old observation as fresh at dequeue time.
      observedAt = pts.seconds
    }
    guard status == .complete else { return }
    guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer),
          CVPixelBufferGetWidth(buffer) == outputWidth,
          CVPixelBufferGetHeight(buffer) == outputHeight,
          CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA else {
      failure = "Screen capture changed the video canvas or pixel format"
      return
    }
    if let lastWrittenPTS, pts <= lastWrittenPTS {
      failure = "Screen capture produced a non-advancing video timestamp"
      return
    }
    if !started {
      guard writer.startWriting() else {
        failure = "Cannot start video writer: \(writer.error.map(String.init(describing:)) ?? "unknown encoder failure")"
        return
      }
      writer.startSession(atSourceTime: pts)
    }
    // The serial capture queue retains this frame during ordinary transient
    // encoder backpressure. Release the state lock so screenshots can fail
    // closed while pending, and never silently drop an observed image.
    encodingPending = true
    if !writerInput.isReadyForMoreMediaData { readinessWaits += 1 }
    lock.unlock()
    let encoderDeadline = CMClockGetTime(CMClockGetHostTimeClock()).seconds + 2
    while !writerInput.isReadyForMoreMediaData, writer.status == .writing,
          CMClockGetTime(CMClockGetHostTimeClock()).seconds < encoderDeadline {
      Thread.sleep(forTimeInterval: 0.005)
    }
    lock.lock()
    encodingPending = false
    checkWriterFailure()
    guard failure == nil, writerInput.isReadyForMoreMediaData,
          pixelAdaptor.append(buffer, withPresentationTime: pts) else {
      if failure == nil { failure = "Video encoder did not accept a captured frame: \(writer.error.map(String.init(describing:)) ?? "encoder remained unavailable for two seconds")" }
      return
    }
    if firstPTS == nil { firstPTS = pts.seconds }
    started = true
    writtenFrames += 1
    lastWrittenPTS = pts
    // Park/reattach may invalidate the source while this older frame waits on
    // encoding. Its original video timestamp is valid; its screenshot is not.
    guard pts.seconds >= minimumSourcePTS else { return }
    latestBuffer = buffer
    latestPTS = pts.seconds
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
        if hash != latestHash { changedAt = pts.seconds; latestHash = hash }
      }
      CVPixelBufferUnlockBaseAddress(buffer, .readOnly)
    }
  }

  func isSettled() -> Bool {
    lock.lock(); defer { lock.unlock() }
    checkWriterFailure()
    let now = CMClockGetTime(CMClockGetHostTimeClock()).seconds
    return failure == nil && !encodingPending && latestBuffer != nil && (frameStatus == .complete || frameStatus == .idle)
      && now - observedAt >= 0 && now - observedAt <= 1 && now - changedAt >= 0.2
  }

  func screenshot(path: String) throws -> [String: Any] {
    lock.lock()
    checkWriterFailure()
    let buffer = latestBuffer
    let time = latestPTS - (firstPTS ?? latestPTS)
    let observationTime = observedAt - (firstPTS ?? observedAt)
    let age = CMClockGetTime(CMClockGetHostTimeClock()).seconds - observedAt
    let error = failure
    let status = frameStatus
    let pending = encodingPending
    lock.unlock()
    if let error { throw DriverFailure(error) }
    guard !pending, age >= 0, age <= 1, status == .complete || status == .idle else {
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
    guard let initialViewport = try frameOf(window())?.size else { throw DriverFailure("The app window has no viewport geometry") }
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
    // Bound retained capture buffers while the serial writer waits for readiness.
    configuration.queueDepth = 6
    configuration.pixelFormat = kCVPixelFormatType_32BGRA
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
    let observer = try RecordingObserver(path: path, width: configuration.width, height: configuration.height)
    let frameQueue = DispatchQueue(label: "mentra.e2e.frames")
    let stream = SCStream(filter: filter, configuration: configuration, delegate: observer)
    try stream.addStreamOutput(observer, type: .screen, sampleHandlerQueue: frameQueue)
    func refreshSource(allowRelaunch: Bool = false) async throws {
      guard !parked || allowRelaunch else { throw DriverFailure("Recording is parked during app relaunch") }
      let fresh = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
      let running = try Driver(bundleID: bundleID)
      guard allowRelaunch || running.app.processIdentifier == currentPID else {
        throw DriverFailure("The app process changed without recording reattachment")
      }
      let window = try running.capturableWindow(in: fresh)
      // Accessibility is also the action runner's viewport authority. The
      // compositor can add a two-point outer border during UIKit relaunch.
      guard let viewport = try frameOf(running.window())?.size,
            abs(viewport.width - initialViewport.width) < 2,
            abs(viewport.height - initialViewport.height) < 2
      else {
        throw DriverFailure("The app viewport changed during recording; restore the initial size")
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
        // Keep the current window-only allowlist until its replacement exists.
        // The disappearing target leaves a blank compositor frame. The native
        // writer keeps the same source clock through reattachment.
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
        var lastObservation = "The app has not exposed a capturable window"
        let restoreDeadline = Date().addingTimeInterval(8)
        while restoredWindow == nil, Date() < restoreDeadline {
          let fresh = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
          do {
            let running = try Driver(bundleID: bundleID)
            let candidate = try running.capturableWindow(in: fresh)
            if let viewport = try frameOf(running.window())?.size,
               abs(viewport.width - initialViewport.width) < 2, abs(viewport.height - initialViewport.height) < 2
            {
              restoredWindow = candidate
            } else {
              lastObservation = "The app viewport differs from \(initialViewport)"
            }
          } catch {
            lastObservation = String(describing: error)
          }
          if restoredWindow == nil { try await Task.sleep(for: .milliseconds(100)) }
        }
        guard restoredWindow != nil else { throw DriverFailure("Recording reattachment timed out: \(lastObservation)") }
        try await refreshSource(allowRelaunch: true)
        try emitJSON(["event": "reattached", "time": timestamp(), "windowID": currentWindowID, "pid": currentPID])
      }
    }
    try await stream.stopCapture()
    let stoppedAt = CMClockGetTime(CMClockGetHostTimeClock())
    await withCheckedContinuation { continuation in
      frameQueue.async {
        observer.finish(at: stoppedAt)
        continuation.resume()
      }
    }
    let finishDeadline = Date().addingTimeInterval(10)
    while !observer.state().1, Date() < finishDeadline {
      if let error = observer.state().2 { throw DriverFailure(error) }
      try await Task.sleep(for: .milliseconds(20))
    }
    guard observer.state().1 else { throw DriverFailure("Video finalization timed out") }
    // Read the actual finalized MP4, not elapsed progress or frame counters.
    let asset = AVURLAsset(url: URL(fileURLWithPath: path))
    let duration = try await asset.load(.duration).seconds
    try emitJSON(["event": "finished", "duration": duration, "bytes": try FileManager.default.attributesOfItem(atPath: path)[.size] as? UInt64 ?? 0])
  }
}
