import AVFoundation
import CoreVideo
import Foundation
import WebRTC

/// The same local WHIP contract as Android: glasses offer, phone answers, publishers receive
/// decoded buffers. All peer lifecycle transitions and generation checks run on `queue`.
public final class LocalWhipIngestSource: NSObject, DecodedGlassesMediaSource {
    public var onFrame: ((CVPixelBuffer) -> Void)?
    public var onPcm: ((Data, Int, Int) -> Void)?
    public var onStateChange: ((SourceState, String) -> Void)?
    private let queue = DispatchQueue(label: "com.mentra.glassesmedia.whip.peer")
    private let queueKey = DispatchSpecificKey<Bool>()
    private var currentState: SourceState = .idle
    private var url: String?
    public var state: SourceState {
        DispatchQueue.getSpecific(key: queueKey) == true ? currentState : queue.sync { currentState }
    }

    public var ingestUrl: String? {
        DispatchQueue.getSpecific(key: queueKey) == true ? url : queue.sync { url }
    }

    private var address = ""
    private var generation = 0
    private var factory: RTCPeerConnectionFactory?
    private var peer: RTCPeerConnection?
    private var server: WhipIngestServer?
    private var video: RTCVideoTrack?
    private var audio: [RTCAudioTrack] = []
    private var renderer: LocalMediaRenderer?
    private var pcmEnabled = false
    private var pendingAnswer: ((Result<String, Error>) -> Void)?
    private var localDescriptionSet = false
    private var firstFrameSeen = false
    private var stopping = false
    private var stopReplies: [() -> Void] = []
    private let videoSlot = DispatchSemaphore(value: 1)
    private let audioSlots = DispatchSemaphore(value: 8)

    override public init() {
        super.init()
        queue.setSpecific(key: queueKey, value: true)
    }

    public func start(config: SourceConfig) {
        prepare(config: config) { _ in }
    }

    public func restart(config _: SourceConfig) {
        // A new URL must be delivered to the glasses by the owner. Never silently rotate it.
        queue.async { self.transition(.failed, "local_restart_requires_republish") }
    }

    public func forceRestart() {
        queue.async { self.transition(.failed, "local_restart_requires_republish") }
    }

    /// Resolves only after the HTTP listener is bound. The owner can then tell the glasses to publish.
    public func prepare(config: SourceConfig, completion: @escaping (Result<String, Error>) -> Void) {
        queue.async {
            guard self.server == nil, !self.stopping, let address = config.bindAddress, LocalMediaPolicy.isPrivate(address) else {
                completion(.failure(LocalMediaError("A free receiver and the phone's hotspot address are required"))); return
            }
            self.address = address
            self.generation += 1
            let gen = self.generation
            self.transition(.connecting, "listening")
            RTCInitializeSSL()
            let factory = RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory(), audioDevice: ReceiveOnlyAudioDevice())
            let options = RTCPeerConnectionFactoryOptions()
            options.ignoreCellularNetworkAdapter = true
            options.ignoreVPNNetworkAdapter = true
            options.ignoreLoopbackNetworkAdapter = true
            options.ignoreEthernetNetworkAdapter = true
            factory.setOptions(options)
            self.factory = factory
            let server = WhipIngestServer(
                negotiate: { [weak self] offer, reply in
                    guard let self else { reply(.failure(LocalMediaError("Receiver released"))); return }
                    self.queue.async { self.negotiate(offer, completion: reply) }
                },
                terminate: { [weak self] in
                    self?.queue.async {
                        guard let self else { return }
                        self.closePeer()
                        if self.currentState != .idle { self.transition(.failed, "publisher_terminated") }
                    }
                },
                publisherFailed: { [weak self] in self?.state == .failed }
            )
            self.server = server
            server.start(address: address) { [weak self] result in
                guard let self else { completion(.failure(LocalMediaError("Receiver released"))); return }
                self.queue.async {
                    guard gen == self.generation, !self.stopping else { completion(.failure(LocalMediaError("Receiver cancelled"))); return }
                    switch result {
                    case let .success(url): self.url = url
                    case let .failure(error): self.transition(.failed, error.localizedDescription)
                    }
                    completion(result)
                }
            }
        }
    }

    public func setPcmDeliveryEnabled(_ enabled: Bool) {
        queue.async { self.pcmEnabled = enabled }
    }

    public func stop() {
        stop(completion: {})
    }

    public func stop(completion: @escaping () -> Void) {
        queue.async {
            self.stopReplies.append(completion)
            guard !self.stopping else { return }
            self.stopping = true
            self.generation += 1
            self.url = nil
            self.closePeer()
            self.transition(.idle, "stop")
            let server = self.server
            self.server = nil
            let finish = {
                self.queue.async {
                    self.factory = nil
                    self.stopping = false
                    let replies = self.stopReplies
                    self.stopReplies.removeAll()
                    replies.forEach { $0() }
                }
            }
            if let server { server.stop(completion: finish) } else { finish() }
        }
    }

    private func negotiate(_ offer: String, completion: @escaping (Result<String, Error>) -> Void) {
        guard let factory, !stopping, currentState != .idle else { completion(.failure(LocalMediaError("Receiver stopped"))); return }
        do {
            let localOffer = try LocalMediaPolicy.localSdp(offer, address: address, answer: false)
            closePeer()
            generation += 1
            let gen = generation
            transition(.connecting, "offer")
            let configuration = RTCConfiguration()
            configuration.iceServers = []
            configuration.sdpSemantics = .unifiedPlan
            configuration.bundlePolicy = .maxBundle
            configuration.tcpCandidatePolicy = .disabled
            configuration.continualGatheringPolicy = .gatherOnce
            let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
            guard let peer = factory.peerConnection(with: configuration, constraints: constraints, delegate: self) else { throw LocalMediaError("Peer creation failed") }
            self.peer = peer
            pendingAnswer = completion
            renderer = LocalMediaRenderer(
                frame: { [weak self] buffer in self?.deliverFrame(buffer, generation: gen) },
                pcm: { [weak self] pcm, rate, channels in self?.deliverPcm(pcm, rate: rate, channels: channels, generation: gen) }
            )
            peer.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: localOffer)) { [weak self, weak peer] error in
                self?.queue.async {
                    guard let self, let peer, gen == self.generation, self.peer === peer else { return }
                    if let error { self.fail(error); return }
                    peer.answer(for: constraints) { [weak self, weak peer] answer, error in
                        self?.queue.async {
                            guard let self, let peer, gen == self.generation, self.peer === peer else { return }
                            guard let answer, error == nil else { self.fail(error ?? LocalMediaError("Answer creation failed")); return }
                            peer.setLocalDescription(answer) { [weak self, weak peer] error in
                                self?.queue.async {
                                    guard let self, let peer, gen == self.generation, self.peer === peer else { return }
                                    if let error { self.fail(error); return }
                                    self.localDescriptionSet = true
                                    self.finishAnswerIfGathered()
                                }
                            }
                        }
                    }
                }
            }
            queue.asyncAfter(deadline: .now() + 9) { [weak self] in
                guard let self, gen == self.generation, self.pendingAnswer != nil else { return }
                self.fail(LocalMediaError("WHIP negotiation timed out"))
            }
        } catch { completion(.failure(error)); transition(.failed, error.localizedDescription) }
    }

    private func finishAnswerIfGathered() {
        guard localDescriptionSet, let peer, peer.iceGatheringState == .complete, let completion = pendingAnswer else { return }
        do {
            let answer = try LocalMediaPolicy.localSdp(peer.localDescription?.sdp ?? "", address: address, answer: true)
            pendingAnswer = nil
            completion(.success(answer))
            let gen = generation
            queue.asyncAfter(deadline: .now() + 6) { [weak self] in
                guard let self, gen == self.generation, !self.firstFrameSeen else { return }
                self.fail(LocalMediaError("No decoded video after WHIP negotiation"))
            }
        } catch { fail(error) }
    }

    private func closePeer() {
        generation += 1
        let completion = pendingAnswer
        pendingAnswer = nil
        completion?(.failure(LocalMediaError("Negotiation cancelled")))
        if let renderer {
            video?.remove(renderer)
            audio.forEach { $0.remove(renderer) }
        }
        video = nil
        audio.removeAll()
        renderer = nil
        let previous = peer
        peer = nil
        previous?.close()
        localDescriptionSet = false
        firstFrameSeen = false
    }

    private func fail(_ error: Error) {
        let completion = pendingAnswer
        pendingAnswer = nil
        completion?(.failure(error))
        closePeer()
        transition(.failed, error.localizedDescription)
    }

    private func attach(_ track: RTCMediaStreamTrack) {
        guard let renderer else { return }
        if let track = track as? RTCVideoTrack, video !== track {
            video?.remove(renderer)
            video = track
            track.add(renderer)
        }
        if let track = track as? RTCAudioTrack, !audio.contains(where: { $0 === track }) {
            audio.append(track)
            track.isEnabled = true
            track.add(renderer)
        }
    }

    private func deliverFrame(_ buffer: CVPixelBuffer, generation gen: Int) {
        // Bound queued media and return immediately: close() can wait for WebRTC render callbacks.
        guard videoSlot.wait(timeout: .now()) == .success else { return }
        queue.async { [self] in
            defer { videoSlot.signal() }
            guard gen == generation, peer != nil, !stopping else { return }
            firstFrameSeen = true
            transition(.live, "first_frame")
            onFrame?(buffer)
        }
    }

    private func deliverPcm(_ pcm: Data, rate: Int, channels: Int, generation gen: Int) {
        guard audioSlots.wait(timeout: .now()) == .success else { return }
        queue.async { [self] in
            defer { audioSlots.signal() }
            guard gen == generation, peer != nil, pcmEnabled, !stopping else { return }
            onPcm?(pcm, rate, channels)
        }
    }

    private func transition(_ state: SourceState, _ reason: String) {
        guard currentState != state else { return }
        currentState = state
        NSLog("GLASSES-MEDIA source=\(state.rawValue) reason=\(reason)")
        onStateChange?(state, reason)
    }
}

extension LocalWhipIngestSource: RTCPeerConnectionDelegate {
    public func peerConnection(_: RTCPeerConnection, didChange _: RTCSignalingState) {}
    public func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        queue.async { guard self.peer === peerConnection else { return }; stream.videoTracks.forEach(self.attach); stream.audioTracks.forEach(self.attach) }
    }

    public func peerConnection(_: RTCPeerConnection, didRemove _: RTCMediaStream) {}
    public func peerConnectionShouldNegotiate(_: RTCPeerConnection) {}
    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        queue.async {
            guard self.peer === peerConnection else { return }
            if newState == .failed { self.fail(LocalMediaError("Local ICE failed")) }
            if newState == .disconnected {
                self.firstFrameSeen = false
                self.transition(.connecting, "ice_disconnected")
                let gen = self.generation
                self.queue.asyncAfter(deadline: .now() + 6) {
                    guard gen == self.generation, self.peer === peerConnection, !self.firstFrameSeen else { return }
                    self.fail(LocalMediaError("Local ICE disconnected"))
                }
            }
        }
    }

    public func peerConnection(_ peerConnection: RTCPeerConnection, didChange _: RTCIceGatheringState) {
        queue.async { guard self.peer === peerConnection else { return }; self.finishAnswerIfGathered() }
    }

    public func peerConnection(_: RTCPeerConnection, didGenerate _: RTCIceCandidate) {}
    public func peerConnection(_: RTCPeerConnection, didRemove _: [RTCIceCandidate]) {}
    public func peerConnection(_: RTCPeerConnection, didOpen _: RTCDataChannel) {}
    public func peerConnection(_ peerConnection: RTCPeerConnection, didStartReceivingOn transceiver: RTCRtpTransceiver) {
        queue.async { guard self.peer === peerConnection, let track = transceiver.receiver.track else { return }; self.attach(track) }
    }
}

private final class LocalMediaRenderer: NSObject, RTCVideoRenderer, RTCAudioRenderer {
    let frame: (CVPixelBuffer) -> Void
    let pcm: (Data, Int, Int) -> Void
    init(frame: @escaping (CVPixelBuffer) -> Void, pcm: @escaping (Data, Int, Int) -> Void) {
        self.frame = frame; self.pcm = pcm
    }

    func setSize(_: CGSize) {}
    func renderFrame(_ frame: RTCVideoFrame?) {
        guard let frame, let buffer = frame.buffer as? RTCCVPixelBuffer else { return }
        self.frame(buffer.pixelBuffer)
    }

    func render(pcmBuffer: AVAudioPCMBuffer) {
        guard let data = DecodedPcm.pcm16(pcmBuffer) else { return }
        pcm(data, Int(pcmBuffer.format.sampleRate), Int(pcmBuffer.format.channelCount))
    }
}
