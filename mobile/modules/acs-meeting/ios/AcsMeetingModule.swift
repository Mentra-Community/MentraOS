import AVFoundation
import AzureCommunicationCalling
import AzureCommunicationCommon
import ExpoModulesCore
import Foundation

public class AcsMeetingModule: Module {
  private var session: AcsMeetingSession?

  public func definition() -> ModuleDefinition {
    Name("MentraAcsMeeting")
    Events("onState", "onIncomingPcm")

    AsyncFunction("join") { (options: [String: Any]) in
      let token = try requireString(options, "token")
      let meetingUrl = try requireString(options, "meetingUrl")
      let whepUrl = try requireString(options, "whepUrl")
      let displayName = options["displayName"] as? String
      let dumpWav = options["dumpPcmWav"] as? Bool ?? false
      let audioSource = options["audioSource"] as? String ?? "glasses"
      let video = try parseAcsOutgoingVideo(options["video"])
      let meeting = self.session ?? AcsMeetingSession(
        onState: { [weak self] state in self?.sendEvent("onState", state) },
        onIncomingPcm: { [weak self] base64, rate, channels in
          self?.sendEvent("onIncomingPcm", ["base64": base64, "sampleRate": rate, "channels": channels])
        }
      )
      self.session = meeting
      try meeting.join(token: token, meetingUrl: meetingUrl, whepUrl: whepUrl, displayName: displayName, dumpWav: dumpWav, audioSource: audioSource, video: video)
      return meeting.snapshot()
    }

    AsyncFunction("leave") {
      self.session?.leave()
    }

    AsyncFunction("setMuted") { (muted: Bool) in
      self.session?.setMuted(muted) ?? ["state": "idle", "muted": muted]
    }

    AsyncFunction("setAudioSource") { (source: String) in
      self.session?.setAudioSource(source) ?? ["state": "idle", "muted": false, "audioSource": source]
    }

    AsyncFunction("updateVideoSource") { (whepUrl: String) in
      self.session?.updateVideoSource(whepUrl)
    }

    AsyncFunction("restartVideoSource") {
      self.session?.restartVideoSource()
    }

    AsyncFunction("getState") {
      self.session?.snapshot() ?? ["state": "idle", "muted": false]
    }

    OnDestroy {
      self.session?.leave()
      self.session = nil
    }
  }
}

final class QueuePolicyScheduler: PolicyScheduler {
  private let queue: DispatchQueue
  private var pending: [DispatchWorkItem] = []

  init(queue: DispatchQueue) {
    self.queue = queue
  }

  func schedule(delayMs: Int, task: @escaping () -> Void) {
    let item = DispatchWorkItem(block: task)
    pending.append(item)
    queue.asyncAfter(deadline: .now() + .milliseconds(delayMs), execute: item)
  }

  func cancelPending() {
    pending.forEach { $0.cancel() }
    pending.removeAll()
  }
}

final class AcsMeetingSession: NSObject {
  private static let glassesRequiresUnmutedTransport = true
  private let onState: ([String: Any]) -> Void
  private let onIncomingPcm: (String, Int, Int) -> Void
  private let queue = DispatchQueue(label: "com.mentra.acsmeeting")
  private lazy var scheduler = QueuePolicyScheduler(queue: queue)
  private lazy var controller = SessionAudioController(session: self)
  private lazy var applier = AudioPolicyApplier(controller: controller, scheduler: scheduler) { NSLog("ACS-SPIKE \($0)") }
  private var phase = "idle"
  private var muted = false
  private var meetingUrl: String?
  private var lastError: String?
  private var callClient: CallClient?
  private var callAgent: CallAgent?
  private var call: Call?
  private var whep: WhepVideoSource?
  private var frameSender = AcsFrameSender()
  private var pcmBridge: PcmBridge?
  private var audioOut: RawOutgoingAudioStream?
  private var localOut: LocalOutgoingAudioStream?
  private let phoneMic = PhoneMicCapturer()
  private var outgoingReady = false
  private var audioSource = "glasses"
  private var lastSafety: AudioSafety = .degraded
  // Health of the glasses WHEP feed, reported alongside the ACS phase so the host
  // can tell "call is up, glasses video is dead" from a healthy call.
  private var mediaSource: SourceState = .idle
  private var mediaRestartAttempts = 0
  private var mediaRestartTask: DispatchWorkItem?
  private static let mediaRestartBaseMs = 1_000
  private static let mediaRestartMaxMs = 10_000

  init(onState: @escaping ([String: Any]) -> Void, onIncomingPcm: @escaping (String, Int, Int) -> Void) {
    self.onState = onState
    self.onIncomingPcm = onIncomingPcm
  }

  func snapshot() -> [String: Any] {
    var result: [String: Any] = [
      "state": phase,
      "muted": muted,
      "provider": "acs-teams",
      "audioSource": audioSource,
      "activeStream": controller.readActive().rawValue,
      "audioSafety": lastSafety.rawValue,
      "mediaSource": mediaSource.rawValue,
    ]
    if let meetingUrl { result["meetingUrl"] = meetingUrl }
    if let lastError { result["error"] = lastError }
    return result
  }

  func join(token: String, meetingUrl: String, whepUrl: String, displayName: String?, dumpWav: Bool, audioSource: String = "glasses", video: AcsOutgoingVideo = .hd) throws {
    // Both glasses and phone feed RawOutgoingAudioStream so ACS never owns the
    // phone audio route. Phone PCM comes from AVAudioEngine; glasses via WHEP.
    let parsed = AcsAudioPolicy.parseSource(audioSource) ?? .glasses
    if parsed == .phone {
      NSLog("ACS-SPIKE audioSource=phone: input tap → virtual outgoing; voice-chat session off")
    }
    self.audioSource = parsed == .phone ? "phone" : "glasses"
    // The ACS work below is queued; reflect the intent synchronously so the
    // resolved snapshot reads "connecting" rather than a stale idle.
    phase = "connecting"
    lastError = nil
    self.meetingUrl = meetingUrl
    queue.async { [weak self] in
      guard let self else { return }
      do {
        self.leaveLocked(emitIdle: false)
        self.audioSource = parsed == .phone ? "phone" : "glasses"
        self.meetingUrl = meetingUrl
        self.lastError = nil
        self.emit("connecting")
        let credential = try CommunicationTokenCredential(token: token)
        let client = CallClient()
        self.callClient = client
        let options = CallAgentOptions()
        options.displayName = displayName ?? "Mentra Call"
        let agent = try CallbackOperation<CallAgent>().wait(onLateSuccess: { $0.dispose() }) { completion in
          client.createCallAgent(userCredential: credential, options: options, completionHandler: completion)
        }
        self.callAgent = agent

        let videoFormat = VideoStreamFormat()
        videoFormat.pixelFormat = .nv12
        videoFormat.width = Int32(video.width)
        videoFormat.height = Int32(video.height)
        videoFormat.framesPerSecond = Float(video.fps)
        let videoOptions = RawOutgoingVideoStreamOptions()
        videoOptions.formats = [videoFormat]
        let videoStream = VirtualOutgoingVideoStream(videoStreamOptions: videoOptions)
        self.frameSender.attach(videoStream)

        let outAudioFormat = RawOutgoingAudioStreamProperties()
        outAudioFormat.sampleRate = .hz48000
        outAudioFormat.channelMode = .mono
        outAudioFormat.format = .pcm16Bit

        let outAudioOptions = RawOutgoingAudioStreamOptions()
        outAudioFormat.bufferDuration = .ms20
        outAudioOptions.properties = outAudioFormat
        let outgoing = RawOutgoingAudioStream(options: outAudioOptions)
        outgoing.events.onStateChanged = { [weak self, weak outgoing] _ in
          guard let self, let outgoing else { return }
          self.queue.async {
            guard self.audioOut === outgoing else { return }
            self.outgoingReady = outgoing.state == .started
            self.applyAudioPolicyOnQueue("virtual-stream-state")
          }
        }
        self.audioOut = outgoing

        let desired: AudioSourceKind = self.audioSource == "phone" ? .phone : .glasses
        let plan = AcsAudioPolicy.planJoin(
          desired: desired,
          userMuted: self.muted,
          glassesRequiresUnmutedTransport: Self.glassesRequiresUnmutedTransport
        )

        // Virtual outgoing stays armed for phone and glasses. A LocalOutgoing
        // stream would make ACS own the phone route and open an echo loop.
        let local: LocalOutgoingAudioStream? = plan.armVirtual ? nil : LocalOutgoingAudioStream()
        self.localOut = local

        let inAudioFormat = RawIncomingAudioStreamProperties()
        inAudioFormat.sampleRate = .hz16000
        inAudioFormat.channelMode = .mono
        inAudioFormat.format = .pcm16Bit
        let inAudioOptions = RawIncomingAudioStreamOptions()
        inAudioOptions.properties = inAudioFormat
        let incoming = RawIncomingAudioStream(options: inAudioOptions)
        incoming.events.onMixedAudioBufferReceived = { [weak self] args in
          guard let pcm = args.audioBuffer.buffer as? AVAudioPCMBuffer,
                let samples = pcm.int16ChannelData else { return }
          let data = Data(bytes: samples[0], count: Int(pcm.frameLength) * Int(pcm.format.channelCount) * 2)
          self?.onIncomingPcm(data.base64EncodedString(), Int(pcm.format.sampleRate), Int(pcm.format.channelCount))
        }

        let joinOptions = JoinCallOptions()
        let outgoingVideo = OutgoingVideoOptions()
        outgoingVideo.streams = [videoStream]
        joinOptions.outgoingVideoOptions = outgoingVideo
        let outgoingAudio = OutgoingAudioOptions()
        outgoingAudio.stream = plan.armVirtual ? outgoing : local!
        outgoingAudio.muted = plan.transportMuted
        joinOptions.outgoingAudioOptions = outgoingAudio
        let incomingAudio = IncomingAudioOptions()
        incomingAudio.stream = incoming
        // Return audio is ours to route (base64 → host → A2DP on the glasses), so
        // the raw incoming stream must actually deliver buffers.
        incomingAudio.muted = false
        joinOptions.incomingAudioOptions = incomingAudio

        let locator = TeamsMeetingLinkLocator(meetingLink: meetingUrl)
        let call = try CallbackOperation<Call>().wait(onLateSuccess: { lateCall in
          lateCall.hangUp(options: nil) { _ in }
        }) { completion in
          agent.join(with: locator, joinCallOptions: joinOptions, completionHandler: completion)
        }
        self.call = call
        call.delegate = self

        let bridge = PcmBridge(dumpWav: dumpWav)
        self.pcmBridge = bridge
        self.phoneMic.onPcm = { [weak self] pcm, rate, channels in
          self?.feedOutgoingPcm(pcm, sampleRate: rate, channels: channels)
        }
        let source = WhepVideoSource()
        source.onFrame = { buffer in self.frameSender.send(buffer) }
        source.onPcm = { pcm, rate, channels in
          self.feedOutgoingPcm(pcm, sampleRate: rate, channels: channels)
        }
        self.mediaRestartAttempts = 0
        source.onStateChange = { [weak self, weak source] state, reason in
          // Fired from WebRTC/URLSession threads; hop to the session queue so it
          // serializes with join/leave/policy like everything else.
          self?.queue.async {
            guard let self, let source, self.whep === source else { return }
            self.onMediaSourceState(state, reason: reason)
          }
        }
        source.start(config: SourceConfig(url: whepUrl))
        self.whep = source
        self.applyAudioPolicyOnQueue("join")
        NSLog("ACS-SPIKE iOS ACS join started source=\(self.audioSource) profile=\(video.width)x\(video.height)@\(video.fps) armVirtual=\(plan.armVirtual) transportMuted=\(plan.transportMuted)")
      } catch {
        let message = error.localizedDescription
        // A step after a successful ACS join (e.g. WHEP start) can throw. Record
        // the failure before teardown: lastError makes the call delegate ignore
        // the hang-up's async disconnected callback, and emitIdle=false keeps the
        // terminal state as error instead of resetting to idle. Either would
        // otherwise let Mentra Call treat the failed join as a clean end.
        self.lastError = message
        self.leaveLocked(emitIdle: false)
        self.emit("error")
      }
    }
  }

  func updateVideoSource(_ whepUrl: String) {
    queue.async {
      // The host has a fresher opinion about where the glasses publish; drop any
      // automatic retry against the old URL.
      self.cancelMediaRestart()
      self.whep?.restart(config: SourceConfig(url: whepUrl))
    }
  }

  /// Rebuild the WHEP subscription on the current URL even when it looks healthy.
  /// The host calls this when the phone changed networks.
  func restartVideoSource() {
    queue.async {
      self.cancelMediaRestart()
      self.whep?.forceRestart()
    }
  }

  private func onMediaSourceState(_ state: SourceState, reason: String) {
    let previous = mediaSource
    mediaSource = state
    if state == .live { mediaRestartAttempts = 0 }
    if state == .failed { scheduleMediaRestart(reason: reason) }
    // start() emits idle then connecting back to back; one snapshot per real change.
    if previous != state, call != nil, phase != "idle" { onState(snapshot()) }
  }

  /// Native owns first-line recovery: nothing above this layer can see ICE fail, and a
  /// Teams call with a frozen last frame looks healthy from every other angle.
  /// Exponential backoff capped at mediaRestartMaxMs, for as long as the call is alive.
  private func scheduleMediaRestart(reason: String) {
    guard call != nil, !["idle", "disconnected", "error"].contains(phase) else { return }
    guard mediaRestartTask == nil else { return }
    let attempt = mediaRestartAttempts
    mediaRestartAttempts += 1
    let delayMs = min(Self.mediaRestartBaseMs << min(attempt, 4), Self.mediaRestartMaxMs)
    NSLog("ACS-SPIKE glasses media source failed (\(reason)); WHEP rebuild #\(attempt + 1) in \(delayMs)ms")
    let task = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.mediaRestartTask = nil
      guard self.call != nil, self.mediaSource == .failed else { return }
      self.whep?.forceRestart()
    }
    mediaRestartTask = task
    queue.asyncAfter(deadline: .now() + .milliseconds(delayMs), execute: task)
  }

  private func cancelMediaRestart() {
    mediaRestartTask?.cancel()
    mediaRestartTask = nil
    mediaRestartAttempts = 0
  }

  func setMuted(_ next: Bool) -> [String: Any] {
    muted = next
    queue.async { self.applyAudioPolicyOnQueue("set-muted") }
    let snap = snapshot()
    onState(snap)
    return snap
  }

  func setAudioSource(_ source: String) -> [String: Any] {
    if AcsAudioPolicy.parseSource(source) == nil {
      NSLog("ACS-SPIKE unknown audioSource=\(source) ignored; source is locked for this call")
    } else {
      NSLog("ACS-SPIKE setAudioSource=\(source) ignored; audio source is locked for this call at \(audioSource)")
    }
    return snapshot()
  }

  func leave() {
    queue.async { self.leaveLocked() }
  }

  fileprivate func applyAudioPolicy(_ reason: String) {
    queue.async { self.applyAudioPolicyOnQueue(reason) }
  }

  private func applyAudioPolicyOnQueue(_ reason: String) {
    let desired: AudioSourceKind = audioSource == "phone" ? .phone : .glasses
    lastSafety = applier.apply(desired: desired, userMuted: muted, reason: reason)
    if lastSafety == .unsafe {
      NSLog("ACS-SPIKE audioSafety=unsafe — mute and stopAudio both failed; unintended mic may be live")
    }
    onState(snapshot())
  }

  private func feedOutgoingPcm(_ pcm: Data, sampleRate: Int, channels: Int) {
    guard !muted, outgoingReady, let stream = audioOut else { return }
    for frame in pcmBridge?.ingest(pcm16Le: pcm, sampleRate: sampleRate, channels: channels) ?? [] {
      guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 48000, channels: 1, interleaved: true),
            let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frame.count / 2)),
            let samples = pcm.int16ChannelData else { continue }
      pcm.frameLength = pcm.frameCapacity
      frame.copyBytes(to: UnsafeMutableRawBufferPointer(start: samples[0], count: frame.count))
      let buffer = RawAudioBuffer()
      buffer.buffer = pcm
      stream.send(buffer: buffer) { error in
        buffer.dispose()
        if let error { NSLog("ACS-SPIKE sendRawAudioBuffer failed: \(error)") }
      }
    }
  }

  private func emit(_ next: String) {
    phase = next
    onState(snapshot())
  }

  private func leaveLocked(emitIdle: Bool = true) {
    phoneMic.setEnabled(false)
    phoneMic.onPcm = nil
    applier.reset()
    scheduler.cancelPending()
    pcmBridge?.finishDump()
    // Detach before stop so the teardown's own idle transition does not emit a
    // snapshot (or schedule a rebuild) for a call that is going away.
    cancelMediaRestart()
    whep?.onStateChange = nil
    mediaSource = .idle
    whep?.stop()
    frameSender.detach()
    do {
      if let call {
        try CallbackOperation<Void>().wait { completion in
          call.hangUp(options: nil) { completion((), $0) }
        }
      }
    } catch {
      NSLog("ACS-SPIKE leave hangUp failed: \(error)")
    }
    // Dispose independently of hang-up: a failed hang-up must not leak the ACS
    // agent, and each join/leave cycle must release the previous agent.
    callAgent?.dispose()
    callAgent = nil
    callClient = nil
    call = nil
    whep = nil
    audioOut = nil
    localOut = nil
    pcmBridge = nil
    outgoingReady = false
    muted = false
    audioSource = "glasses"
    lastSafety = .degraded
    meetingUrl = nil
    // Clearing lastError is scoped to the clean idle reset. A failed join tears down
    // with emitIdle=false and relies on lastError staying set so emit("error") still
    // carries it and the call delegate keeps ignoring late disconnected callbacks.
    if emitIdle {
      lastError = nil
      emit("idle")
    }
  }

  fileprivate func currentCall() -> Call? { call }
  fileprivate func currentWhep() -> WhepVideoSource? { whep }
  fileprivate func setPhonePcmEnabled(_ enabled: Bool) { phoneMic.setEnabled(enabled) }
}

final class SessionAudioController: AudioStreamController {
  private weak var session: AcsMeetingSession?

  init(session: AcsMeetingSession) {
    self.session = session
  }

  func readActive() -> ActiveStreamKind {
    guard let stream = session?.currentCall()?.activeOutgoingAudioStream else { return .none }
    guard stream.state == .started else { return .none }
    switch stream.type {
    case .virtualOutgoing: return .virtual
    case .localOutgoing: return .local
    default: return .none
    }
  }

  func isPhysicallyMuted() -> Bool? {
    session?.currentCall()?.isOutgoingAudioMuted
  }

  func setGlassesPcmEnabled(_ enabled: Bool) {
    session?.currentWhep()?.setPcmDeliveryEnabled(enabled)
  }

  func setPhonePcmEnabled(_ enabled: Bool) {
    session?.setPhonePcmEnabled(enabled)
  }

  func mutePhysical() -> Result<Void, Error> {
    switch CallGuard.require(session?.currentCall()) {
    case .failure(let error): return .failure(error)
    case .success(let call):
      do {
        try CallbackOperation<Void>().wait { completion in
          call.muteOutgoingAudio { completion((), $0) }
        }
        return .success(())
      } catch {
        return .failure(error)
      }
    }
  }

  func unmutePhysical() -> Result<Void, Error> {
    switch CallGuard.require(session?.currentCall()) {
    case .failure(let error): return .failure(error)
    case .success(let call):
      do {
        try CallbackOperation<Void>().wait { completion in
          call.unmuteOutgoingAudio { completion((), $0) }
        }
        return .success(())
      } catch {
        return .failure(error)
      }
    }
  }

  func stopActive() -> Result<Void, Error> {
    switch CallGuard.require(session?.currentCall()) {
    case .failure(let error): return .failure(error)
    case .success(let call):
      let stream = call.activeOutgoingAudioStream
      do {
        try CallbackOperation<Void>().wait { completion in
          call.stopAudio(stream: stream) { completion((), $0) }
        }
        return .success(())
      } catch {
        return .failure(error)
      }
    }
  }
}

extension AcsMeetingSession: CallDelegate {
  func call(_ call: Call, didChangeState args: PropertyChangedEventArgs) {
    // A failed join has already reported a terminal error and torn the call
    // down; ignore any late ACS state callback so it cannot overwrite error.
    if lastError != nil { return }
    switch call.state {
    case .connecting: emit("connecting")
    case .inLobby: emit("lobby")
    case .connected:
      emit("connected")
      applyAudioPolicy("call-connected")
    case .disconnecting, .disconnected: emit("disconnected")
    default: break
    }
  }

  func call(_: Call, didUpdateOutgoingAudioState _: PropertyChangedEventArgs) {
    applyAudioPolicy("outgoing-audio-state")
  }
}

struct AcsOutgoingVideo {
  let width: Int
  let height: Int
  let fps: Int
  let maxBitrateBps: Int

  static let hd = AcsOutgoingVideo(width: 1280, height: 720, fps: 15, maxBitrateBps: 2_500_000)
  static let allowedSizes: Set<String> = ["1280x720", "960x540"]
}

private func requireString(_ options: [String: Any], _ key: String) throws -> String {
  guard let value = options[key] as? String, !value.isEmpty else {
    throw NSError(domain: "MentraAcsMeeting", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(key) is required"])
  }
  return value
}

private func parseAcsOutgoingVideo(_ raw: Any?) throws -> AcsOutgoingVideo {
  guard let raw else { return .hd }
  guard let map = raw as? [String: Any] else {
    throw NSError(domain: "MentraAcsMeeting", code: 1, userInfo: [NSLocalizedDescriptionKey: "video must be an object"])
  }
  guard
    let width = (map["width"] as? NSNumber)?.intValue,
    let height = (map["height"] as? NSNumber)?.intValue,
    let fps = (map["fps"] as? NSNumber)?.intValue,
    let bitrate = (map["maxBitrateBps"] as? NSNumber)?.intValue
  else {
    throw NSError(domain: "MentraAcsMeeting", code: 1, userInfo: [NSLocalizedDescriptionKey: "video requires width, height, fps, and maxBitrateBps"])
  }
  guard AcsOutgoingVideo.allowedSizes.contains("\(width)x\(height)"), fps >= 1, fps <= 30, bitrate > 0 else {
    throw NSError(domain: "MentraAcsMeeting", code: 1, userInfo: [NSLocalizedDescriptionKey: "unsupported ACS video \(width)x\(height)@\(fps)"])
  }
  return AcsOutgoingVideo(width: width, height: height, fps: fps, maxBitrateBps: bitrate)
}
