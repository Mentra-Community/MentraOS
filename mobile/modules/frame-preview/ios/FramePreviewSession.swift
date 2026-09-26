import CoreVideo
import Foundation
import GlassesMedia
import UIKit

/// The live call's decoded video, offered by acs-meeting just before each ACS send.
final class CallSource {
  func attach(_ sink: @escaping (CVPixelBuffer) throws -> Void, onSinkError: @escaping (Error) -> Void) -> UInt64 {
    DecodedFrameTap.shared.attach(sink, onSinkError: onSinkError)
  }

  @discardableResult
  func detach(generation: UInt64) -> Bool {
    DecodedFrameTap.shared.detach(generation: generation)
  }

  func isCurrent(generation: UInt64) -> Bool {
    DecodedFrameTap.shared.isCurrent(generation: generation)
  }
}

/// Owns one preview subscription on iOS: the source, the transport, the 1 Hz status and the run
/// log. The frame path itself is `PreviewPipeline`, which is unit tested without CoreVideo.
///
/// Everything below runs on `queue` except the decoder-thread sink, which only retains the
/// buffer and hands it over. One frame may be queued at a time; the rest are refused and counted.
final class FramePreviewSession {
  private let queue = DispatchQueue(label: "com.mentra.framepreview.session", qos: .userInitiated)
  private let socket = LoopbackFrameSocket()
  private let callSource = CallSource()
  private let runLog = PreviewRunLog()
  let trace: PreviewTrace
  private let pipeline: PreviewPipeline

  private var runId = ""
  private var runStartedAtNs: Int64 = 0
  private var runKind: String?
  private var runLogEnabled = false
  private var tapTelemetryEnabled = false
  private var docGen = 0
  private var timer: DispatchSourceTimer?
  private var synthetic: SyntheticNv12Source?
  private var syntheticIndex = 0
  private var tapGeneration: UInt64?
  private var statusTimer: DispatchSourceTimer?
  private var lastSourceFrameAtNs: Int64 = 0
  private var lastTapDrainNs: Int64 = 0
  /// One frame may be queued for the worker. `DispatchQueue.async` is unbounded, so without this
  /// a slow pack would let retained decoder buffers pile up behind it.
  private let dispatchSlot = DispatchSemaphore(value: 1)
  private let preDispatchLock = NSLock()
  private var preDispatchDrops = 0

  var onStatus: (([String: Any]) -> Void)?
  var onStopped: ((String, Int) -> Void)?

  /// Path of the current run's NDJSON file, or nil when the run log is off.
  var runLogPath: String? { runLog.path }

  init(trace: PreviewTrace) {
    self.trace = trace
    pipeline = PreviewPipeline(
      transport: socket,
      trace: trace,
      schedule: { [queue] delayMs, work in
        if delayMs <= 0 {
          queue.async(execute: work)
        } else {
          queue.asyncAfter(deadline: .now() + .milliseconds(delayMs), execute: work)
        }
      }
    )
    pipeline.onStopRequested = { [weak self] reason in self?.stopLocked(reason: reason) }
    socket.onAuthenticated = { [weak self] in
      self?.queue.async { self?.pipeline.consumerAuthenticated() }
    }
    socket.onAck = { [weak self] generation, sequence in
      self?.queue.async { self?.pipeline.ackReceived(generation: generation, sequence: sequence) }
    }
    socket.onFailure = { [weak self] failure, detail in
      self?.queue.async { self?.pipeline.transportFailed(reason: failure.rawValue, detail: detail) }
    }
  }

  // MARK: - Lifecycle

  /// Arm the transport for one document and return what the page needs to connect.
  func prepareDocument(token: String, docGen: Int, completion: @escaping (Result<String, Error>) -> Void) {
    queue.async {
      self.docGen = docGen
      self.trace.docGen = docGen
      let generation = self.pipeline.beginDocument()
      self.socket.rotateToken(token)
      self.trace.info("token_rotated", ["sessionGen": generation])
      self.logEvent("document", ["docGen": docGen, "sessionGen": Int(generation)])
      self.socket.start(token: token) { result in
        if case let .success(url) = result {
          // Must always read 127.0.0.1: anything else would put camera frames on the network.
          self.trace.info("transport_bind", ["transport": "websocket", "url": url])
        } else {
          self.trace.warn("transport_bind_failed", ["transport": "websocket"])
        }
        completion(result)
      }
    }
  }

  func configure(_ config: PreviewConfig, completion: @escaping (PreviewRejection?) -> Void) {
    queue.async {
      do {
        let outcome = try self.pipeline.configure(config)
        if outcome.restartProduction { self.restartProductionLocked() }
        self.logEvent("configure", [
          "sourceTo": config.source.rawValue,
          "modeTo": config.mode.rawValue,
          "targetWidth": self.pipeline.box.width,
          "targetHeight": self.pipeline.box.height,
          "maxFps": self.pipeline.fps,
          "productionRestarted": outcome.restartProduction,
        ])
        completion(nil)
      } catch let rejection as PreviewRejection {
        completion(rejection)
      } catch {
        completion(PreviewRejection(code: "invalid_argument", message: "\(error)"))
      }
    }
  }

  func start() {
    queue.async {
      guard !self.pipeline.pacer.isRunning else { return }
      if self.runKind != nil { self.endRunLocked(reason: "preview_started") }
      self.beginRunLocked(kind: "preview")
      self.pipeline.start()
      self.restartProductionLocked()
      self.ensureStatusTimerLocked()
      self.trace.info("start", ["source": self.pipeline.config.source.rawValue, "mode": self.pipeline.config.mode.rawValue, "runId": self.runId])
    }
  }

  func stop(reason: String) {
    queue.async { self.stopLocked(reason: reason) }
  }

  /// Tear down the transport too. The page must handshake again.
  func teardown(reason: String) {
    queue.async {
      self.stopLocked(reason: reason)
      self.socket.stop()
      self.trace.info("unbind", ["reason": reason])
    }
  }

  func resetStats() {
    queue.async { self.pipeline.stats.reset(nowNs: Self.nowNs()) }
  }

  func setDiagnosticsEnabled(_ enabled: Bool) {
    queue.async {
      if self.pipeline.setDiagnosticsEnabled(enabled) {
        self.stopLocked(reason: PreviewDiagnosticsPolicy.diagnosticsDisabled)
      }
    }
  }

  func setRunLogEnabled(_ enabled: Bool) {
    queue.async {
      guard self.runLogEnabled != enabled else { return }
      self.runLogEnabled = enabled
      if !enabled { self.runLog.end(reason: "run_log_disabled") }
    }
  }

  func setTapTelemetry(_ enabled: Bool) {
    queue.async {
      guard self.tapTelemetryEnabled != enabled else { return }
      self.tapTelemetryEnabled = enabled
      DecodedFrameTap.shared.setTelemetryEnabled(enabled)
      self.trace.info("tap_telemetry", ["enabled": enabled])
      guard !self.pipeline.pacer.isRunning else { return }
      if enabled {
        self.beginRunLocked(kind: "telemetry")
        self.ensureStatusTimerLocked()
      } else {
        self.endRunLocked(reason: "telemetry_off")
        self.cancelStatusTimerLocked()
      }
    }
  }

  func injectFault(_ kind: PreviewFaultKind, ms: Int, completion: @escaping (PreviewRejection?) -> Void) {
    queue.async {
      do {
        try self.pipeline.armFault(kind, ms: ms)
        completion(nil)
      } catch {
        completion(error as? PreviewRejection ?? PreviewRejection(code: "invalid_argument", message: "\(error)"))
      }
    }
  }

  private func stopLocked(reason: String) {
    guard pipeline.pacer.isRunning || timer != nil || tapGeneration != nil else { return }
    pipeline.stop()
    stopProductionLocked()
    trace.info("stop", ["reason": reason])
    endRunLocked(reason: reason)
    if tapTelemetryEnabled {
      beginRunLocked(kind: "telemetry")
    } else {
      cancelStatusTimerLocked()
    }
    onStopped?(reason, docGen)
  }

  // MARK: - Production

  private func stopProductionLocked() {
    timer?.cancel()
    timer = nil
    synthetic = nil
    if let generation = tapGeneration {
      callSource.detach(generation: generation)
      trace.info("source_detach", ["gen": generation])
    }
    tapGeneration = nil
    trace.tapGeneration = nil
  }

  private func restartProductionLocked() {
    stopProductionLocked()
    let config = pipeline.config
    guard config.mode.producesFrames else { return }
    switch config.source {
    case .synthetic:
      synthetic = SyntheticNv12Source(
        width: pipeline.box.width, height: pipeline.box.height, noiseAmplitude: config.noiseAmplitude
      )
      let timer = DispatchSource.makeTimerSource(queue: queue)
      // Tick twice per frame period so the pacer, not the timer, owns the schedule. In
      // nanoseconds because integer milliseconds do not divide a 30 fps period exactly.
      let tickNs = max(PreviewPacer.period(forFps: max(pipeline.fps, 1)) / 2, 2_000_000)
      timer.schedule(deadline: .now(), repeating: .nanoseconds(Int(tickNs)), leeway: .nanoseconds(500_000))
      timer.setEventHandler { [weak self] in self?.onSyntheticTick() }
      timer.resume()
      self.timer = timer
    case .call:
      let generation = callSource.attach(
        { [weak self] buffer in try self?.onSourceFrame(buffer) },
        onSinkError: { [weak self] error in self?.queue.async { self?.pipeline.sinkFailed(error) } }
      )
      tapGeneration = generation
      trace.tapGeneration = generation
      trace.info("source_attach", ["gen": generation])
    }
  }

  private func onSyntheticTick() {
    guard let synthetic else { return }
    lastSourceFrameAtNs = Self.nowNs()
    guard case let .admit(sequence) = pipeline.admit() else { return }
    syntheticIndex &+= 1
    let generateStart = Self.nowNs()
    guard let buffer = synthetic.makeFrame(index: syntheticIndex) else {
      // Pool exhaustion means the previous frame is still being read; overwriting would tear it.
      pipeline.stats.onSkippedBusy()
      pipeline.pacer.onPacked(sequence: sequence, sent: false, nowNs: Self.nowNs())
      return
    }
    let generated = Self.nowNs()
    pipeline.stats.generate.record(generated - generateStart)
    process(buffer, sequence: sequence, admittedAtNs: generated)
  }

  /// Decoder thread. Retain and hand off, never pack here. Anything thrown is caught by the tap.
  private func onSourceFrame(_ buffer: CVPixelBuffer) throws {
    if pipeline.faults.takeSinkThrow() { throw InjectedPreviewFault(kind: .sinkThrow) }
    let now = Self.nowNs()
    guard dispatchSlot.wait(timeout: .now()) == .success else {
      preDispatchLock.lock()
      preDispatchDrops += 1
      preDispatchLock.unlock()
      return
    }
    let retained = Unmanaged.passRetained(buffer)
    queue.async { [weak self] in
      guard let self else {
        retained.release()
        return
      }
      defer { self.dispatchSlot.signal() }
      let pixelBuffer = retained.takeRetainedValue()
      self.lastSourceFrameAtNs = now
      guard case let .admit(sequence) = self.pipeline.admit() else { return }
      self.process(pixelBuffer, sequence: sequence, admittedAtNs: now)
    }
  }

  private func process(_ buffer: CVPixelBuffer, sequence: UInt32, admittedAtNs: Int64) {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let frame = Self.describe(buffer, timestampNs: admittedAtNs) else {
      // Never reinterpret an unknown layout as NV12: it renders as convincing garbage.
      pipeline.stats.onUnsupportedFormat()
      pipeline.pacer.onPacked(sequence: sequence, sent: false, nowNs: Self.nowNs())
      trace.warnLimited("unsupported_format", "unsupported_format", ["format": CVPixelBufferGetPixelFormatType(buffer)])
      return
    }
    pipeline.process(frame, sequence: sequence, admittedAtNs: admittedAtNs)
  }

  /// Describe a locked pixel buffer's planes. Plane bounds come from CoreVideo's own per-plane
  /// metadata; nil for layouts the wire format cannot carry.
  static func describe(_ buffer: CVPixelBuffer, timestampNs: Int64) -> PreviewSourceFrame? {
    let format: PreviewPixelFormat
    let range: PreviewColorRange
    switch CVPixelBufferGetPixelFormatType(buffer) {
    case kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange: (format, range) = (.nv12, .limited)
    case kCVPixelFormatType_420YpCbCr8BiPlanarFullRange: (format, range) = (.nv12, .full)
    case kCVPixelFormatType_420YpCbCr8Planar: (format, range) = (.i420, .limited)
    case kCVPixelFormatType_420YpCbCr8PlanarFullRange: (format, range) = (.i420, .full)
    default: return nil
    }
    let planeCount = format == .nv12 ? 2 : 3
    guard CVPixelBufferGetPlaneCount(buffer) == planeCount else { return nil }
    func plane(_ index: Int) -> PreviewPlane? {
      guard let base = CVPixelBufferGetBaseAddressOfPlane(buffer, index) else { return nil }
      let stride = CVPixelBufferGetBytesPerRowOfPlane(buffer, index)
      let rows = CVPixelBufferGetHeightOfPlane(buffer, index)
      return PreviewPlane(base: UnsafeRawPointer(base), stride: stride, availableBytes: stride * rows)
    }
    guard let luma = plane(0), let chroma = plane(1) else { return nil }
    let chromaV = planeCount == 3 ? plane(2) : nil
    if planeCount == 3, chromaV == nil { return nil }

    var matrix = PreviewColorMatrix.unknown
    var flags = PreviewFrameFlags()
    // Conditional cast: the attachment is CFTypeRef, and a force cast would turn a metadata
    // oddity into a crash inside a live call.
    if let attachment = CVBufferGetAttachment(buffer, kCVImageBufferYCbCrMatrixKey, nil)?.takeUnretainedValue(),
       let value = attachment as? NSString {
      if CFStringCompare(value as CFString, kCVImageBufferYCbCrMatrix_ITU_R_709_2, []) == .compareEqualTo {
        matrix = .bt709
      } else if CFStringCompare(value as CFString, kCVImageBufferYCbCrMatrix_ITU_R_601_4, []) == .compareEqualTo {
        matrix = .bt601
      }
    }
    if matrix == .unknown {
      // Documented fallback rather than a guess that silently shifts every colour.
      matrix = .bt601
      flags.insert(.colorMetadataFallback)
    }
    return PreviewSourceFrame(
      format: format,
      width: CVPixelBufferGetWidth(buffer),
      height: CVPixelBufferGetHeight(buffer),
      luma: luma, chroma: chroma, chromaV: chromaV,
      colorMatrix: matrix, colorRange: range, flags: flags, timestampNs: timestampNs
    )
  }

  // MARK: - Status and run log

  private func ensureStatusTimerLocked() {
    guard statusTimer == nil else { return }
    lastTapDrainNs = Self.nowNs()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + 1, repeating: 1, leeway: .milliseconds(100))
    timer.setEventHandler { [weak self] in self?.onStatusTick() }
    timer.resume()
    statusTimer = timer
  }

  private func cancelStatusTimerLocked() {
    statusTimer?.cancel()
    statusTimer = nil
  }

  private func onStatusTick() {
    pipeline.checkAckTimeout()
    if pipeline.pacer.isRunning, let generation = tapGeneration, !callSource.isCurrent(generation: generation) {
      trace.warn("source_detached", ["gen": generation])
      stopLocked(reason: "source_detached")
    }
    emitStatusLocked()
    trace.flushLimited()
  }

  @discardableResult
  private func emitStatusLocked() -> [String: Any] {
    let now = Self.nowNs()
    preDispatchLock.lock()
    let dropped = preDispatchDrops
    preDispatchDrops = 0
    preDispatchLock.unlock()
    for _ in 0 ..< dropped {
      // The frame arrived from the decoder, so it counts as a source frame refused before the
      // worker — its own reason, not the consumer being slow.
      pipeline.stats.onSourceFrame()
      pipeline.stats.onPreDispatchDrop()
    }
    let metrics = DecodedFrameTap.shared.drainMetrics()
    var tap = PreviewTapSnapshot()
    tap.framesOffered = metrics.framesOffered
    tap.framesWithSink = metrics.framesWithSink
    tap.offerMeanUs = metrics.offerMeanUs
    tap.offerMaxUs = metrics.offerMaxUs
    tap.cadenceMeanMs = metrics.cadenceMeanMs
    tap.cadenceMaxMs = metrics.cadenceMaxMs
    tap.sinkExceptions = metrics.sinkExceptions
    tap.acsFramesSent = metrics.acsFramesSent
    let tapSeconds = lastTapDrainNs > 0 && now > lastTapDrainNs ? Double(now - lastTapDrainNs) / 1_000_000_000 : 0
    lastTapDrainNs = now

    var status = pipeline.status(tap: tap, tapSeconds: tapSeconds)
    let config = pipeline.config
    status["t"] = "status"
    status["platform"] = "ios"
    status["runId"] = runId
    status["docGen"] = docGen
    status["tapTelemetry"] = tapTelemetryEnabled
    status["noSource"] = !(config.source == .synthetic || (lastSourceFrameAtNs > 0 && now - lastSourceFrameAtNs < 2_000_000_000))
    status["thermalState"] = Self.thermalStateName()
    status["memoryFootprintMb"] = Self.memoryFootprintMb()
    if config.source == .synthetic { status["noiseAmplitude"] = config.noiseAmplitude }
    if config.consumerDelayMs != 0 { status["consumerDelayMs"] = config.consumerDelayMs }
    onStatus?(status)
    if runLogEnabled {
      runLog.write(status)
      trace.info("status", [
        "running": pipeline.pacer.isRunning,
        "deliveredFps": status["deliveredFps"],
        "acsSendFps": status["acsSendFps"],
        "skippedBusy": pipeline.stats.skippedBusy,
        "skippedPacing": pipeline.stats.skippedPacing,
        "packMsP95": status["packMsP95"],
        "rttMsP95": status["rttMsP95"],
        "outstanding": pipeline.pacer.outstandingFrames,
        "packFailures": pipeline.stats.packFailures,
        "ackTimeouts": pipeline.stats.ackTimeouts,
        "tapSinkExceptions": pipeline.stats.tapSinkExceptions,
      ])
    }
    return status
  }

  /// One NDJSON file per run. `preview` runs span start..stop; `telemetry` runs are the
  /// preview-off baseline recorded while tap telemetry is on and nothing is producing.
  private func beginRunLocked(kind: String) {
    runKind = kind
    runId = "ios-\(Int(Date().timeIntervalSince1970))-\(UUID().uuidString.prefix(8))"
    runStartedAtNs = Self.nowNs()
    pipeline.stats.onRunStart(nowNs: runStartedAtNs)
    lastTapDrainNs = runStartedAtNs
    guard runLogEnabled,
          let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
          .appendingPathComponent("frame-preview")
    else { return }
    let device = UIDevice.current
    let config = pipeline.config
    runLog.begin(runId: runId, meta: [
      "platform": "ios",
      "schema": Self.runLogSchema,
      "runKind": kind,
      "previewTraceId": trace.traceId,
      "startedAt": ISO8601DateFormatter().string(from: Date()),
      "deviceModel": Self.hardwareModel(),
      "osVersion": device.systemVersion,
      "appVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
      "build": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "",
      "source": config.source.rawValue,
      "mode": config.mode.rawValue,
      "targetFps": pipeline.fps,
      "targetWidth": pipeline.box.width,
      "targetHeight": pipeline.box.height,
      "tapTelemetry": tapTelemetryEnabled,
      "transport": "websocket",
    ], directory: directory)
  }

  private func endRunLocked(reason: String) {
    guard runKind != nil else { return }
    let status = emitStatusLocked()
    if runLogEnabled {
      var summary = status.filter { Self.endKeys.contains($0.key) }
      summary["durationMs"] = runStartedAtNs > 0 ? Double(Self.nowNs() - runStartedAtNs) / 1_000_000.0 : 0
      summary["delivered"] = pipeline.stats.delivered
      summary["sourceFrames"] = pipeline.stats.sourceFrames
      runLog.end(reason: reason, summary: summary)
    }
    runKind = nil
  }

  private func logEvent(_ event: String, _ fields: [String: Any]) {
    guard runLogEnabled else { return }
    var record = fields
    record["t"] = "event"
    record["event"] = event
    record["runId"] = runId
    record["atMs"] = runStartedAtNs > 0 ? Double(Self.nowNs() - runStartedAtNs) / 1_000_000.0 : 0
    runLog.write(record)
  }

  private static let runLogSchema = 2
  private static let endKeys = Set(PreviewPipeline.contractCounters + ["acsSendFps", "tapFramesOffered"])

  private static func hardwareModel() -> String {
    var info = utsname()
    uname(&info)
    let mirror = Mirror(reflecting: info.machine)
    return mirror.children.reduce(into: "") { result, element in
      guard let value = element.value as? Int8, value != 0 else { return }
      result.append(Character(UnicodeScalar(UInt8(value))))
    }
  }

  private static func thermalStateName() -> String {
    switch ProcessInfo.processInfo.thermalState {
    case .nominal: return "nominal"
    case .fair: return "fair"
    case .serious: return "serious"
    case .critical: return "critical"
    @unknown default: return "unknown"
    }
  }

  /// Physical footprint, the number Xcode's memory gauge shows.
  private static func memoryFootprintMb() -> Double {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let result = withUnsafeMutablePointer(to: &info) { pointer in
      pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), rebound, &count)
      }
    }
    guard result == KERN_SUCCESS else { return 0 }
    return (Double(info.phys_footprint) / 1_048_576.0 * 10).rounded() / 10
  }

  static func nowNs() -> Int64 {
    Int64(DispatchTime.now().uptimeNanoseconds)
  }
}
