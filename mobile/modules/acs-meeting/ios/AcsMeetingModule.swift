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
      let token = options["token"] as? String ?? ""
      let meetingUrl = options["meetingUrl"] as? String ?? ""
      let whepUrl = options["whepUrl"] as? String ?? ""
      let displayName = options["displayName"] as? String
      let dumpWav = options["dumpPcmWav"] as? Bool ?? false
      let audioSource = options["audioSource"] as? String ?? "glasses"
      let meeting = self.session ?? AcsMeetingSession(
        onState: { [weak self] state in self?.sendEvent("onState", state) },
        onIncomingPcm: { [weak self] base64, rate, channels in
          self?.sendEvent("onIncomingPcm", ["base64": base64, "sampleRate": rate, "channels": channels])
        }
      )
      self.session = meeting
      try meeting.join(token: token, meetingUrl: meetingUrl, whepUrl: whepUrl, displayName: displayName, dumpWav: dumpWav, audioSource: audioSource)
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

final class AcsMeetingSession {
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
  private var outgoingReady = false
  private var audioSource = "glasses"
  private var lastSafety: AudioSafety = .degraded

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
    ]
    if let meetingUrl { result["meetingUrl"] = meetingUrl }
    if let lastError { result["error"] = lastError }
    return result
  }

  func join(token: String, meetingUrl: String, whepUrl: String, displayName: String?, dumpWav: Bool, audioSource: String = "glasses") throws {
    let parsed = AcsAudioPolicy.parseSource(audioSource)
    if parsed == nil {
      NSLog("ACS-SPIKE unknown audioSource=\(audioSource), arming glasses (no local mic)")
    }
    self.audioSource = parsed == .phone ? "phone" : "glasses"
    queue.async { [weak self] in
      guard let self else { return }
      do {
        self.leaveLocked()
        self.audioSource = parsed == .phone ? "phone" : "glasses"
        self.meetingUrl = meetingUrl
        self.lastError = nil
        self.emit("connecting")
        let credential = try CommunicationTokenCredential(token: token)
        let client = CallClient()
        self.callClient = client
        let options = CallAgentOptions()
        options.displayName = displayName ?? "Mentra Call"
        let agent = try client.createCallAgent(userCredential: credential, options: options).get()
        self.callAgent = agent

        let videoFormat = VideoStreamFormat()
        videoFormat.pixelFormat = .nv12
        videoFormat.width = 1280
        videoFormat.height = 720
        videoFormat.framesPerSecond = 15
        let videoOptions = RawOutgoingVideoStreamOptions()
        videoOptions.formats = [videoFormat]
        let videoStream = VirtualOutgoingVideoStream(videoStreamOptions: videoOptions)
        self.frameSender.attach(videoStream)

        let audioFormat = AudioStreamFormat()
        audioFormat.sampleRate = .sampleRate16000
        audioFormat.channelMode = .channelModeMono
        audioFormat.encodedAudioFormat = .pcm

        let outAudioOptions = RawOutgoingAudioStreamOptions()
        outAudioOptions.format = audioFormat
        let outgoing = RawOutgoingAudioStream(audioStreamOptions: outAudioOptions)
        outgoing.delegate = self
        self.audioOut = outgoing

        let local = LocalOutgoingAudioStream()
        self.localOut = local

        let inAudioOptions = RawIncomingAudioStreamOptions()
        inAudioOptions.format = audioFormat
        let incoming = RawIncomingAudioStream(audioStreamOptions: inAudioOptions)
        incoming.delegate = self

        let desired: AudioSourceKind = self.audioSource == "phone" ? .phone : .glasses
        let plan = AcsAudioPolicy.planJoin(
          desired: desired,
          userMuted: self.muted,
          glassesRequiresUnmutedTransport: Self.glassesRequiresUnmutedTransport
        )

        let joinOptions = JoinCallOptions()
        let outgoingVideo = OutgoingVideoOptions()
        outgoingVideo.streams = [videoStream]
        joinOptions.outgoingVideoOptions = outgoingVideo
        let outgoingAudio = OutgoingAudioOptions()
        outgoingAudio.stream = plan.armVirtual ? outgoing : local
        outgoingAudio.muted = plan.transportMuted
        joinOptions.outgoingAudioOptions = outgoingAudio
        let incomingAudio = IncomingAudioOptions()
        incomingAudio.stream = incoming
        incomingAudio.muted = true
        joinOptions.incomingAudioOptions = incomingAudio

        let locator = TeamsMeetingLinkLocator(meetingLink: meetingUrl)
        let call = try agent.join(with: locator, joinCallOptions: joinOptions)
        self.call = call
        call.delegate = self

        let bridge = PcmBridge(dumpWav: dumpWav)
        self.pcmBridge = bridge
        let source = WhepVideoSource()
        source.onFrame = { buffer in self.frameSender.send(buffer) }
        source.onPcm = { pcm, rate, channels in
          self.feedOutgoingPcm(pcm, sampleRate: rate, channels: channels)
        }
        source.start(config: SourceConfig(url: whepUrl))
        self.whep = source
        self.applyAudioPolicyOnQueue("join")
        NSLog("ACS-SPIKE iOS ACS join started source=\(self.audioSource) armVirtual=\(plan.armVirtual) transportMuted=\(plan.transportMuted)")
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
    queue.async { self.whep?.restart(config: SourceConfig(url: whepUrl)) }
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
    guard !muted, audioSource == "glasses", outgoingReady, let stream = audioOut else { return }
    for frame in pcmBridge?.ingest(pcm16Le: pcm, sampleRate: sampleRate, channels: channels) ?? [] {
      do {
        let buffer = RawAudioBuffer()
        buffer.data = frame
        try stream.send(buffer)
      } catch {
        NSLog("ACS-SPIKE sendRawAudioBuffer failed: \(error)")
        break
      }
    }
  }

  private func emit(_ next: String) {
    phase = next
    onState(snapshot())
  }

  private func leaveLocked(emitIdle: Bool = true) {
    applier.reset()
    scheduler.cancelPending()
    pcmBridge?.finishDump()
    whep?.stop()
    frameSender.detach()
    do {
      try call?.hangUp().get()
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
    if emitIdle { emit("idle") }
  }

  fileprivate func currentCall() -> Call? { call }
  fileprivate func currentWhep() -> WhepVideoSource? { whep }
}

final class SessionAudioController: AudioStreamController {
  private weak var session: AcsMeetingSession?

  init(session: AcsMeetingSession) {
    self.session = session
  }

  func readActive() -> ActiveStreamKind {
    guard let stream = session?.currentCall()?.activeOutgoingAudioStream else { return .none }
    let started = String(describing: stream.state).localizedCaseInsensitiveContains("started")
    guard started else { return .none }
    let type = String(describing: stream.type).lowercased()
    if type.contains("virtual") { return .virtual }
    if type.contains("local") { return .local }
    return .none
  }

  func isPhysicallyMuted() -> Bool? {
    session?.currentCall()?.isMuted
  }

  func setGlassesPcmEnabled(_ enabled: Bool) {
    session?.currentWhep()?.setPcmDeliveryEnabled(enabled)
  }

  func mutePhysical() -> Result<Void, Error> {
    switch CallGuard.require(session?.currentCall()) {
    case .failure(let error): return .failure(error)
    case .success(let call):
      do {
        try call.mute().get()
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
        try call.unmute().get()
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
      guard let stream = call.activeOutgoingAudioStream else {
        return .failure(CallMissingError())
      }
      do {
        try call.stopAudio(stream: stream).get()
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

  func call(_ call: Call, didChangeMuteState args: PropertyChangedEventArgs) {
    applyAudioPolicy("outgoing-audio-state")
  }
}

extension AcsMeetingSession: RawOutgoingAudioStreamDelegate {
  func rawOutgoingAudioStream(_ rawOutgoingAudioStream: RawOutgoingAudioStream, didChangeState args: AudioStreamStateChangedEventArgs) {
    outgoingReady = String(describing: rawOutgoingAudioStream.state).localizedCaseInsensitiveContains("started")
    NSLog("ACS-SPIKE iOS raw outgoing audio state=\(rawOutgoingAudioStream.state)")
    applyAudioPolicy("virtual-stream-state")
  }
}

extension AcsMeetingSession: RawIncomingAudioStreamDelegate {
  func rawIncomingAudioStream(_ rawIncomingAudioStream: RawIncomingAudioStream, didReceiveRawAudioBuffer args: IncomingAudioStreamRawBufferReceivedEventArgs) {
    guard let data = args.audioBuffer?.data else { return }
    onIncomingPcm(data.base64EncodedString(), 16000, 1)
  }
}
