import CoreVideo
import Foundation
import GlassesMedia

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
  private var pacer = PreviewPacer(targetFps: 15)

  private var source: Source = .synthetic
  private var mode: Mode = .off
  private var targetFps = 15
  private var width = 1280
  private var height = 720
  private var consumerDelayMs = 0

  private var timer: DispatchSourceTimer?
  private var synthetic: SyntheticNv12Source?
  private var syntheticIndex = 0
  private var tapGeneration: UInt64?
  private var sendSlots: [SendSlot] = []
  private var slotCapacity = 0
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

  init() {
    socket.onAuthenticated = { [weak self] in
      self?.queue.async {
        guard let self else { return }
        self.pacer.setConsumerReady(true)
        NSLog("FRAME-PREVIEW ios credit granted to authenticated consumer")
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
      self.socket.rotateToken(token)
      self.socket.start(token: token) { result in
        switch result {
        case let .success(url):
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
      if let raw = options["source"] as? String, let value = Source(rawValue: raw) { self.source = value }
      if let raw = options["mode"] as? String, let value = Mode(rawValue: raw) { self.mode = value }
      if let fps = options["targetFps"] as? NSNumber { self.targetFps = max(1, min(fps.intValue, 30)) }
      if let value = options["width"] as? NSNumber { self.width = value.intValue }
      if let value = options["height"] as? NSNumber { self.height = value.intValue }
      if let value = options["consumerDelayMs"] as? NSNumber { self.consumerDelayMs = value.intValue }
      self.pacer.setTargetFps(self.targetFps, nowNs: Self.nowNs())
      if self.timer != nil { self.restartProductionLocked() }
    }
  }

  func start() {
    queue.async {
      self.pacer.setTargetFps(self.targetFps, nowNs: Self.nowNs())
      self.pacer.start(nowNs: Self.nowNs())
      self.restartProductionLocked()
      self.startStatusTimerLocked()
      NSLog("FRAME-PREVIEW ios start source=\(self.source.rawValue) mode=\(self.mode.rawValue) fps=\(self.targetFps)")
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
      self.releaseSlotsLocked()
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
      synthetic = SyntheticNv12Source(width: width, height: height)
      let timer = DispatchSource.makeTimerSource(queue: queue)
      // Tick faster than the target so the pacer, not the timer, owns the schedule.
      let interval = Int(1000 / max(targetFps, 1) / 2)
      timer.schedule(deadline: .now(), repeating: .milliseconds(max(interval, 4)), leeway: .milliseconds(2))
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
      guard let buffer = synthetic.makeFrame(index: syntheticIndex) else {
        stats.onSkippedBusy()
        pacer.onPacked(sequence: sequence, sent: false, nowNs: now)
        return
      }
      process(buffer: buffer, sequence: sequence, timestampNs: now)
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
        self.process(buffer: pixelBuffer, sequence: sequence, timestampNs: now)
      }
    }
  }

  private func process(buffer: CVPixelBuffer, sequence: UInt32, timestampNs: Int64) {
    guard mode.packs else {
      // generate_only: the source frame existed and that is the whole measurement.
      pacer.onPacked(sequence: sequence, sent: false, nowNs: Self.nowNs())
      return
    }

    let packStart = Self.nowNs()
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
      self?.queue.async { self?.releaseSlot(packed.slot) }
    }
    stats.send.record(Self.nowNs() - sendStart)
    if accepted {
      stats.onDelivered(bytes: packed.byteCount)
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
      stats.onSkippedBusy()
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
      stats.roundTrip.record(roundTripNs)
    case .stale:
      stats.onStaleAck()
    }
  }

  private func checkAckTimeout(nowNs: Int64) {
    guard pacer.hasAckTimedOut(nowNs: nowNs) else { return }
    stats.onAckTimeout()
    // The consumer stopped answering. Stop the subscription rather than mint a replacement
    // credit, which would be how an unbounded queue gets built one "recovery" at a time.
    stopLocked(reason: "ack_timeout")
  }

  // MARK: - Send buffers

  private func acquireSlot(byteCount: Int) -> Int? {
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
  }

  private func releaseSlotsLocked() {
    for slot in sendSlots { slot.buffer.deallocate() }
    sendSlots = []
    slotCapacity = 0
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
      stats.onSourceFrame()
      stats.onSkippedBusy()
    }
    let hasSource = source == .synthetic
      || (lastSourceFrameAtNs > 0 && now - lastSourceFrameAtNs < 2_000_000_000)
    onStatus?([
      "t": "status",
      "platform": "ios",
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
      "delivered": stats.delivered,
      "sourceFps": round(window.sourceFps * 10) / 10,
      "deliveredFps": round(window.deliveredFps * 10) / 10,
      "bytesPerSecond": Int(window.bytesPerSecond),
      "packMsP50": stats.pack.percentileMs(0.5),
      "packMsP95": stats.pack.percentileMs(0.95),
      "sendMsP50": stats.send.percentileMs(0.5),
      "sendMsP95": stats.send.percentileMs(0.95),
      "rttMsP50": stats.roundTrip.percentileMs(0.5),
      "rttMsP95": stats.roundTrip.percentileMs(0.95),
      "outstanding": pacer.outstandingFrames,
      "ackTimeouts": stats.ackTimeouts,
      "staleAcks": stats.staleAcks,
      "unsupportedFormat": stats.unsupportedFormat,
      "transportErrors": stats.transportErrors,
      "consumerReady": pacer.consumerReady,
      "noSource": !hasSource,
      "generation": NSNumber(value: pacer.generation),
      "consumerDelayMs": consumerDelayMs,
    ])
  }

  static func nowNs() -> Int64 {
    Int64(DispatchTime.now().uptimeNanoseconds)
  }
}
