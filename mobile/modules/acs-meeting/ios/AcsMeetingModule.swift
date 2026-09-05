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
    private var audioIn: RawIncomingAudioStream?
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
    private static let mediaRestartBaseMs = 1000
    private static let mediaRestartMaxMs = 10000
    private var joinGeneration: UInt64 = 0
    private lazy var callDelegateProxy = AcsCallDelegateProxy(
        onStateChange: { [weak self] call in self?.handleCallStateChange(call) },
        onMuteChange: { [weak self] call in self?.handleCallMuteChange(call) }
    )

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
                let generation = self.joinGeneration
                self.audioSource = parsed == .phone ? "phone" : "glasses"
                self.meetingUrl = meetingUrl
                self.lastError = nil
                self.emit("connecting")
                let credential = try CommunicationTokenCredential(token: token)
                let client = CallClient()
                self.callClient = client
                let options = CallAgentOptions()
                options.displayName = displayName ?? "Mentra Call"
                client.createCallAgent(userCredential: credential, options: options) { [weak self, weak client] agent, error in
                    self?.queue.async {
                        guard let self, let client, self.callClient === client, self.joinGeneration == generation else {
                            agent?.dispose()
                            return
                        }
                        if let error {
                            self.failJoinLocked(error, generation: generation)
                            return
                        }
                        guard let agent else {
                            self.failJoinLocked(AcsMeetingError("ACS returned no call agent"), generation: generation)
                            return
                        }
                        do {
                            try self.joinWithAgentLocked(
                                agent,
                                generation: generation,
                                meetingUrl: meetingUrl,
                                whepUrl: whepUrl,
                                dumpWav: dumpWav,
                                video: video
                            )
                        } catch {
                            self.failJoinLocked(error, generation: generation)
                        }
                    }
                }
            } catch {
                self.failJoinLocked(error, generation: self.joinGeneration)
            }
        }
    }

    private func joinWithAgentLocked(
        _ agent: CallAgent,
        generation: UInt64,
        meetingUrl: String,
        whepUrl: String,
        dumpWav: Bool,
        video: AcsOutgoingVideo
    ) throws {
        callAgent = agent

        let videoFormat = VideoStreamFormat()
        videoFormat.pixelFormat = .nv12
        videoFormat.width = Int32(video.width)
        videoFormat.height = Int32(video.height)
        videoFormat.framesPerSecond = Float(video.fps)
        let videoOptions = RawOutgoingVideoStreamOptions()
        videoOptions.formats = [videoFormat]
        let videoStream = VirtualOutgoingVideoStream(videoStreamOptions: videoOptions)
        frameSender.attach(videoStream)

        let outAudioProperties = RawOutgoingAudioStreamProperties()
        outAudioProperties.sampleRate = .hz48000
        outAudioProperties.channelMode = .mono
        outAudioProperties.format = .pcm16Bit
        outAudioProperties.bufferDuration = .ms20
        let outAudioOptions = RawOutgoingAudioStreamOptions()
        outAudioOptions.properties = outAudioProperties
        let outgoing = RawOutgoingAudioStream(options: outAudioOptions)
        outgoing.events.onStateChanged = { [weak self, weak outgoing] _ in
            guard let outgoing else { return }
            self?.handleOutgoingAudioStateChange(outgoing)
        }
        audioOut = outgoing

        let desired: AudioSourceKind = audioSource == "phone" ? .phone : .glasses
        let plan = AcsAudioPolicy.planJoin(
            desired: desired,
            userMuted: muted,
            glassesRequiresUnmutedTransport: Self.glassesRequiresUnmutedTransport
        )

        // Virtual outgoing stays armed for phone and glasses. A LocalOutgoing
        // stream would make ACS own the phone route and open an echo loop.
        let local: LocalOutgoingAudioStream? = plan.armVirtual ? nil : LocalOutgoingAudioStream()
        localOut = local

        let inAudioProperties = RawIncomingAudioStreamProperties()
        inAudioProperties.sampleRate = .hz16000
        inAudioProperties.channelMode = .mono
        inAudioProperties.format = .pcm16Bit
        let inAudioOptions = RawIncomingAudioStreamOptions()
        inAudioOptions.properties = inAudioProperties
        let incoming = RawIncomingAudioStream(options: inAudioOptions)
        incoming.events.onMixedAudioBufferReceived = { [weak self] args in
            self?.handleIncomingAudio(args)
        }
        audioIn = incoming

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
        agent.join(with: locator, joinCallOptions: joinOptions) { [weak self, weak agent] call, error in
            self?.queue.async {
                guard let self, let agent, self.callAgent === agent, self.joinGeneration == generation else {
                    call?.hangUp(options: nil) { _ in }
                    return
                }
                if let error {
                    self.failJoinLocked(error, generation: generation)
                    return
                }
                guard let call else {
                    self.failJoinLocked(AcsMeetingError("ACS returned no call"), generation: generation)
                    return
                }
                self.finishJoinLocked(
                    call,
                    generation: generation,
                    whepUrl: whepUrl,
                    dumpWav: dumpWav,
                    video: video,
                    plan: plan
                )
            }
        }
    }

    private func finishJoinLocked(
        _ call: Call,
        generation: UInt64,
        whepUrl: String,
        dumpWav: Bool,
        video: AcsOutgoingVideo,
        plan: JoinAudioPlan
    ) {
        guard joinGeneration == generation else {
            call.hangUp(options: nil) { _ in }
            return
        }
        self.call = call
        call.delegate = callDelegateProxy

        let bridge = PcmBridge(dumpWav: dumpWav)
        pcmBridge = bridge
        phoneMic.onPcm = { [weak self] pcm, rate, channels in
            self?.feedOutgoingPcm(pcm, sampleRate: rate, channels: channels)
        }
        let source = WhepVideoSource()
        source.onFrame = { [weak self] buffer in self?.frameSender.send(buffer) }
        source.onPcm = { [weak self] pcm, rate, channels in
            self?.feedOutgoingPcm(pcm, sampleRate: rate, channels: channels)
        }
        mediaRestartAttempts = 0
        source.onStateChange = { [weak self, weak source] state, reason in
            // Fired from WebRTC/URLSession threads; hop to the session queue so it
            // serializes with join/leave/policy like everything else.
            self?.queue.async {
                guard let self, let source, self.whep === source else { return }
                self.onMediaSourceState(state, reason: reason)
            }
        }
        source.start(config: SourceConfig(url: whepUrl))
        whep = source
        applyAudioPolicyOnQueue("join")
        NSLog("ACS-SPIKE iOS ACS join started source=\(audioSource) profile=\(video.width)x\(video.height)@\(video.fps) armVirtual=\(plan.armVirtual) transportMuted=\(plan.transportMuted)")
    }

    private func failJoinLocked(_ error: Error, generation: UInt64) {
        guard joinGeneration == generation else { return }
        // Record failure before teardown: lastError makes late call callbacks no-ops,
        // and emitIdle=false preserves the terminal error rather than resetting idle.
        lastError = error.localizedDescription
        leaveLocked(emitIdle: false)
        emit("error")
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
            guard let pcmBuffer = PcmBridge.audioBuffer(pcm16Le: frame, sampleRate: PcmBridge.targetRate, channels: 1) else {
                NSLog("ACS-SPIKE could not create outgoing AVAudioPCMBuffer")
                break
            }
            let buffer = RawAudioBuffer()
            buffer.buffer = pcmBuffer
            stream.send(buffer: buffer) { error in
                if let error {
                    NSLog("ACS-SPIKE sendRawAudioBuffer failed: \(error)")
                }
                buffer.dispose()
            }
        }
    }

    private func emit(_ next: String) {
        phase = next
        onState(snapshot())
    }

    private func leaveLocked(emitIdle: Bool = true) {
        joinGeneration &+= 1
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
        let leavingCall = call
        let leavingAgent = callAgent
        leavingCall?.delegate = nil
        leavingCall?.hangUp(options: nil) { error in
            if let error {
                NSLog("ACS-SPIKE leave hangUp failed: \(error)")
            }
            leavingAgent?.dispose()
        }
        // A join that never produced a call still owns an agent that must be released.
        if leavingCall == nil {
            leavingAgent?.dispose()
        }
        callAgent = nil
        callClient = nil
        call = nil
        whep = nil
        audioOut = nil
        audioIn = nil
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

    fileprivate func currentCall() -> Call? {
        call
    }

    fileprivate func currentWhep() -> WhepVideoSource? {
        whep
    }

    fileprivate func setPhonePcmEnabled(_ enabled: Bool) {
        phoneMic.setEnabled(enabled)
    }

    private func handleCallStateChange(_ changedCall: Call) {
        queue.async {
            guard self.call === changedCall, self.lastError == nil else { return }
            switch changedCall.state {
            case .connecting: self.emit("connecting")
            case .inLobby: self.emit("lobby")
            case .connected:
                self.emit("connected")
                self.applyAudioPolicyOnQueue("call-connected")
            case .disconnecting, .disconnected: self.emit("disconnected")
            default: break
            }
        }
    }

    private func handleOutgoingAudioStateChange(_ stream: RawOutgoingAudioStream) {
        queue.async {
            guard self.audioOut === stream else { return }
            self.outgoingReady = stream.state == .started
            NSLog("ACS-SPIKE iOS raw outgoing audio state=\(stream.state)")
            self.applyAudioPolicyOnQueue("virtual-stream-state")
        }
    }

    private func handleCallMuteChange(_ changedCall: Call) {
        queue.async {
            guard self.call === changedCall, self.lastError == nil else { return }
            self.applyAudioPolicyOnQueue("outgoing-audio-state")
        }
    }

    private func handleIncomingAudio(_ args: IncomingMixedAudioEventArgs) {
        let rawBuffer = args.audioBuffer
        defer { rawBuffer.dispose() }
        guard let pcmBuffer = rawBuffer.buffer as? AVAudioPCMBuffer,
              let data = PcmBridge.pcm16Data(from: pcmBuffer) else { return }
        onIncomingPcm(
            data.base64EncodedString(),
            Int(args.streamProperties.sampleRate.valueInHz),
            Int(args.streamProperties.channelMode.channelCount)
        )
    }
}

final class SessionAudioController: AudioStreamController {
    private weak var session: AcsMeetingSession?

    init(session: AcsMeetingSession) {
        self.session = session
    }

    func readActive() -> ActiveStreamKind {
        guard let call = session?.currentCall() else { return .none }
        let stream = call.activeOutgoingAudioStream
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
        case let .failure(error): return .failure(error)
        case let .success(call):
            return waitForAcsOperation { completion in
                call.muteOutgoingAudio(completionHandler: completion)
            }
        }
    }

    func unmutePhysical() -> Result<Void, Error> {
        switch CallGuard.require(session?.currentCall()) {
        case let .failure(error): return .failure(error)
        case let .success(call):
            return waitForAcsOperation { completion in
                call.unmuteOutgoingAudio(completionHandler: completion)
            }
        }
    }

    func stopActive() -> Result<Void, Error> {
        switch CallGuard.require(session?.currentCall()) {
        case let .failure(error): return .failure(error)
        case let .success(call):
            let stream = call.activeOutgoingAudioStream
            return waitForAcsOperation { completion in
                call.stopAudio(stream: stream, completionHandler: completion)
            }
        }
    }
}

private final class AcsCallDelegateProxy: NSObject, CallDelegate {
    private let onStateChange: (Call) -> Void
    private let onMuteChange: (Call) -> Void

    init(onStateChange: @escaping (Call) -> Void, onMuteChange: @escaping (Call) -> Void) {
        self.onStateChange = onStateChange
        self.onMuteChange = onMuteChange
    }

    func call(_ call: Call, didChangeState _: PropertyChangedEventArgs) {
        onStateChange(call)
    }

    func call(_ call: Call, didUpdateOutgoingAudioState _: PropertyChangedEventArgs) {
        onMuteChange(call)
    }
}

private struct AcsMeetingError: LocalizedError {
    let message: String

    init(_ message: String) {
        self.message = message
    }

    var errorDescription: String? {
        message
    }
}

private func waitForAcsOperation(
    _ start: (@escaping (Error?) -> Void) -> Void
) -> Result<Void, Error> {
    do {
        try CallbackOperation<Void>().wait(timeout: 10) { completion in
            start { completion((), $0) }
        }
        return .success(())
    } catch {
        return .failure(error)
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
