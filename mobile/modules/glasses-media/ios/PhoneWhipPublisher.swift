import CoreVideo
import Foundation
import WebRTC

/// ASG's full-ICE WHIP negotiation, fed from the shared decoded receiver. One peer per attempt.
final class PhoneWhipPublisher: NSObject {
    private let queue = DispatchQueue(label: "com.mentra.glassesmedia.whip.publish")
    private let frameSlot = DispatchSemaphore(value: 1)
    private let endpoint: URL
    private let captureAudio: Bool
    private let bitrate: Int
    private let onState: (String, String) -> Void
    private let audioDevice = RelayAudioDevice()
    private var factory: RTCPeerConnectionFactory?
    private var peer: RTCPeerConnection?
    private var videoSource: RTCVideoSource?
    private var capturer: RTCVideoCapturer?
    private var resource: URL?
    private var posted = false
    private var localSet = false
    private var stopped = false
    private var failed = false
    private var connected = false
    private var disconnectGeneration = 0
    private var lastTimestamp: Int64 = 0
    private let http: URLSession

    init(endpoint: URL, captureAudio: Bool, bitrate: Int, onState: @escaping (String, String) -> Void) {
        self.endpoint = endpoint; self.captureAudio = captureAudio; self.bitrate = bitrate; self.onState = onState
        let config = URLSessionConfiguration.ephemeral
        config.allowsCellularAccess = true
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 25
        http = URLSession(configuration: config)
        super.init()
    }

    func start() {
        queue.async {
            guard !self.stopped else { return }
            RTCInitializeSSL()
            let factory = GlassesPeerFactory.make(audioDevice: self.audioDevice)
            let options = RTCPeerConnectionFactoryOptions()
            options.ignoreWiFiNetworkAdapter = true
            options.ignoreVPNNetworkAdapter = true
            options.ignoreLoopbackNetworkAdapter = true
            factory.setOptions(options)
            self.factory = factory
            let config = RTCConfiguration()
            config.sdpSemantics = .unifiedPlan
            config.iceServers = [RTCIceServer(urlStrings: ["stun:stun.cloudflare.com:3478"])]
            let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
            guard let peer = factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
                self.fail("Could not create WHIP peer"); return
            }
            self.peer = peer
            let source = factory.videoSource()
            self.videoSource = source
            self.capturer = RTCVideoCapturer(delegate: source)
            let video = factory.videoTrack(with: source, trackId: "glasses-video")
            let sendOnly = RTCRtpTransceiverInit()
            sendOnly.direction = .sendOnly
            let transceiver = peer.addTransceiver(with: video, init: sendOnly)
            let codecs = factory.rtpSenderCapabilities(forKind: kRTCMediaStreamTrackKindVideo).codecs.filter { $0.name.lowercased() == "h264" }
            if !codecs.isEmpty { try? transceiver?.setCodecPreferences(codecs, error: ()) }
            if let sender = transceiver?.sender {
                let parameters = sender.parameters
                parameters.encodings.forEach { $0.maxBitrateBps = NSNumber(value: min(12_000_000, max(250_000, self.bitrate))) }
                sender.parameters = parameters
            }
            if self.captureAudio {
                let audioConstraints = RTCMediaConstraints(mandatoryConstraints: ["googEchoCancellation": "false", "googNoiseSuppression": "false", "googAutoGainControl": "false"], optionalConstraints: nil)
                let audio = factory.audioTrack(with: factory.audioSource(with: audioConstraints), trackId: "glasses-audio")
                peer.addTransceiver(with: audio, init: sendOnly)
            }
            peer.offer(for: constraints) { [weak self] offer, error in
                self?.queue.async {
                    guard let self, !self.stopped else { return }
                    guard let offer, error == nil else { self.fail("WHIP offer failed"); return }
                    peer.setLocalDescription(offer) { error in
                        self.queue.async {
                            guard !self.stopped else { return }
                            guard error == nil else { self.fail("WHIP local description failed"); return }
                            self.localSet = true; self.maybePost()
                        }
                    }
                }
            }
            self.queue.asyncAfter(deadline: .now() + 35) {
                if !self.connected { self.fail("WHIP connection timed out") }
            }
        }
    }

    func onFrame(_ buffer: CVPixelBuffer) {
        guard frameSlot.wait(timeout: .now()) == .success else { return }
        queue.async {
            defer { self.frameSlot.signal() }
            guard !self.stopped, let source = self.videoSource, let capturer = self.capturer else { return }
            self.lastTimestamp = max(Int64(ProcessInfo.processInfo.systemUptime * 1_000_000_000), self.lastTimestamp + 1)
            let frame = RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: buffer), rotation: ._0, timeStampNs: self.lastTimestamp)
            source.capturer(capturer, didCapture: frame)
        }
    }

    func onPcm(_ data: Data, rate: Int, channels: Int) {
        if captureAudio { audioDevice.pcm.push(data, sampleRate: rate, channels: channels) }
    }

    private func maybePost() {
        guard !stopped, !posted, localSet, let peer, peer.iceGatheringState == .complete, let offer = peer.localDescription else { return }
        posted = true
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/sdp", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(offer.sdp.utf8)
        // Retain this attempt through a late response, so stop cannot orphan a created WHIP resource.
        http.dataTask(with: request) { data, response, error in
            self.queue.async {
                let response = response as? HTTPURLResponse
                let location = response?.value(forHTTPHeaderField: "Location").flatMap { URL(string: $0, relativeTo: self.endpoint)?.absoluteURL }
                if self.stopped {
                    if let location { self.delete(location) }
                    self.http.finishTasksAndInvalidate()
                    return
                }
                guard error == nil, response?.statusCode == 201, let location, location.scheme == "https",
                      let data, let answer = String(data: data, encoding: .utf8), !answer.isEmpty
                else {
                    if let location { self.delete(location) }
                    self.fail("WHIP server rejected publish (HTTP \(response?.statusCode ?? 0))"); return
                }
                self.resource = location
                peer.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: answer)) { error in
                    self.queue.async { if error != nil { self.fail("WHIP answer failed") } }
                }
            }
        }.resume()
    }

    private func delete(_ url: URL) {
        guard url.scheme == "https" else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        http.dataTask(with: request) { _, _, _ in }.resume()
    }

    private func fail(_ reason: String) {
        guard !stopped, !failed else { return }
        failed = true; onState("failed", reason)
    }

    func stop(completion: @escaping () -> Void) {
        queue.async {
            if !self.stopped {
                self.stopped = true
                self.peer?.close()
                // Drain the external audio callback while its native delegate/factory is still alive.
                _ = self.audioDevice.terminateDevice()
                self.peer = nil
                self.videoSource = nil; self.capturer = nil; self.factory = nil
                if let resource = self.resource { self.delete(resource); self.resource = nil; self.http.finishTasksAndInvalidate() }
                else if !self.posted { self.http.finishTasksAndInvalidate() }
                // An in-flight POST completes cleanup in its callback above.
            }
            completion()
        }
    }
}

extension PhoneWhipPublisher: RTCPeerConnectionDelegate {
    func peerConnection(_: RTCPeerConnection, didChange _: RTCSignalingState) {}
    func peerConnection(_: RTCPeerConnection, didAdd _: RTCMediaStream) {}
    func peerConnection(_: RTCPeerConnection, didRemove _: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange state: RTCIceConnectionState) {
        queue.async {
            guard self.peer === peerConnection, !self.stopped else { return }
            switch state {
            case .connected, .completed:
                self.connected = true; self.disconnectGeneration += 1
                self.onState("connected", "Phone publisher connected")
            case .disconnected:
                self.disconnectGeneration += 1
                let gen = self.disconnectGeneration
                self.queue.asyncAfter(deadline: .now() + 10) {
                    if gen == self.disconnectGeneration { self.fail("Phone internet connection was lost") }
                }
            case .failed: self.fail("WHIP ICE failed")
            default: break
            }
        }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange _: RTCIceGatheringState) {
        queue.async { if self.peer === peerConnection { self.maybePost() } }
    }

    func peerConnection(_: RTCPeerConnection, didGenerate _: RTCIceCandidate) {}
    func peerConnection(_: RTCPeerConnection, didRemove _: [RTCIceCandidate]) {}
    func peerConnection(_: RTCPeerConnection, didOpen _: RTCDataChannel) {}
}
