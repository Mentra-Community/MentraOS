import AVFoundation
import AzureCommunicationCalling
import AzureCommunicationCommon
import ExpoModulesCore
import Foundation
import GlassesMedia

public class AcsMeetingModule: Module {
    private var session: AcsMeetingSession?
    private let hotspot = GlassesHotspotNetwork()

    private func meetingSession() -> AcsMeetingSession {
        if let session { return session }
        let session = AcsMeetingSession(
            onState: { [weak self] state in self?.sendEvent("onState", state) },
            onIncomingPcm: { [weak self] base64, rate, channels in
                self?.sendEvent("onIncomingPcm", ["base64": base64, "sampleRate": rate, "channels": channels])
            }
        )
        self.session = session
        return session
    }

    private func joinHotspot(ssid: String, passphrase: String, gateway: String?, promise: Promise) {
        hotspot.onLost = { [weak self] reason in
            self?.sendEvent("onScopedNetworkLost", ["code": "SOFTAP_LOST", "message": reason])
        }
        hotspot.join(ssid: ssid, passphrase: passphrase, gateway: gateway) { result in
            switch result {
            case let .success(address): promise.resolve(address)
            case let .failure(error): promise.reject(error)
            }
        }
    }

    public func definition() -> ModuleDefinition {
        Name("MentraAcsMeeting")
        Events("onState", "onIncomingPcm", "onScopedNetworkLost")

        AsyncFunction("prepareAgent") { (options: [String: Any], promise: Promise) in
            let token = try requireString(options, "token")
            self.meetingSession().prepareAgent(token: token, displayName: options["displayName"] as? String) { result in
                switch result {
                case let .success(state): promise.resolve(state)
                case let .failure(error): promise.reject(error)
                }
            }
        }

        AsyncFunction("join") { (options: [String: Any], promise: Promise) in
            let token = try requireString(options, "token")
            let meetingUrl = try requireString(options, "meetingUrl")
            let source = try parseMediaSource(options)
            if source.kind == .softap, source.bindAddress != GlassesHotspotNetwork.wifiAddress() {
                throw AcsMeetingError("The glasses hotspot address changed before join")
            }
            let video = try parseAcsOutgoingVideo(options["video"])
            self.meetingSession().join(
                token: token, meetingUrl: meetingUrl, sourceConfig: source,
                displayName: options["displayName"] as? String,
                dumpWav: options["dumpPcmWav"] as? Bool ?? false,
                audioSource: options["audioSource"] as? String ?? "glasses", video: video
            ) { result in
                switch result {
                case let .success(state): promise.resolve(state)
                case let .failure(error): promise.reject(error)
                }
            }
        }

        AsyncFunction("joinScopedNetwork") { (ssid: String, passphrase: String, promise: Promise) in
            self.joinHotspot(ssid: ssid, passphrase: passphrase, gateway: nil, promise: promise)
        }

        AsyncFunction("joinScopedNetworkWithGateway") { (ssid: String, passphrase: String, gateway: String, promise: Promise) in
            self.joinHotspot(ssid: ssid, passphrase: passphrase, gateway: gateway, promise: promise)
        }


        AsyncFunction("leaveScopedNetwork") { (promise: Promise) in
            self.hotspot.leave { promise.resolve(nil) }
        }

        AsyncFunction("beginTrace") { (traceId: String) in
            NSLog("SOFTAP_TRACE trace=\(traceId) stage=ios_begin")
        }
        AsyncFunction("probeScopedGateway") { (promise: Promise) in
            self.hotspot.probeGateway { reachable, detail in
                promise.resolve(["reachable": reachable, "detail": detail])
            }
        }

        AsyncFunction("awaitValidatedDefaultNetwork") { (promise: Promise) in
            self.hotspot.awaitInternet { usable, detail in
                promise.resolve(["usable": usable, "detail": detail, "transport": usable ? "cellular" : "unknown", "validated": usable, "present": usable])
            }
        }

        AsyncFunction("leave") { (promise: Promise) in
            guard let session = self.session else { promise.resolve(nil); return }
            session.leaveAndAwait(timeout: 30) { completed in
                if completed { promise.resolve(nil) }
                else { promise.reject(AcsMeetingError("Previous call cleanup is still pending")) }
            }
        }

        AsyncFunction("leaveAndAwait") { (options: [String: Any], promise: Promise) in
            guard let session = self.session else { promise.resolve(["completed": true]); return }
            session.leaveAndAwait(timeout: Double(options["timeoutMs"] as? Int ?? 30000) / 1000) { completed in
                promise.resolve(["completed": completed])
            }
        }

        AsyncFunction("endForEveryone") { (promise: Promise) in
            guard let session = self.session else {
                promise.reject(NSError(
                    domain: "MentraAcsMeeting",
                    code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "No active meeting to end"]
                ))
                return
            }
            session.endForEveryone { error in
                // Local teardown has already run by the time this fires, so a rejection here means
                // "the meeting may still be running", never "you are still in it".
                if let error {
                    promise.reject(error)
                } else {
                    promise.resolve(session.snapshot())
                }
            }
        }

        AsyncFunction("scopedNetworkInfo") { (promise: Promise) in
            self.hotspot.info { promise.resolve($0) }
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
            self.hotspot.onLost = nil
            self.hotspot.leave {}
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
    private var media: DecodedGlassesMediaSource?
    private var sourceConfig = SourceConfig(url: "")
    private var preparedAgent: CallAgent?
    private var preparedClient: CallClient?
    private var preparedToken: String?
    private var pendingJoin: ((Result<[String: Any], Error>) -> Void)?
    private var pendingPrepare: ((Result<[String: Any], Error>) -> Void)?
    private var cancelPendingCallJoin: (() -> Void)?
    private let cleanup = DispatchGroup()
    private let pcmSlots = DispatchSemaphore(value: 8)
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
    private var mediaSourceReason: String?
    private var mediaRestartAttempts = 0
    private var mediaRestartTask: DispatchWorkItem?
    private static let mediaRestartBaseMs = 1000
    private static let mediaRestartMaxMs = 10000
    private var joinGeneration: UInt64 = 0
    private var capabilitiesFeature: CapabilitiesCallFeature?
    /// nil means "not reported yet", which the miniapp shows as End disabled rather than absent.
    private var hangUpForEveryone: (allowed: Bool, reason: String)?
    private lazy var callDelegateProxy = AcsCallDelegateProxy(
        onStateChange: { [weak self] call in self?.handleCallStateChange(call) },
        onMuteChange: { [weak self] call in self?.handleCallMuteChange(call) }
    )
    private lazy var capabilitiesDelegateProxy = AcsCapabilitiesDelegateProxy(
        onChanged: { [weak self] in self?.refreshCapabilities() }
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
        // Always present, so a host that simply has not heard from Teams yet is distinguishable
        // from one that cannot report capabilities at all. Keys are omitted rather than sent as
        // null while unknown; the host parses a missing key as unknown.
        var hangUp: [String: Any] = [:]
        if let capability = hangUpForEveryone {
            hangUp["allowed"] = capability.allowed
            hangUp["reason"] = capability.reason
        }
        result["capabilities"] = ["hangUpForEveryone": hangUp]
        if let ingestUrl = media?.ingestUrl { result["ingestUrl"] = ingestUrl }
        if let mediaSourceReason { result["mediaSourceReason"] = mediaSourceReason }
        if let meetingUrl { result["meetingUrl"] = meetingUrl }
        if let lastError { result["error"] = lastError }
        return result
    }

    func prepareAgent(token: String, displayName: String?, completion: @escaping (Result<[String: Any], Error>) -> Void) {
        queue.async {
            guard self.cleanup.wait(timeout: .now()) == .success, self.pendingPrepare == nil, self.pendingJoin == nil, self.call == nil, self.media == nil else {
                completion(.failure(AcsMeetingError("Previous call cleanup is still pending"))); return
            }
            self.leaveLocked()
            let generation = self.joinGeneration
            self.pendingPrepare = completion
            do {
                let client = CallClient()
                self.preparedClient = client
                let credential = try CommunicationTokenCredential(token: token)
                let options = CallAgentOptions()
                options.displayName = displayName ?? "Mentra Call"
                client.createCallAgent(userCredential: credential, options: options) { agent, error in
                    self.queue.async {
                        guard self.joinGeneration == generation, self.pendingPrepare != nil else { agent?.dispose(); return }
                        let reply = self.pendingPrepare
                        self.pendingPrepare = nil
                        if let agent, error == nil {
                            self.preparedAgent = agent
                            self.preparedToken = token
                            reply?(.success(self.snapshot()))
                        } else {
                            agent?.dispose()
                            self.preparedClient = nil
                            reply?(.failure(error ?? AcsMeetingError("ACS returned no call agent")))
                        }
                    }
                }
                self.queue.asyncAfter(deadline: .now() + 30) {
                    guard self.joinGeneration == generation, self.pendingPrepare != nil else { return }
                    self.leaveLocked()
                }
            } catch {
                self.pendingPrepare = nil
                self.preparedClient = nil
                completion(.failure(error))
            }
        }
    }

    func join(token: String, meetingUrl: String, sourceConfig: SourceConfig, displayName: String?, dumpWav: Bool,
              audioSource: String = "glasses", video: AcsOutgoingVideo = .hd,
              completion: @escaping (Result<[String: Any], Error>) -> Void)
    {
        queue.async {
            guard self.cleanup.wait(timeout: .now()) == .success, self.pendingPrepare == nil, self.pendingJoin == nil, self.call == nil, self.media == nil else {
                completion(.failure(AcsMeetingError("Previous call cleanup is still pending"))); return
            }
            let prepared = self.preparedToken == token ? self.preparedAgent : nil
            let preparedClient = self.preparedClient
            if prepared != nil { self.preparedAgent = nil; self.preparedClient = nil; self.preparedToken = nil }
            self.leaveLocked(emitIdle: false)
            let generation = self.joinGeneration
            self.pendingJoin = completion
            self.sourceConfig = sourceConfig
            self.audioSource = AcsAudioPolicy.parseSource(audioSource) == .phone ? "phone" : "glasses"
            self.meetingUrl = meetingUrl
            self.lastError = nil
            self.emit("connecting")
            let useAgent: (CallAgent) -> Void = { agent in
                do { try self.joinWithAgentLocked(agent, generation: generation, meetingUrl: meetingUrl,
                                                  sourceConfig: sourceConfig, dumpWav: dumpWav, video: video) } catch { self.failJoinLocked(error, generation: generation) }
            }
            if let prepared {
                self.callClient = preparedClient
                useAgent(prepared)
            } else {
                do {
                    let credential = try CommunicationTokenCredential(token: token)
                    let client = CallClient()
                    self.callClient = client
                    let options = CallAgentOptions()
                    options.displayName = displayName ?? "Mentra Call"
                    client.createCallAgent(userCredential: credential, options: options) { agent, error in
                        self.queue.async {
                            guard self.joinGeneration == generation else { agent?.dispose(); return }
                            guard let agent, error == nil else {
                                agent?.dispose()
                                self.failJoinLocked(error ?? AcsMeetingError("ACS returned no call agent"), generation: generation)
                                return
                            }
                            useAgent(agent)
                        }
                    }
                } catch { self.failJoinLocked(error, generation: generation) }
            }
            self.queue.asyncAfter(deadline: .now() + 40) {
                guard self.joinGeneration == generation, self.pendingJoin != nil else { return }
                self.failJoinLocked(AcsMeetingError("ACS join timed out"), generation: generation)
            }
        }
    }

    private func joinWithAgentLocked(
        _ agent: CallAgent,
        generation: UInt64,
        meetingUrl: String,
        sourceConfig: SourceConfig,
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
        frameSender = AcsFrameSender()
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
        // Cancellation reserves cleanup and retains the agent until the late join result
        // can be hung up. The retirement deadline still handles an SDK callback that is lost.
        let joinRetirement = CallJoinRetirement<Call>(group: cleanup, queue: queue, dispose: { agent.dispose() }) { call, finished in
            call.hangUp(options: nil) { error in
                if let error { NSLog("ACS-SPIKE cancelled join hangUp failed: \(error)") }
                finished()
            }
        }
        cancelPendingCallJoin = { joinRetirement.cancel() }
        agent.join(with: locator, joinCallOptions: joinOptions) { call, error in
            self.queue.async {
                guard joinRetirement.receive(call) else { return }
                guard self.callAgent === agent, self.joinGeneration == generation else {
                    call?.hangUp(options: nil) { _ in }
                    return
                }
                self.cancelPendingCallJoin = nil
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
                    sourceConfig: sourceConfig,
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
        sourceConfig: SourceConfig,
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
        attachCapabilities(call)

        let bridge = PcmBridge(dumpWav: dumpWav)
        pcmBridge = bridge
        phoneMic.onPcm = { [weak self] pcm, rate, channels in
            self?.feedOutgoingPcm(pcm, sampleRate: rate, channels: channels, generation: generation)
        }
        let source: DecodedGlassesMediaSource = sourceConfig.kind == .softap ? LocalWhipIngestSource() : WhepVideoSource()
        source.onFrame = { [frameSender] buffer in frameSender.send(buffer) }
        source.onPcm = { [weak self] pcm, rate, channels in
            self?.feedOutgoingPcm(pcm, sampleRate: rate, channels: channels, generation: generation)
        }
        mediaRestartAttempts = 0
        source.onStateChange = { [weak self, weak source] state, reason in
            // Fired from WebRTC/URLSession threads; hop to the session queue so it
            // serializes with join/leave/policy like everything else.
            self?.queue.async {
                guard let self, let source, self.media === source else { return }
                self.onMediaSourceState(state, reason: reason)
            }
        }
        media = source
        applyAudioPolicyOnQueue("join")
        let ready: (Result<String, Error>) -> Void = { result in
            self.queue.async {
                guard self.joinGeneration == generation, self.media === source else { return }
                switch result {
                case .success:
                    let reply = self.pendingJoin
                    self.pendingJoin = nil
                    reply?(.success(self.snapshot()))
                case let .failure(error): self.failJoinLocked(error, generation: generation)
                }
            }
        }
        if let local = source as? LocalWhipIngestSource {
            local.prepare(config: sourceConfig, completion: ready)
        } else {
            source.start(config: sourceConfig)
            ready(.success(""))
        }
        NSLog("ACS-SPIKE iOS ACS join started source=\(audioSource) profile=\(video.width)x\(video.height)@\(video.fps) armVirtual=\(plan.armVirtual) transportMuted=\(plan.transportMuted)")
    }

    private func failJoinLocked(_ error: Error, generation: UInt64) {
        guard joinGeneration == generation else { return }
        // Record failure before teardown: lastError makes late call callbacks no-ops,
        // and emitIdle=false preserves the terminal error rather than resetting idle.
        let reply = pendingJoin
        pendingJoin = nil
        lastError = error.localizedDescription
        leaveLocked(emitIdle: false)
        emit("error")
        reply?(.failure(error))
    }

    func updateVideoSource(_ whepUrl: String) {
        queue.async {
            // The host has a fresher opinion about where the glasses publish; drop any
            // automatic retry against the old URL.
            guard self.sourceConfig.kind == .whep else { return }
            self.cancelMediaRestart()
            self.media?.restart(config: SourceConfig(url: whepUrl))
        }
    }

    /// Rebuild the WHEP subscription on the current URL even when it looks healthy.
    /// The host calls this when the phone changed networks.
    func restartVideoSource() {
        queue.async {
            guard self.sourceConfig.kind == .whep else { return }
            self.cancelMediaRestart()
            self.media?.forceRestart()
        }
    }

    private func onMediaSourceState(_ state: SourceState, reason: String) {
        let previous = mediaSource
        mediaSource = state
        mediaSourceReason = reason
        if state == .live { mediaRestartAttempts = 0 }
        if state == .failed { scheduleMediaRestart(reason: reason) }
        // start() emits idle then connecting back to back; one snapshot per real change.
        if previous != state, call != nil, phase != "idle" { onState(snapshot()) }
    }

    /// Native owns first-line recovery: nothing above this layer can see ICE fail, and a
    /// Teams call with a frozen last frame looks healthy from every other angle.
    /// Exponential backoff capped at mediaRestartMaxMs, for as long as the call is alive.
    private func scheduleMediaRestart(reason: String) {
        guard sourceConfig.kind == .whep, call != nil, !["idle", "disconnected", "error"].contains(phase) else { return }
        guard mediaRestartTask == nil else { return }
        let attempt = mediaRestartAttempts
        mediaRestartAttempts += 1
        let delayMs = min(Self.mediaRestartBaseMs << min(attempt, 4), Self.mediaRestartMaxMs)
        NSLog("ACS-SPIKE glasses media source failed (\(reason)); WHEP rebuild #\(attempt + 1) in \(delayMs)ms")
        let task = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.mediaRestartTask = nil
            guard self.call != nil, self.mediaSource == .failed else { return }
            self.media?.forceRestart()
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

    func leaveAndAwait(timeout: TimeInterval, completion: @escaping (Bool) -> Void) {
        queue.async {
            self.leaveLocked()
            DispatchQueue.global(qos: .userInitiated).async {
                completion(self.cleanup.wait(timeout: .now() + max(0, min(timeout, 60))) == .success)
            }
        }
    }

    /**
     End the meeting for everyone, then tear this device down.

     Local teardown runs whether or not ACS accepted the hang-up, and the error is reported after
     it. The wearer is out of the call either way; what the caller learns from a rejection is only
     that the others may still be in it.

     A known-denied capability is refused locally rather than sent. Teams only lets a presenter end
     a meeting for everyone, ACS rejects the attempt with an opaque error, and the wearer would have
     sat through a confirm sheet for nothing. An *unknown* capability is not a refusal: it is the
     ordinary state before the first capabilities event, and letting ACS answer is more honest than
     guessing.
     */
    func endForEveryone(completion: @escaping (Error?) -> Void) {
        queue.async { [weak self] in
            guard let self else { return }
            if let refusal = self.hangUpForEveryoneRefusal() {
                completion(NSError(
                    domain: "MentraAcsMeeting",
                    code: 3,
                    userInfo: [NSLocalizedDescriptionKey: refusal]
                ))
                return
            }
            guard let active = self.call else {
                self.leaveLocked()
                completion(NSError(
                    domain: "MentraAcsMeeting",
                    code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "No active meeting to end"]
                ))
                return
            }
            let options = HangUpOptions()
            options.forEveryone = true
            active.hangUp(options: options) { [weak self] error in
                guard let self else {
                    completion(error)
                    return
                }
                if let error {
                    NSLog("ACS-SPIKE endForEveryone failed: \(error)")
                }
                self.queue.async {
                    self.leaveLocked()
                    completion(error)
                }
            }
        }
    }

    /// The refusal to report, or nil when the End should be attempted.
    private func hangUpForEveryoneRefusal() -> String? {
        guard let capability = readHangUpForEveryone(), !capability.allowed else { return nil }
        return "hang_up_for_everyone_not_allowed:\(capability.reason)"
    }

    /**
     Subscribe to the runtime capability that decides whether End is offered.

     Subscribed rather than read once: Teams can grant the capability after admission (a wearer
     promoted to presenter mid-call), and an End button that never turns on is the same bug as one
     that lies about what it does.
     */
    private func attachCapabilities(_ call: Call) {
        let feature = call.feature(Features.capabilities)
        capabilitiesFeature = feature
        feature.delegate = capabilitiesDelegateProxy
        refreshCapabilities()
    }

    fileprivate func refreshCapabilities() {
        queue.async { [weak self] in
            guard let self else { return }
            let next = self.readHangUpForEveryone()
            guard next?.allowed != self.hangUpForEveryone?.allowed
                || next?.reason != self.hangUpForEveryone?.reason else { return }
            self.hangUpForEveryone = next
            NSLog("ACS-SPIKE hangUpForEveryone allowed=\(next?.allowed.description ?? "unknown") reason=\(next?.reason ?? "-")")
            self.onState(self.snapshot())
        }
    }

    /// Drop the capability so the next call starts unknown instead of inheriting the last one's.
    private func detachCapabilities() {
        capabilitiesFeature?.delegate = nil
        capabilitiesFeature = nil
        hangUpForEveryone = nil
    }

    private func readHangUpForEveryone() -> (allowed: Bool, reason: String)? {
        guard let feature = capabilitiesFeature else { return nil }
        guard let capability = feature.capabilities.first(where: { $0.type == .hangUpForEveryone }) else { return nil }
        return (capability.isAllowed, String(describing: capability.reason))
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

    private func feedOutgoingPcm(_ pcm: Data, sampleRate: Int, channels: Int, generation: UInt64) {
        guard pcmSlots.wait(timeout: .now()) == .success else { return }
        queue.async {
            defer { self.pcmSlots.signal() }
            guard self.joinGeneration == generation else { return }
            self.feedOutgoingPcmLocked(pcm, sampleRate: sampleRate, channels: channels)
        }
    }

    private func feedOutgoingPcmLocked(_ pcm: Data, sampleRate: Int, channels: Int) {
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
        let joinReply = pendingJoin
        pendingJoin = nil
        joinReply?(.failure(AcsMeetingError("Meeting join cancelled")))
        let prepareReply = pendingPrepare
        pendingPrepare = nil
        prepareReply?(.failure(AcsMeetingError("Meeting preparation cancelled or timed out")))
        preparedAgent?.dispose()
        preparedAgent = nil
        preparedClient = nil
        preparedToken = nil
        phoneMic.setEnabled(false)
        phoneMic.onPcm = nil
        applier.reset()
        scheduler.cancelPending()
        pcmBridge?.finishDump()
        // Detach before stop so the teardown's own idle transition does not emit a
        // snapshot (or schedule a rebuild) for a call that is going away.
        cancelMediaRestart()
        detachCapabilities()
        media?.onStateChange = nil
        media?.onFrame = nil
        media?.onPcm = nil
        mediaSource = .idle
        mediaSourceReason = nil
        if let local = media as? LocalWhipIngestSource {
            cleanup.enter()
            local.stop { self.cleanup.leave() }
        } else { media?.stop() }
        frameSender.detach()
        let leavingCall = call
        let leavingAgent = callAgent
        let cancelJoin = cancelPendingCallJoin
        cancelPendingCallJoin = nil
        leavingCall?.delegate = nil
        if let leavingCall {
            // CallAgent.dispose releases all local SDK resources. The retirement deadline
            // also disposes the agent if hangUp loses its callback, before opening the barrier.
            let retirement = CallAgentRetirement(group: cleanup, queue: queue) { leavingAgent?.dispose() }
            leavingCall.hangUp(options: nil) { error in
                self.queue.async {
                    if let error { NSLog("ACS-SPIKE leave hangUp failed: \(error)") }
                    retirement.finish()
                }
            }
        } else if let cancelJoin {
            // Keep the agent alive while awaiting the cancelled join and its hang-up.
            cancelJoin()
        } else {
            // Agent creation has no call to retire; its callback disposes any late agent.
            leavingAgent?.dispose()
        }
        callAgent = nil
        callClient = nil
        call = nil
        media = nil
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

    fileprivate func currentWhep() -> DecodedGlassesMediaSource? {
        media
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

private final class AcsCapabilitiesDelegateProxy: NSObject, CapabilitiesCallFeatureDelegate {
    private let onChanged: () -> Void

    init(onChanged: @escaping () -> Void) {
        self.onChanged = onChanged
    }

    func capabilitiesCallFeature(
        _: CapabilitiesCallFeature,
        didChangeCapabilities _: CapabilitiesChangedEventArgs
    ) {
        onChanged()
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

    static let hd = AcsOutgoingVideo(width: 1280, height: 720, fps: 15, maxBitrateBps: 3_000_000)
    static let allowedSizes: Set<String> = ["1280x720", "960x540"]
}

private func requireString(_ options: [String: Any], _ key: String) throws -> String {
    guard let value = options[key] as? String, !value.isEmpty else {
        throw NSError(domain: "MentraAcsMeeting", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(key) is required"])
    }
    return value
}

private func parseMediaSource(_ options: [String: Any]) throws -> SourceConfig {
    try SourceConfig.fromBridge(options["videoSource"] as? [String: Any], legacyWhepUrl: options["whepUrl"] as? String)
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
