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

final class AcsMeetingSession {
  private let onState: ([String: Any]) -> Void
  private let onIncomingPcm: (String, Int, Int) -> Void
  private let queue = DispatchQueue(label: "com.mentra.acsmeeting")
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
  private var outgoingReady = false
  private var audioSource = "glasses"

  init(onState: @escaping ([String: Any]) -> Void, onIncomingPcm: @escaping (String, Int, Int) -> Void) {
    self.onState = onState
    self.onIncomingPcm = onIncomingPcm
  }

  func snapshot() -> [String: Any] {
    var result: [String: Any] = ["state": phase, "muted": muted, "provider": "acs-teams", "audioSource": audioSource]
    if let meetingUrl { result["meetingUrl"] = meetingUrl }
    if let lastError { result["error"] = lastError }
    return result
  }

  func join(token: String, meetingUrl: String, whepUrl: String, displayName: String?, dumpWav: Bool, audioSource: String = "glasses") throws {
    self.audioSource = audioSource == "phone" ? "phone" : "glasses"
    queue.async { [weak self] in
      guard let self else { return }
      do {
        self.leaveLocked()
        self.meetingUrl = meetingUrl
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

        let inAudioOptions = RawIncomingAudioStreamOptions()
        inAudioOptions.format = audioFormat
        let incoming = RawIncomingAudioStream(audioStreamOptions: inAudioOptions)
        incoming.delegate = self

        let joinOptions = JoinCallOptions()
        let outgoingVideo = OutgoingVideoOptions()
        outgoingVideo.streams = [videoStream]
        joinOptions.outgoingVideoOptions = outgoingVideo
        let outgoingAudio = OutgoingAudioOptions()
        outgoingAudio.stream = outgoing
        outgoingAudio.muted = true
        joinOptions.outgoingAudioOptions = outgoingAudio
        let incomingAudio = IncomingAudioOptions()
        incomingAudio.stream = incoming
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
        source.start(whepUrl: whepUrl)
        self.whep = source
        self.applyAudioPolicyLocked()
        NSLog("ACS-SPIKE iOS ACS join started source=\(self.audioSource)")
      } catch {
        self.lastError = error.localizedDescription
        self.emit("error")
      }
    }
  }

  func updateVideoSource(_ whepUrl: String) {
    queue.async { self.whep?.updateUrl(whepUrl) }
  }

  func setMuted(_ next: Bool) -> [String: Any] {
    muted = next
    queue.async { self.applyAudioPolicyLocked() }
    let snap = snapshot()
    onState(snap)
    return snap
  }

  func setAudioSource(_ source: String) -> [String: Any] {
    audioSource = source == "phone" ? "phone" : "glasses"
    queue.async { self.applyAudioPolicyLocked() }
    let snap = snapshot()
    onState(snap)
    return snap
  }

  private func applyAudioPolicyLocked() {
    let sendGlasses = !muted && audioSource == "glasses"
    let sendPhone = !muted && audioSource == "phone"
    whep?.setPcmEnabled(sendGlasses)
    NSLog("ACS-SPIKE audio policy source=\(audioSource) userMuted=\(muted) glassesPcm=\(sendGlasses) phoneMic=\(sendPhone)")
    if sendPhone {
      try? call?.unmute().get()
    } else {
      try? call?.mute().get()
    }
  }

  func leave() {
    queue.async { self.leaveLocked() }
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

  private func leaveLocked() {
    pcmBridge?.finishDump()
    whep?.stop()
    frameSender.detach()
    try? call?.hangUp().get()
    callAgent = nil
    callClient = nil
    call = nil
    whep = nil
    audioOut = nil
    pcmBridge = nil
    outgoingReady = false
    muted = false
    meetingUrl = nil
    emit("idle")
  }
}

extension AcsMeetingSession: CallDelegate {
  func call(_ call: Call, didChangeState args: PropertyChangedEventArgs) {
    switch call.state {
    case .connecting: emit("connecting")
    case .inLobby: emit("lobby")
    case .connected: emit("connected")
    case .disconnecting, .disconnected: emit("disconnected")
    default: break
    }
  }
}

extension AcsMeetingSession: RawOutgoingAudioStreamDelegate {
  func rawOutgoingAudioStream(_ rawOutgoingAudioStream: RawOutgoingAudioStream, didChangeState args: AudioStreamStateChangedEventArgs) {
    outgoingReady = String(describing: rawOutgoingAudioStream.state).localizedCaseInsensitiveContains("started")
    NSLog("ACS-SPIKE iOS raw outgoing audio state=\(rawOutgoingAudioStream.state)")
  }
}

extension AcsMeetingSession: RawIncomingAudioStreamDelegate {
  func rawIncomingAudioStream(_ rawIncomingAudioStream: RawIncomingAudioStream, didReceiveRawAudioBuffer args: IncomingAudioStreamRawBufferReceivedEventArgs) {
    guard let data = args.audioBuffer?.data else { return }
    onIncomingPcm(data.base64EncodedString(), 16000, 1)
  }
}

