import CoreVideo
import Foundation
import GlassesMedia
import UIKit

/// Owns one preview subscription on iOS: admission, packing, transport, and the numbers.
///
/// Everything that can grow is bounded here. One frame is admitted at a time, one send is in
/// flight at a time, and the send buffers come from a two-slot rotation rather than a fresh
/// 1.4 MB allocation per frame — otherwise the allocator cost would show up inside the packing
/// measurement and the experiment would be measuring itself.
final class FramePreviewSession {
  enum Source: String {
    case synthetic
    case call
  }

  enum Mode: String {
    case off
    /// Produce the source frame and stop. The baseline that separates "making a 720p picture"
    /// from "getting it to the WebView".
    case generateOnly = "generate_only"
    /// Pack to the wire format and drop it. Isolates the stride copy.
    case packOnly = "pack_only"
    /// Send it; the page validates and acknowledges without drawing.
    case receiveDiscard = "receive_discard"
    /// Send it; the page draws and then acknowledges.
    case render

    var producesFrames: Bool { self != .off }
    var packs: Bool { self == .packOnly || self == .receiveDiscard || self == .render }
    var sends: Bool { self == .receiveDiscard || self == .render }
  }

  private struct SendSlot {
    let buffer: UnsafeMutableRawBufferPointer
    var inUse = false
  }

  private let queue = DispatchQueue(label: "com.mentra.framepreview.session", qos: .userInitiated)
  private let socket = LoopbackFrameSocket()
  private let stats = PreviewStats()
  private let runLog = PreviewRunLog()
  /// The page always configures before starting; this only covers the window before it does.
  /// 30 matches the panel's default so a run that somehow skips configure still stresses.
  private var pacer = PreviewPacer(targetFps: 30)
  private var runId = ""
  private var runStartedAtNs: Int64 = 0

  private var source: Source = .synthetic
  private var mode: Mode = .off
  private var targetFps = 30
  private var width = 1280
  private var height = 720
  private var consumerDelayMs = 0
  /// Synthetic grain. A control rather than a constant so a run can be compared against the
  /// same picture with grain off — which is the only way to tell content-dependent cost (a
  /// transport quietly compressing) apart from run-to-run variance.
  private var noiseAmplitude = PreviewTestPattern.defaultNoiseAmplitude

  private var timer: DispatchSourceTimer?
  private var synthetic: SyntheticNv12Source?
  private var syntheticIndex = 0
  private var tapGeneration: UInt64?
  private var sendSlots: [SendSlot] = []
  private var slotCapacity = 0
  /// Set when teardown wants to free the send buffers but a send is still in flight over them.
  /// The dealloc is deferred until the last in-use slot is released, so Network framework is
  /// never reading a buffer that has been `deallocate()`'d.
  private var pendingSlotRelease = false
  private var lastSourceFrameAtNs: Int64 = 0
  private var lastFormat: PreviewPixelFormat = .nv12
  private var lastWidth = 0
  private var lastHeight = 0
  private var statusTimer: DispatchSourceTimer?
  /// One frame may be queued for the worker. `DispatchQueue.async` is unbounded, so without
  /// this a slow pack would let retained decoder buffers pile up behind it — the exact runaway
  /// the one-frame credit exists to prevent, reintroduced one closure at a time.
  private let dispatchSlot = DispatchSemaphore(value: 1)
  private let preDispatchLock = NSLock()
  private var preDispatchDrops = 0

  var onStatus: (([String: Any]) -> Void)?
  var onStopped: ((String) -> Void)?

  /// Path of the current run's NDJSON file, surfaced so the panel can tell you where to look.
  var runLogPath: String? { runLog.path }

  init() {
    socket.onAuthenticated = { [weak self] in
      self?.queue.async {
        guard let self else { return }
        self.pacer.setConsumerReady(true)
        NSLog("FRAME-PREVIEW ios credit granted to authenticated consumer")
        self.logEvent("consumer", ["authenticated": true, "generation": Int(self.pacer.generation)])
      }
    }
    socket.onAck = { [weak self] generation, sequence in
      self?.queue.async { self?.handleAck(generation: generation, sequence: sequence) }
    }
    socket.onFailure = { [weak self] failure, detail in
      self?.queue.async {
        guard let self else { return }
        self.stats.onTransportError()
        NSLog("FRAME-PREVIEW ios transport failure=\(failure.rawValue) detail=\(detail)")
        self.logEvent("transport", ["failure": failure.rawValue, "detail": detail])
        if failure == .authFailed || failure == .connectionClosed {
          self.pacer.setConsumerReady(false)
        }
      }
    }
  }

  // MARK: - Lifecycle

  /// Bind the transport for a document and return what the page needs to connect.
  func prepareDocument(token: String, completion: @escaping (Result<[String: Any], Error>) -> Void) {
    queue.async {
      self.pacer.beginGeneration()
      self.logEvent("document", [
        "sessionGen": Int(self.pacer.generation),
        "tokenRotated": true,
      ])
      self.socket.rotateToken(token)
      self.socket.start(token: token) { result in
        switch result {
        case let .success(url):
          // Recorded so the bind address is auditable after the fact. It must always read
          // 127.0.0.1: the listener sets `requiredLocalEndpoint`, and anything else in this
          // field would mean raw camera frames were reachable from the network the phone is
          // attached to — which during a call is the glasses hotspot.
          self.logEvent("listener", ["url": url])
          completion(.success([
            "transport": "websocket",
            "url": url,
            "supported": true,
            "sessionGen": NSNumber(value: self.pacer.generation),
          ]))
        case let .failure(error):
          completion(.failure(error))
        }
      }
    }
  }

  func configure(_ options: [String: Any]) {
    queue.async {
      let previousMode = self.mode
      let previousSource = self.source
      if let raw = options["source"] as? String, let value = Source(rawValue: raw) { self.source = value }
      if let raw = options["mode"] as? String, let value = Mode(rawValue: raw) { self.mode = value }
      if let fps = options["targetFps"] as? NSNumber { self.targetFps = max(1, min(fps.intValue, 30)) }
      if let value = options["width"] as? NSNumber { self.width = value.intValue }
      if let value = options["height"] as? NSNumber { self.height = value.intValue }
      if let value = options["consumerDelayMs"] as? NSNumber { self.consumerDelayMs = value.intValue }
      if let value = options["noiseAmplitude"] as? NSNumber {
        self.noiseAmplitude = max(0, min(value.intValue, 96))
      }
      self.pacer.setTargetFps(self.targetFps, nowNs: Self.nowNs())
      let restarted = self.timer != nil
      if restarted { self.restartProductionLocked() }
      self.logEvent("configure", [
        "sourceFrom": previousSource.rawValue,
        "sourceTo": self.source.rawValue,
        "modeFrom": previousMode.rawValue,
        "modeTo": self.mode.rawValue,
        "targetFps": self.targetFps,
        "consumerDelayMs": self.consumerDelayMs,
        "productionRestarted": restarted,
      ])
    }
  }

  func start() {
    queue.async {
      let now = Self.nowNs()
      self.runId = Self.makeRunId()
      self.runStartedAtNs = now
      self.stats.onRunStart(nowNs: now)
      self.beginRunLogLocked()
      self.pacer.setTargetFps(self.targetFps, nowNs: now)
      self.pacer.start(nowNs: now)
      self.restartProductionLocked()
      self.startStatusTimerLocked()
      NSLog("FRAME-PREVIEW ios start runId=\(self.runId) source=\(self.source.rawValue) mode=\(self.mode.rawValue) fps=\(self.targetFps)")
    }
  }

  func stop(reason: String) {
    queue.async { self.stopLocked(reason: reason) }
  }

  /// Tear down the transport too. Used for unbind, backgrounding, and a new document.
  func teardown(reason: String) {
    queue.async {
      self.stopLocked(reason: reason)
      self.socket.stop()
      self.releaseSlotsIfIdleLocked()
    }
  }

  func resetStats() {
    queue.async { self.stats.reset(nowNs: Self.nowNs()) }
  }

  private func stopLocked(reason: String) {
    guard pacer.isRunning || timer != nil else { return }
    pacer.stop()
    timer?.cancel()
    timer = nil
    statusTimer?.cancel()
    statusTimer = nil
    synthetic = nil
    if let generation = tapGeneration {
      DecodedFrameTap.shared.detach(generation: generation)
      tapGeneration = nil
    }
    NSLog("FRAME-PREVIEW ios stop reason=\(reason)")
    // One last status line before the file closes, so the run's tail is not missing the second
    // that explains why it ended.
    emitStatus()
    runLog.end(reason: reason, summary: [
      "durationMs": runStartedAtNs > 0 ? Double(Self.nowNs() - runStartedAtNs) / 1_000_000.0 : 0,
      "delivered": stats.delivered,
      "sourceFrames": stats.sourceFrames,
    ])
    onStopped?(reason)
  }

  private func restartProductionLocked() {
    timer?.cancel()
    timer = nil
    synthetic = nil
    if let generation = tapGeneration {
      DecodedFrameTap.shared.detach(generation: generation)
      tapGeneration = nil
    }
    guard mode.producesFrames else { return }

    switch source {
    case .synthetic:
      synthetic = SyntheticNv12Source(width: width, height: height, noiseAmplitude: noiseAmplitude)
      let timer = DispatchSource.makeTimerSource(queue: queue)
      // Tick twice per frame period so the pacer, not the timer, owns the schedule.
      //
      // In nanoseconds, not milliseconds, because the tick has to divide the period exactly.
      // Integer milliseconds do not: at 30 fps `1000/30/2` truncates to 16 ms, two ticks make
      // 32 ms against a 33.33 ms period, and the pacer's absolute schedule then lands on the
      // beat between them — delivering a measured 30.0 fps whose gaps alternate 32/48 ms.
      let periodNs = PreviewPacer.period(forFps: max(targetFps, 1))
      let tickNs = max(periodNs / 2, 2_000_000)
      timer.schedule(deadline: .now(), repeating: .nanoseconds(Int(tickNs)), leeway: .nanoseconds(500_000))
      timer.setEventHandler { [weak self] in self?.onSyntheticTick() }
      timer.resume()
      self.timer = timer
    case .call:
      tapGeneration = DecodedFrameTap.shared.attach { [weak self] buffer in
        self?.onSourceFrame(buffer)
      }
    }
  }

  private func startStatusTimerLocked() {
    statusTimer?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + 1, repeating: 1, leeway: .milliseconds(100))
    timer.setEventHandler { [weak self] in self?.emitStatus() }
    timer.resume()
    statusTimer = timer
  }

  // MARK: - Frame path

  private func onSyntheticTick() {
    guard mode.producesFrames, let synthetic else { return }
    let now = Self.nowNs()
    checkAckTimeout(nowNs: now)
    stats.onSourceFrame()
    lastSourceFrameAtNs = now

    switch pacer.admit(nowNs: now) {
    case .skipPacing: return
    case .skipBusy:
      stats.onSkippedBusy()
      return
    case .notRunning:
      return
    case let .admit(sequence):
        stats.onAdmitted()
        syntheticIndex &+= 1
        // Pool exhaustion means the previous frame is still being read. Skipping is the correct
        // answer; overwriting it would tear the picture the consumer is drawing.
        let generateStart = Self.nowNs()
        guard let buffer = synthetic.makeFrame(index: syntheticIndex) else {
          stats.onSkippedBusy()
          pacer.onPacked(sequence: sequence, sent: false, nowNs: now)
          return
        }
        let generated = Self.nowNs()
        // Inventing a 720p picture is the synthetic source's own cost and has nothing to do with
        // moving one. Timed separately, or it would be charged to the pipeline it is only a
        // stand-in for — and `generate_only` would have nothing to subtract.
        stats.generate.record(generated - generateStart)
        process(buffer: buffer, sequence: sequence, timestampNs: now, admittedAtNs: generated)
    }
  }

  /// Called on the decoder thread. Admission only: retain and hand off, never pack here.
  private func onSourceFrame(_ buffer: CVPixelBuffer) {
    let now = Self.nowNs()
    guard dispatchSlot.wait(timeout: .now()) == .success else {
      // The worker is still busy with the previous frame. Counted on the decoder thread, where
      // the session queue is not safe to touch, and folded into the stats at report time.
      preDispatchLock.lock()
      preDispatchDrops += 1
      preDispatchLock.unlock()
      return
    }
    let retained = Unmanaged.passRetained(buffer)
    queue.async { [weak self] in
      guard let self else { retained.release(); return }
      defer { self.dispatchSlot.signal() }
      let pixelBuffer = retained.takeRetainedValue()
      self.checkAckTimeout(nowNs: now)
      self.stats.onSourceFrame()
      self.lastSourceFrameAtNs = now
      switch self.pacer.admit(nowNs: now) {
      case .skipPacing, .notRunning:
        return
      case .skipBusy:
        self.stats.onSkippedBusy()
        return
      case let .admit(sequence):
        self.stats.onAdmitted()
        self.process(buffer: pixelBuffer, sequence: sequence, timestampNs: now, admittedAtNs: now)
      }
    }
  }

  private func process(buffer: CVPixelBuffer, sequence: UInt32, timestampNs: Int64, admittedAtNs: Int64) {
    // Admission happens on the producing thread, packing on this one. The gap is the handoff,
    // and it is measured separately from the pack so a scheduling problem cannot be read as a
    // slow memcpy.
    let packStart = Self.nowNs()
    stats.admitToPack.record(packStart - admittedAtNs)

    guard mode.packs else {
      // generate_only: the source frame existed and that is the whole measurement.
      pacer.onPacked(sequence: sequence, sent: false, nowNs: Self.nowNs())
      return
    }

    guard let packed = pack(buffer: buffer, sequence: sequence, timestampNs: timestampNs) else {
      pacer.onPacked(sequence: sequence, sent: false, nowNs: Self.nowNs())
      return
    }
    stats.pack.record(Self.nowNs() - packStart)

    guard mode.sends else {
      releaseSlot(packed.slot)
      pacer.onPacked(sequence: sequence, sent: false, nowNs: Self.nowNs())
      return
    }

    let sendStart = Self.nowNs()
    let data = Data(bytesNoCopy: packed.buffer.baseAddress!, count: packed.byteCount, deallocator: .none)
    let accepted = socket.send(data) { [weak self] _ in
      self?.queue.async {
        guard let self else { return }
        // `send` returning is not the same as Network framework being finished with the buffer.
        // Timing only the enqueue would report iOS as an order of magnitude faster than Android,
        // where the measured hop is the real one.
        self.stats.sendComplete.record(Self.nowNs() - sendStart)
        self.releaseSlot(packed.slot)
      }
    }
    stats.sendEnqueue.record(Self.nowNs() - sendStart)
    if accepted {
      stats.onDelivered(bytes: packed.byteCount, nowNs: Self.nowNs())
      pacer.onPacked(sequence: sequence, sent: true, nowNs: Self.nowNs())
    } else {
      releaseSlot(packed.slot)
      stats.onSkippedBusy()
      pacer.onPacked(sequence: sequence, sent: false, nowNs: Self.nowNs())
    }
  }

  private struct PackedFrame {
    let slot: Int
    let buffer: UnsafeMutableRawBufferPointer
    let byteCount: Int
  }

  private func pack(buffer: CVPixelBuffer, sequence: UInt32, timestampNs: Int64) -> PackedFrame? {
    let formatType = CVPixelBufferGetPixelFormatType(buffer)
    let format: PreviewPixelFormat
    var fullRange = false
    switch formatType {
    case kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange:
      format = .nv12
    case kCVPixelFormatType_420YpCbCr8BiPlanarFullRange:
      format = .nv12
      fullRange = true
    case kCVPixelFormatType_420YpCbCr8Planar:
      format = .i420
    case kCVPixelFormatType_420YpCbCr8PlanarFullRange:
      format = .i420
      fullRange = true
    default:
      // Never reinterpret an unknown layout as NV12: that renders as convincing garbage rather
      // than an obvious failure, and it would be the wrong answer to report.
      stats.onUnsupportedFormat()
      NSLog("FRAME-PREVIEW ios unsupported pixel format \(formatType)")
      return nil
    }

    let frameWidth = CVPixelBufferGetWidth(buffer)
    let frameHeight = CVPixelBufferGetHeight(buffer)
    let payloadLength = format.packedSize(width: frameWidth, height: frameHeight)
    let total = PreviewFrameHeader.byteCount + payloadLength
    guard let slot = acquireSlot(byteCount: total) else {
      // `slotStarved` is a sub-reason of `skippedBusy`, not a second skip: do not add them.
      stats.onSkippedBusy()
      stats.onSlotStarved()
      return nil
    }

    var matrix = PreviewColorMatrix.unknown
    var flags = PreviewFrameFlags()
    // Conditional cast: the attachment is a CFString in practice but the API returns CFTypeRef,
    // and a force cast here would turn a metadata oddity into a crash inside a live call.
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

    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    var packedBytes = 0
    if format == .nv12 {
      if let luma = CVPixelBufferGetBaseAddressOfPlane(buffer, 0),
         let chroma = CVPixelBufferGetBaseAddressOfPlane(buffer, 1) {
        packedBytes = PixelPack.packNV12(
          y: luma, strideY: CVPixelBufferGetBytesPerRowOfPlane(buffer, 0),
          uv: chroma, strideUV: CVPixelBufferGetBytesPerRowOfPlane(buffer, 1),
          width: frameWidth, height: frameHeight,
          into: sendSlots[slot].buffer, at: PreviewFrameHeader.byteCount
        )
      }
    } else {
      if let y = CVPixelBufferGetBaseAddressOfPlane(buffer, 0),
         let u = CVPixelBufferGetBaseAddressOfPlane(buffer, 1),
         let v = CVPixelBufferGetBaseAddressOfPlane(buffer, 2) {
        packedBytes = PixelPack.packI420(
          y: y, strideY: CVPixelBufferGetBytesPerRowOfPlane(buffer, 0),
          u: u, strideU: CVPixelBufferGetBytesPerRowOfPlane(buffer, 1),
          v: v, strideV: CVPixelBufferGetBytesPerRowOfPlane(buffer, 2),
          width: frameWidth, height: frameHeight,
          into: sendSlots[slot].buffer, at: PreviewFrameHeader.byteCount
        )
      }
    }
    CVPixelBufferUnlockBaseAddress(buffer, .readOnly)

    guard packedBytes == payloadLength else {
      stats.onPackFailure()
      releaseSlot(slot)
      return nil
    }

    lastFormat = format
    lastWidth = frameWidth
    lastHeight = frameHeight

    let header = PreviewFrameHeader(
      payloadLength: UInt32(payloadLength),
      sessionGeneration: pacer.generation,
      frameSequence: sequence,
      width: UInt16(frameWidth),
      height: UInt16(frameHeight),
      pixelFormat: format,
      rotation: 0,
      colorMatrix: matrix,
      colorRange: fullRange ? .full : .limited,
      flags: flags,
      timestampNs: timestampNs,
      sentAtNs: Self.nowNs()
    )
    header.write(into: sendSlots[slot].buffer)
    return PackedFrame(slot: slot, buffer: sendSlots[slot].buffer, byteCount: total)
  }

  private func handleAck(generation: UInt32, sequence: UInt32) {
    let now = Self.nowNs()
    switch pacer.onAck(generation: generation, sequence: sequence, nowNs: now) {
    case let .accepted(roundTripNs):
      stats.onAckAccepted(roundTripNs: roundTripNs, nowNs: now)
    case .stale:
      stats.onStaleAck()
      logEvent("staleAck", ["gen": Int(generation), "seq": Int(sequence)])
    }
  }

  private func checkAckTimeout(nowNs: Int64) {
    guard pacer.hasAckTimedOut(nowNs: nowNs) else { return }
    stats.onAckTimeout()
    logEvent("ackTimeout", ["generation": Int(pacer.generation), "outstanding": pacer.outstandingFrames])
    // The consumer stopped answering. Stop the subscription rather than mint a replacement
    // credit, which would be how an unbounded queue gets built one "recovery" at a time.
    stopLocked(reason: "ack_timeout")
  }

  // MARK: - Send buffers

  private func acquireSlot(byteCount: Int) -> Int? {
    // Acquiring a slot means a run is live again, so a teardown that only got deferred (buffers
    // still in flight) is superseded: the buffers stay in the active pool rather than being
    // freed when the old in-flight send finally completes.
    pendingSlotRelease = false
    if slotCapacity != byteCount {
      // A resolution change must not free a buffer the transport is still reading from. Wait
      // for the in-flight send to complete rather than reallocating under it.
      guard !sendSlots.contains(where: { $0.inUse }) else { return nil }
      releaseSlotsLocked()
      slotCapacity = byteCount
      sendSlots = (0 ..< 2).map { _ in
        SendSlot(buffer: UnsafeMutableRawBufferPointer.allocate(byteCount: byteCount, alignment: 16))
      }
    }
    for index in sendSlots.indices where !sendSlots[index].inUse {
      sendSlots[index].inUse = true
      return index
    }
    return nil
  }

  private func releaseSlot(_ index: Int) {
    guard sendSlots.indices.contains(index) else { return }
    sendSlots[index].inUse = false
    // If teardown deferred the dealloc because this send was in flight, the buffers are safe to
    // free now that the last slot is idle.
    if pendingSlotRelease, !sendSlots.contains(where: { $0.inUse }) {
      releaseSlotsLocked()
    }
  }

  /// Free the send buffers, but only once no send is still reading from them. `socket.stop()`
  /// only async-hops to the socket queue and does not wait for the in-flight `connection.send`
  /// to finish; the frame `Data` is `bytesNoCopy`/`deallocator: .none` over these buffers, so
  /// freeing them while a send is in flight is a use-after-free. This mirrors the identical
  /// guard in `acquireSlot`; the deferred dealloc fires from `releaseSlot` when the send's
  /// completion runs.
  private func releaseSlotsIfIdleLocked() {
    guard !sendSlots.contains(where: { $0.inUse }) else {
      pendingSlotRelease = true
      return
    }
    releaseSlotsLocked()
  }

  private func releaseSlotsLocked() {
    for slot in sendSlots { slot.buffer.deallocate() }
    sendSlots = []
    slotCapacity = 0
    pendingSlotRelease = false
  }

  // MARK: - Status

  private func emitStatus() {
    let now = Self.nowNs()
    let window = stats.takeWindow(nowNs: now)
    preDispatchLock.lock()
    let dropped = preDispatchDrops
    preDispatchDrops = 0
    preDispatchLock.unlock()
    for _ in 0 ..< dropped {
      // The frame really did arrive from the decoder, so it counts as a source frame. It was
      // refused before the worker, which is its own reason and not the consumer being slow.
      stats.onSourceFrame()
      stats.onPreDispatchDrop()
    }
    let tap = DecodedFrameTap.shared.drainMetrics()
    // One sort per ring, not one per percentile: at 30 fps this runs on the same queue that
    // packs frames, and the reporter must not become part of what it reports.
    let generate = stats.generate.distribution()
    let pack = stats.pack.distribution()
    let enqueue = stats.sendEnqueue.distribution()
    let complete = stats.sendComplete.distribution()
    let handoff = stats.admitToPack.distribution()
    let gap = stats.deliveryGap.distribution()
    let rtt = stats.roundTrip.distribution()
    let hasSource = source == .synthetic
      || (lastSourceFrameAtNs > 0 && now - lastSourceFrameAtNs < 2_000_000_000)
    let status: [String: Any] = [
      "t": "status",
      "platform": "ios",
      "runId": runId,
      "running": pacer.isRunning,
      "source": source.rawValue,
      "mode": mode.rawValue,
      "targetFps": targetFps,
      "width": lastWidth,
      "height": lastHeight,
      "pixelFormat": lastFormat == .nv12 ? "nv12" : "i420",
      "sourceFrames": stats.sourceFrames,
      "admitted": stats.admitted,
      "skippedPacing": stats.skippedPacing,
      "skippedBusy": stats.skippedBusy,
      "preDispatchDrops": stats.preDispatchDrops,
      "slotStarved": stats.slotStarved,
      "delivered": stats.delivered,
      "sourceFps": round(window.sourceFps * 10) / 10,
      "deliveredFps": round(window.deliveredFps * 10) / 10,
      "bytesPerSecond": Int(window.bytesPerSecond),
      "generateMsP50": generate.p50,
      "generateMsP95": generate.p95,
      "generateMsMax": generate.max,
      "packMsP50": pack.p50,
      "packMsP95": pack.p95,
      "packMsP99": pack.p99,
      "packMsMax": pack.max,
      // Two different questions on iOS: how long until we could move on, and how long until the
      // transport was actually finished with the buffer. Android has only the second.
      "sendEnqueueMsP50": enqueue.p50,
      "sendEnqueueMsP95": enqueue.p95,
      "sendCompleteMsP50": complete.p50,
      "sendCompleteMsP95": complete.p95,
      "sendCompleteMsMax": complete.max,
      "admitToPackMsP95": handoff.p95,
      "admitToPackMsMax": handoff.max,
      // Cadence, not rate. A steady 29.5 fps and an alternating 20/45 ms 29.5 fps are the same
      // number above and very different to look at.
      "deliveryGapMsP50": gap.p50,
      "deliveryGapMsP95": gap.p95,
      "deliveryGapMsMax": gap.max,
      "firstDeliveredMs": stats.firstDeliveredLatencyMs,
      "firstAckMs": stats.firstAckLatencyMs,
      "rttMsP50": rtt.p50,
      "rttMsP95": rtt.p95,
      "rttMsP99": rtt.p99,
      "rttMsMax": rtt.max,
      // The call's numbers, not the preview's. These are the ones that decide the experiment.
      "tapFramesOffered": tap.framesOffered,
      "tapFramesWithSink": tap.framesWithSink,
      "tapOfferMeanUs": round(tap.offerMeanUs * 100) / 100,
      "tapOfferMaxUs": round(tap.offerMaxUs * 100) / 100,
      "tapCadenceMeanMs": round(tap.cadenceMeanMs * 100) / 100,
      "tapCadenceMaxMs": round(tap.cadenceMaxMs * 100) / 100,
      "thermalState": Self.thermalStateName(),
      "memoryFootprintMb": Self.memoryFootprintMb(),
      "outstanding": pacer.outstandingFrames,
      "ackTimeouts": stats.ackTimeouts,
      "staleAcks": stats.staleAcks,
      "unsupportedFormat": stats.unsupportedFormat,
      "packFailures": stats.packFailures,
      "transportErrors": stats.transportErrors,
      "consumerReady": pacer.consumerReady,
      "noSource": !hasSource,
      "generation": NSNumber(value: pacer.generation),
      "consumerDelayMs": consumerDelayMs,
      "noiseAmplitude": noiseAmplitude,
    ]
    onStatus?(status)
    runLog.write(status)
  }

  // MARK: - Run log

  private func beginRunLogLocked() {
    let directory = FileManager.default
      .urls(for: .applicationSupportDirectory, in: .userDomainMask)
      .first?
      .appendingPathComponent("frame-preview")
    guard let directory else { return }
    let device = UIDevice.current
    runLog.begin(runId: runId, meta: [
      "platform": "ios",
      "schema": Self.runLogSchema,
      "startedAt": ISO8601DateFormatter().string(from: Date()),
      "deviceModel": Self.hardwareModel(),
      "deviceName": device.name,
      "osVersion": device.systemVersion,
      "appVersion": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
      "build": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "",
      "source": source.rawValue,
      "mode": mode.rawValue,
      "targetFps": targetFps,
      "width": width,
      "height": height,
      "consumerDelayMs": consumerDelayMs,
      "transport": "websocket",
    ], directory: directory)
  }

  /// A discrete thing that happened, on the same file as the 1 Hz lines. State changes are what
  /// turn "the numbers got worse at second 40" into "the numbers got worse when the page
  /// reconnected at second 40".
  private func logEvent(_ event: String, _ fields: [String: Any]) {
    var record = fields
    record["t"] = "event"
    record["event"] = event
    record["runId"] = runId
    record["atMs"] = runStartedAtNs > 0 ? Double(Self.nowNs() - runStartedAtNs) / 1_000_000.0 : 0
    runLog.write(record)
  }

  private static let runLogSchema = 1

  private static func makeRunId() -> String {
    let stamp = Int(Date().timeIntervalSince1970)
    let suffix = UUID().uuidString.prefix(8)
    return "ios-\(stamp)-\(suffix)"
  }

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

  /// Physical footprint, the number Xcode's memory gauge shows. Sampled every second so growth
  /// over a soak is a slope rather than two endpoints.
  private static func memoryFootprintMb() -> Double {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let result = withUnsafeMutablePointer(to: &info) { pointer in
      pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { rebound in
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), rebound, &count)
      }
    }
    guard result == KERN_SUCCESS else { return 0 }
    return round(Double(info.phys_footprint) / 1_048_576.0 * 10) / 10
  }

  static func nowNs() -> Int64 {
    Int64(DispatchTime.now().uptimeNanoseconds)
  }
}
