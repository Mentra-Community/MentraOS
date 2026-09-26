import Foundation

/// The binary channel frames leave on. `LoopbackFrameSocket` on iOS; tests supply a fake.
public protocol PreviewFrameTransport: AnyObject {
  /// Queue the first `byteCount` bytes of `slot`. False when no consumer is authenticated or a
  /// send is already in flight. `completion` may run on any thread, once the transport is
  /// finished reading the slot.
  func send(_ slot: PreviewSlot, byteCount: Int, completion: @escaping (Bool) -> Void) -> Bool

  /// Forget the consumer as if its page had gone away.
  func dropConsumer()
}

/// Call-side metrics from `DecodedFrameTap`, copied so this package does not depend on it.
public struct PreviewTapSnapshot: Sendable {
  public var framesOffered = 0
  public var framesWithSink = 0
  public var offerMeanUs = 0.0
  public var offerMaxUs = 0.0
  public var cadenceMeanMs = 0.0
  public var cadenceMaxMs = 0.0
  public var sinkExceptions = 0
  public var acsFramesSent = 0
  public init() {}
}

/// One preview subscription's frame path, independent of CoreVideo, the WebView and the source.
///
/// Every method must be called on the owner's serial queue. Failure isolation: thrown errors in
/// the pack path are caught here, counted by reason, and turn into a `pack_failed` stop request;
/// geometry is validated before any byte is read, because Swift cannot catch a bad read.
public final class PreviewPipeline {
  public let stats = PreviewStats()
  public let faults = PreviewFaults()
  public let pacer: PreviewPacer
  public let slots = PreviewSlotPool()

  public private(set) var config = PreviewConfig()
  public private(set) var box = PreviewLimits.release.maxBox
  public private(set) var fps = PreviewLimits.release.maxFps
  public private(set) var diagnosticsEnabled = false
  public private(set) var sourceSize = PreviewSize(width: 0, height: 0)
  public private(set) var outputSize = PreviewSize(width: 0, height: 0)
  public private(set) var lastFormat: PreviewPixelFormat = .nv12

  /// Asked to stop the subscription with a contract reason. Delivered through `schedule`.
  public var onStopRequested: ((String) -> Void)?

  private let transport: PreviewFrameTransport
  private let scaler: PreviewPlaneScaler
  private let trace: PreviewTrace
  private let clock: () -> Int64
  private let schedule: (_ delayMs: Int, _ work: @escaping () -> Void) -> Void
  private var stopRequested = false

  public init(
    transport: PreviewFrameTransport,
    trace: PreviewTrace,
    scaler: PreviewPlaneScaler = PreviewScalers.makeDefault(),
    ackTimeoutNs: Int64 = PreviewPacer.defaultAckTimeoutNs,
    clock: @escaping () -> Int64 = { Int64(DispatchTime.now().uptimeNanoseconds) },
    schedule: @escaping (_ delayMs: Int, _ work: @escaping () -> Void) -> Void
  ) {
    self.transport = transport
    self.trace = trace
    self.scaler = scaler
    self.clock = clock
    self.schedule = schedule
    pacer = PreviewPacer(targetFps: PreviewLimits.release.maxFps, ackTimeoutNs: ackTimeoutNs)
  }

  // MARK: - Configuration

  /// Returns true when the current configuration needed diagnostics and must stop.
  @discardableResult
  public func setDiagnosticsEnabled(_ enabled: Bool) -> Bool {
    diagnosticsEnabled = enabled
    guard !enabled else { return false }
    faults.clear()
    let mustStop = PreviewDiagnosticsPolicy.needsDiagnostics(config)
    if mustStop {
      config.source = .call
      config.mode = .off
      config.noiseAmplitude = 0
      config.consumerDelayMs = 0
    }
    box = PreviewScalePlan.clampBox(box, maxPixels: PreviewLimits.release.maxPixels)
    fps = min(fps, PreviewLimits.release.maxFps)
    pacer.setTargetFps(fps, nowNs: clock())
    return mustStop
  }

  public struct ConfigureOutcome: Equatable {
    public let restartProduction: Bool
    public let tierChanged: Bool
  }

  /// Apply one `configure`. A tier or rate change never restarts production; only what produces
  /// frames does. The synthetic source draws at the box size, so it follows the tier.
  public func configure(_ next: PreviewConfig) throws -> ConfigureOutcome {
    if let code = PreviewDiagnosticsPolicy.check(next, diagnosticsEnabled: diagnosticsEnabled) {
      trace.warn("configure_rejected", ["code": code, "source": next.source.rawValue, "mode": next.mode.rawValue])
      throw PreviewRejection(code: code, message: "\(next.source.rawValue)/\(next.mode.rawValue) needs diagnostics")
    }
    let previous = config
    let limits = PreviewLimits.of(diagnosticsEnabled: diagnosticsEnabled)
    let nextBox = next.targetWidth > 0 && next.targetHeight > 0
      ? PreviewScalePlan.clampBox(PreviewSize(width: next.targetWidth, height: next.targetHeight), maxPixels: limits.maxPixels)
      : limits.maxBox
    let tierChanged = nextBox != box
    config = next
    fps = min(max(next.maxFps, 1), limits.maxFps)
    pacer.setTargetFps(fps, nowNs: clock())
    if tierChanged {
      box = nextBox
      stats.onTierChange()
      if sourceSize.width > 0, sourceSize.height > 0 {
        let size = PreviewScalePlan.fit(source: sourceSize, box: nextBox)
        slots.prepare(byteCount: PreviewFrameHeader.byteCount + lastFormat.packedSize(width: size.width, height: size.height))
      }
      trace.info("tier_change", ["box": "\(nextBox.width)x\(nextBox.height)", "fps": fps])
    }
    let restart = pacer.isRunning && (
      previous.source != next.source || previous.mode != next.mode
        || (next.source == .synthetic && (tierChanged || previous.noiseAmplitude != next.noiseAmplitude))
    )
    trace.info("configure", ["source": next.source.rawValue, "mode": next.mode.rawValue, "box": "\(box.width)x\(box.height)", "fps": fps])
    return ConfigureOutcome(restartProduction: restart, tierChanged: tierChanged)
  }

  public func armFault(_ kind: PreviewFaultKind, ms: Int) throws {
    guard diagnosticsEnabled else {
      throw PreviewRejection(code: PreviewDiagnosticsPolicy.diagnosticsDisabled, message: "fault injection needs diagnostics")
    }
    faults.arm(kind, ms: ms)
    trace.warn("fault_armed", ["kind": kind.rawValue, "ms": ms])
  }

  // MARK: - Lifecycle

  /// A new document invalidates every outstanding frame and every credit the old page held.
  @discardableResult
  public func beginDocument() -> UInt32 {
    slots.releaseAll()
    return pacer.beginGeneration()
  }

  public func start() {
    stopRequested = false
    let now = clock()
    pacer.setTargetFps(fps, nowNs: now)
    pacer.start(nowNs: now)
  }

  public func stop() {
    pacer.stop()
    slots.releaseAll()
  }

  // MARK: - Frame path

  /// Admission for one source frame. Also where a silent consumer is noticed.
  public func admit() -> PreviewAdmission {
    let now = clock()
    checkAckTimeout(nowNs: now)
    stats.onSourceFrame()
    let admission = pacer.admit(nowNs: now)
    switch admission {
    case .admit: stats.onAdmitted()
    case .skipPacing: stats.onSkippedPacing()
    case .skipBusy: stats.onSkippedBusy()
    case .notRunning: break
    }
    return admission
  }

  /// Pack, scale and send one admitted frame. Never throws: every failure is counted.
  public func process(_ frame: PreviewSourceFrame, sequence: UInt32, admittedAtNs: Int64) {
    let packStart = clock()
    stats.admitToPack.record(packStart - admittedAtNs)
    guard config.mode.packs else {
      // generate_only: the source frame existed and that is the whole measurement.
      pacer.onPacked(sequence: sequence, sent: false, nowNs: clock())
      return
    }
    do {
      try packAndSend(frame, sequence: sequence, packStart: packStart)
    } catch let reason as PackFailureReason {
      failPack(reason, sequence: sequence, error: nil)
    } catch {
      failPack(.workerError, sequence: sequence, error: error)
    }
  }

  private func packAndSend(_ frame: PreviewSourceFrame, sequence: UInt32, packStart: Int64) throws {
    if faults.takePackThrow() { throw InjectedPreviewFault(kind: .packThrow) }
    let source = PreviewSize(width: frame.width, height: frame.height)
    let output = PreviewScalePlan.fit(source: source, box: box)
    let payloadLength = frame.format.packedSize(width: output.width, height: output.height)
    let total = PreviewFrameHeader.byteCount + payloadLength
    if let reason = PreviewGeometry.validate(frame, output: output, payloadLength: payloadLength) { throw reason }

    guard let slot = slots.acquire(byteCount: total, sequence: sequence) else {
      // `slotStarved` is a sub-reason of `skippedBusy`, not a second skip: do not add them.
      stats.onSkippedBusy()
      stats.onSlotStarved()
      pacer.onPacked(sequence: sequence, sent: false, nowNs: clock())
      return
    }
    var handedToTransport = false
    defer { if !handedToTransport { slots.release(slot) } }
    if let reason = PreviewGeometry.validateSlot(slotBytes: slot.byteCount, frameBytes: total) { throw reason }

    if output == source {
      try packTight(frame, into: slot, payloadLength: payloadLength)
    } else {
      try scale(frame, to: output, into: slot)
    }
    PreviewFrameHeader(
      payloadLength: UInt32(payloadLength),
      sessionGeneration: pacer.generation,
      frameSequence: sequence,
      width: UInt16(output.width),
      height: UInt16(output.height),
      pixelFormat: frame.format,
      rotation: 0,
      colorMatrix: frame.colorMatrix,
      colorRange: frame.colorRange,
      flags: frame.flags,
      timestampNs: frame.timestampNs,
      sentAtNs: clock()
    ).write(into: slot.buffer)
    stats.pack.record(clock() - packStart)
    sourceSize = source
    outputSize = output
    lastFormat = frame.format

    guard config.mode.sends else {
      pacer.onPacked(sequence: sequence, sent: false, nowNs: clock())
      return
    }
    if faults.takeTransportClose() {
      transport.dropConsumer()
      transportFailed(reason: "send_failed", detail: "injected")
      pacer.onPacked(sequence: sequence, sent: false, nowNs: clock())
      return
    }
    let sendStart = clock()
    let accepted = transport.send(slot, byteCount: total) { [weak self] _ in
      self?.schedule(0) {
        guard let self else { return }
        // "send returned" is not "the transport finished with the buffer"; only now is it free.
        self.stats.sendComplete.record(self.clock() - sendStart)
        self.slots.release(slot)
      }
    }
    stats.sendEnqueue.record(clock() - sendStart)
    if accepted {
      handedToTransport = true
      stats.onDelivered(bytes: total, nowNs: clock())
      pacer.onPacked(sequence: sequence, sent: true, nowNs: clock())
    } else {
      stats.onSkippedBusy()
      pacer.onPacked(sequence: sequence, sent: false, nowNs: clock())
    }
  }

  private func packTight(_ frame: PreviewSourceFrame, into slot: PreviewSlot, payloadLength: Int) throws {
    let written: Int
    switch frame.format {
    case .nv12:
      written = PixelPack.packNV12(
        y: frame.luma.base, strideY: frame.luma.stride,
        uv: frame.chroma.base, strideUV: frame.chroma.stride,
        width: frame.width, height: frame.height,
        into: slot.buffer, at: PreviewFrameHeader.byteCount
      )
    case .i420:
      guard let chromaV = frame.chromaV else { throw PackFailureReason.planeOutOfBounds }
      written = PixelPack.packI420(
        y: frame.luma.base, strideY: frame.luma.stride,
        u: frame.chroma.base, strideU: frame.chroma.stride,
        v: chromaV.base, strideV: chromaV.stride,
        width: frame.width, height: frame.height,
        into: slot.buffer, at: PreviewFrameHeader.byteCount
      )
    }
    guard written == payloadLength else { throw PackFailureReason.payloadMismatch }
  }

  private func scale(_ frame: PreviewSourceFrame, to output: PreviewSize, into slot: PreviewSlot) throws {
    guard let base = slot.buffer.baseAddress else { throw PackFailureReason.slotTooSmall }
    let luma = base.advanced(by: PreviewFrameHeader.byteCount)
    let chromaSource = PreviewSize(width: (frame.width + 1) / 2, height: (frame.height + 1) / 2)
    let chromaOut = PreviewSize(width: (output.width + 1) / 2, height: (output.height + 1) / 2)
    try scaler.scalePlanar8(
      source: frame.luma.base, sourceStride: frame.luma.stride,
      sourceWidth: frame.width, sourceHeight: frame.height,
      destination: luma, width: output.width, height: output.height
    )
    let chroma = luma.advanced(by: output.width * output.height)
    switch frame.format {
    case .nv12:
      try scaler.scaleInterleaved16(
        source: frame.chroma.base, sourceStride: frame.chroma.stride,
        sourceWidth: chromaSource.width, sourceHeight: chromaSource.height,
        destination: chroma, width: chromaOut.width, height: chromaOut.height
      )
    case .i420:
      guard let chromaV = frame.chromaV else { throw PackFailureReason.planeOutOfBounds }
      try scaler.scalePlanar8(
        source: frame.chroma.base, sourceStride: frame.chroma.stride,
        sourceWidth: chromaSource.width, sourceHeight: chromaSource.height,
        destination: chroma, width: chromaOut.width, height: chromaOut.height
      )
      try scaler.scalePlanar8(
        source: chromaV.base, sourceStride: chromaV.stride,
        sourceWidth: chromaSource.width, sourceHeight: chromaSource.height,
        destination: chroma.advanced(by: chromaOut.width * chromaOut.height),
        width: chromaOut.width, height: chromaOut.height
      )
    }
  }

  private func failPack(_ reason: PackFailureReason, sequence: UInt32?, error: Error?) {
    stats.onPackFailure(reason)
    if let sequence { pacer.onPacked(sequence: sequence, sent: false, nowNs: clock()) }
    trace.warn("pack_failed", [
      "reason": reason.rawValue,
      "error": error.map { String(describing: type(of: $0)) },
      "src": "\(sourceSize.width)x\(sourceSize.height)",
    ])
    requestStop("pack_failed")
  }

  // MARK: - Consumer and transport

  public func consumerAuthenticated() {
    stats.onHandshake()
    pacer.setConsumerReady(true)
    trace.info("hello_accepted", ["sessionGen": pacer.generation])
  }

  public func ackReceived(generation: UInt32, sequence: UInt32) {
    if faults.dropsAcks {
      trace.warnLimited("ack_dropped", "ack_dropped", ["fault": true])
      return
    }
    let delay = max(config.consumerDelayMs, faults.ackDelayMs)
    guard delay > 0 else {
      handleAck(generation: generation, sequence: sequence)
      return
    }
    schedule(delay) { [weak self] in self?.handleAck(generation: generation, sequence: sequence) }
  }

  private func handleAck(generation: UInt32, sequence: UInt32) {
    let now = clock()
    switch pacer.onAck(generation: generation, sequence: sequence, nowNs: now) {
    case let .accepted(roundTripNs):
      stats.onAckAccepted(roundTripNs: roundTripNs, nowNs: now)
    case .stale:
      stats.onStaleAck()
      trace.warnLimited("stale_ack", "stale_ack", ["ackGen": generation, "seq": sequence])
    }
  }

  /// `auth_failed` is a stale or foreign page and never revokes the current consumer; anything
  /// else means frames can no longer be delivered.
  public func transportFailed(reason: String, detail: String) {
    stats.onTransportError()
    if reason == "auth_failed" {
      trace.warnLimited("hello_rejected", "hello_rejected", ["reason": detail])
      return
    }
    pacer.setConsumerReady(false)
    trace.warn("transport_failed", ["reason": reason, "detail": detail])
    if pacer.isRunning { requestStop("transport_failed") }
  }

  /// The tap caught an error from the sink on the decoder thread; the owner forwards it here.
  public func sinkFailed(_ error: Error) {
    failPack(.sinkError, sequence: nil, error: error)
  }

  public func checkAckTimeout(nowNs: Int64? = nil) {
    guard pacer.hasAckTimedOut(nowNs: nowNs ?? clock()) else { return }
    stats.onAckTimeout()
    trace.warn("ack_timeout", ["sessionGen": pacer.generation, "outstanding": pacer.outstandingFrames])
    // The consumer stopped answering. Stop rather than mint a replacement credit.
    requestStop("ack_timeout")
  }

  private func requestStop(_ reason: String) {
    guard !stopRequested else { return }
    stopRequested = true
    schedule(0) { [weak self] in self?.onStopRequested?(reason) }
  }

  // MARK: - Status

  /// Counters named in the contract, plus the call-side send rate.
  public static let contractCounters = [
    "deliveredFps", "outstanding", "skippedBusy", "skippedPacing", "packMsP95", "rttMsP95",
    "deliveryGapMsP50", "deliveryGapMsP95", "tapOfferMeanUs", "tapCadenceMaxMs", "tapSinkExceptions",
    "packFailures", "staleAcks", "ackTimeouts", "installReloads", "handshakes", "tierChanges",
    "outWidth", "outHeight", "srcWidth", "srcHeight",
  ]

  /// Build the platform-neutral part of one 1 Hz status. `tapSeconds` is the drain interval.
  public func status(tap: PreviewTapSnapshot, tapSeconds: Double) -> [String: Any] {
    let now = clock()
    let window = stats.takeWindow(nowNs: now)
    if tap.sinkExceptions > 0 { stats.onTapSinkExceptions(tap.sinkExceptions) }
    let pack = stats.pack.distribution()
    let rtt = stats.roundTrip.distribution()
    let gap = stats.deliveryGap.distribution()
    let enqueue = stats.sendEnqueue.distribution()
    let complete = stats.sendComplete.distribution()
    let handoff = stats.admitToPack.distribution()
    let generate = stats.generate.distribution()
    return [
      "running": pacer.isRunning,
      "source": config.source.rawValue,
      "mode": config.mode.rawValue,
      "deliveredFps": round1(window.deliveredFps),
      "outstanding": pacer.outstandingFrames,
      "skippedBusy": stats.skippedBusy,
      "skippedPacing": stats.skippedPacing,
      "packMsP95": pack.p95,
      "rttMsP95": rtt.p95,
      "deliveryGapMsP50": gap.p50,
      "deliveryGapMsP95": gap.p95,
      "tapOfferMeanUs": round2(tap.offerMeanUs),
      "tapCadenceMaxMs": round2(tap.cadenceMaxMs),
      "tapSinkExceptions": stats.tapSinkExceptions,
      "packFailures": stats.packFailuresByReason,
      "staleAcks": stats.staleAcks,
      "ackTimeouts": stats.ackTimeouts,
      "installReloads": stats.installReloads,
      "handshakes": stats.handshakes,
      "tierChanges": stats.tierChanges,
      "outWidth": outputSize.width,
      "outHeight": outputSize.height,
      "srcWidth": sourceSize.width,
      "srcHeight": sourceSize.height,
      // The call's own send rate, counted at the ACS send call site.
      "acsSendFps": tapSeconds > 0 ? round1(Double(tap.acsFramesSent) / tapSeconds) : 0,
      "tapFramesOffered": tap.framesOffered,
      "tapFramesWithSink": tap.framesWithSink,
      "tapOfferMaxUs": round2(tap.offerMaxUs),
      "tapCadenceMeanMs": round2(tap.cadenceMeanMs),
      "targetFps": fps,
      "targetWidth": box.width,
      "targetHeight": box.height,
      "pixelFormat": lastFormat == .nv12 ? "nv12" : "i420",
      "sourceFrames": stats.sourceFrames,
      "admitted": stats.admitted,
      "preDispatchDrops": stats.preDispatchDrops,
      "slotStarved": stats.slotStarved,
      "slotReallocations": slots.reallocations,
      "delivered": stats.delivered,
      "sourceFps": round1(window.sourceFps),
      "bytesPerSecond": Int(window.bytesPerSecond),
      "generateMsP95": generate.p95,
      "packMsP50": pack.p50,
      "packMsP99": pack.p99,
      "packMsMax": pack.max,
      "sendEnqueueMsP50": enqueue.p50,
      "sendEnqueueMsP95": enqueue.p95,
      "sendCompleteMsP50": complete.p50,
      "sendCompleteMsP95": complete.p95,
      "sendCompleteMsMax": complete.max,
      "admitToPackMsP95": handoff.p95,
      "admitToPackMsMax": handoff.max,
      "deliveryGapMsMax": gap.max,
      "firstDeliveredMs": stats.firstDeliveredLatencyMs,
      "firstAckMs": stats.firstAckLatencyMs,
      "rttMsP50": rtt.p50,
      "rttMsP99": rtt.p99,
      "rttMsMax": rtt.max,
      "packFailuresTotal": stats.packFailures,
      "unsupportedFormat": stats.unsupportedFormat,
      "transportErrors": stats.transportErrors,
      "consumerReady": pacer.consumerReady,
      "generation": NSNumber(value: pacer.generation),
      "diagnostics": diagnosticsEnabled,
    ]
  }

  private func round1(_ value: Double) -> Double { (value * 10).rounded() / 10 }
  private func round2(_ value: Double) -> Double { (value * 100).rounded() / 100 }
}
