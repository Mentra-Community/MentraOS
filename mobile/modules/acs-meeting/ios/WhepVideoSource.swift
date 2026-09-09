import AVFoundation
import CoreVideo
import Foundation
import WebRTC

/// Recvonly WHEP subscriber. Decoded frames become CVPixelBuffers for ACS.
/// Remote PCM is the P4 hard gate (RTCAudioRenderer on LiveKit/WebRTC-SDK 137).
final class WhepVideoSource: NSObject, GlassesMediaSource {
  var onFrame: ((CVPixelBuffer) -> Void)?
  var onPcm: ((Data, Int, Int) -> Void)?
  /// Fires on every health transition. `.failed` is the one nothing else can see:
  /// ICE dropped or the WHEP endpoint went away while the ACS call stays connected.
  var onStateChange: ((SourceState, String) -> Void)?
  private(set) var state: SourceState = .idle

  private var factory: RTCPeerConnectionFactory?
  private var pc: RTCPeerConnection?
  private var currentUrl: String?
  private var offerPosted = false
  private var pendingOfferPost: DispatchWorkItem?
  // Fail closed like Android: the audio policy turns delivery on once the ACS
  // virtual stream is live. Survives restart() so a WHEP rebuild cannot silently
  // re-open the uplink against the current mute decision.
  private var pcmEnabled = false
  private var audioTracks: [RTCAudioTrack] = []
  private var attachedVideo: RTCVideoTrack?
  // Every peer generation gets its own id so a callback from a peer being torn
  // down (ICE failed racing a rebuild) cannot mark the new one failed.
  private var generation = 0
  // `.live` means "a frame reached the renderer", not "the WHEP endpoint
  // answered" — the answer lands seconds before ACS submits anything, and an
  // answer that never produces a frame used to read healthy forever behind a
  // frozen image. Armed per generation so a frame from a peer being torn down
  // cannot promote its replacement.
  private var firstFrameGeneration = -1
  private var firstFramePromoted = false
  private var firstFrameDeadline: DispatchWorkItem?
  private var frameCount = 0
  private var lastFpsLog = Date()
  private lazy var http: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 20
    config.timeoutIntervalForResource = 20
    return URLSession(configuration: config)
  }()

  func start(config: SourceConfig) {
    start(whepUrl: config.url)
  }

  func start(whepUrl: String) {
    stop()
    currentUrl = whepUrl
    offerPosted = false
    generation += 1
    let gen = generation
    transition(.connecting, reason: "start")
    RTCInitializeSSL()
    let encoder = RTCDefaultVideoEncoderFactory()
    let decoder = RTCDefaultVideoDecoderFactory()
    factory = RTCPeerConnectionFactory(encoderFactory: encoder, decoderFactory: decoder)
    let config = RTCConfiguration()
    config.iceServers = [RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])]
    let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
    guard let factory, let peer = factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
      transition(.failed, reason: "peer_create_failed")
      return
    }
    pc = peer
    peer.addTransceiver(of: .video, init: RTCRtpTransceiverInit.recvOnly())
    peer.addTransceiver(of: .audio, init: RTCRtpTransceiverInit.recvOnly())
    peer.offer(for: constraints) { [weak self] sdp, error in
      guard let self, self.generation == gen else { return }
      guard let sdp, error == nil else {
        self.transition(.failed, reason: "offer_failed")
        return
      }
      peer.setLocalDescription(sdp) { [weak self] _ in
        // Track the delayed post so a same-instance restart can cancel it and
        // avoid publishing a stale peer's SDP before ICE finishes.
        let work = DispatchWorkItem { [weak self] in self?.postOfferIfNeeded() }
        self?.pendingOfferPost = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
      }
    }
  }

  func restart(config: SourceConfig) {
    // Only reuse the existing subscriber when the URL is unchanged AND the peer
    // is still healthy. After ICE failed/disconnected (e.g. a Wi-Fi drop reusing
    // the same WHEP URL) we must rebuild, or glasses video and mic never recover.
    // `.connecting` is reusable and now spans answer → first frame; rebuilding
    // there would only restart a wait that is bounded by the deadline below.
    if config.url == currentUrl, state != .failed { return }
    start(config: config)
  }

  /// Rebuild on the current URL even when the peer looks healthy (phone changed
  /// networks; ICE may not have noticed the dead candidate pair yet).
  func forceRestart() {
    guard let url = currentUrl else { return }
    NSLog("ACS-SPIKE WHEP forced rebuild state=\(state.rawValue)")
    start(whepUrl: url)
  }

  func updateUrl(_ whepUrl: String) {
    restart(config: SourceConfig(url: whepUrl))
  }

  func setPcmDeliveryEnabled(_ enabled: Bool) {
    setPcmEnabled(enabled)
  }

  func setPcmEnabled(_ enabled: Bool) {
    pcmEnabled = enabled
    audioTracks.forEach { $0.isEnabled = enabled }
    NSLog("ACS-SPIKE WHEP audio track enabled=\(enabled)")
  }

  func stop() {
    currentUrl = nil
    offerPosted = false
    pendingOfferPost?.cancel()
    pendingOfferPost = nil
    // Disarmed before the renderer is removed, so a frame already in flight
    // cannot promote the source we are tearing down.
    cancelFirstFrameDeadline()
    firstFrameGeneration = -1
    firstFramePromoted = false
    audioTracks.removeAll()
    attachedVideo?.remove(self as RTCVideoRenderer)
    attachedVideo = nil
    // Invalidate callbacks from the peer being closed below before they can
    // observe the idle we are about to set.
    generation += 1
    transition(.idle, reason: "stop")
    // Drop our reference first so delegate callbacks fired by close() fail isCurrent().
    let peer = pc
    pc = nil
    peer?.close()
  }

  private func transition(_ next: SourceState, reason: String) {
    let previous = state
    state = next
    guard previous != next else { return }
    NSLog("ACS-SPIKE WHEP source \(previous.rawValue) -> \(next.rawValue) (\(reason))")
    onStateChange?(next, reason)
  }

  private func attachVideo(_ track: RTCVideoTrack) {
    // Unified Plan delivers the same remote video via didAdd stream and
    // didStartReceivingOn; rendering it twice doubles the frames handed to ACS.
    if let attachedVideo, attachedVideo === track { return }
    attachedVideo?.remove(self as RTCVideoRenderer)
    attachedVideo = track
    track.add(self as RTCVideoRenderer)
  }

  private func attachAudio(_ track: RTCAudioTrack) {
    // Unified Plan fires didAdd stream, didStartReceivingOn and add-track for
    // the same remote audio; only wire the renderer once or Teams hears doubled
    // PCM.
    if audioTracks.contains(where: { $0 === track }) {
      track.isEnabled = pcmEnabled
      return
    }
    audioTracks.append(track)
    track.isEnabled = pcmEnabled
    track.add(self as RTCAudioRenderer)
  }

  private func postOfferIfNeeded() {
    guard !offerPosted, let url = currentUrl, let peer = pc, let sdp = peer.localDescription?.sdp else { return }
    offerPosted = true
    postOffer(url: url, sdp: sdp, peer: peer, gen: generation)
  }

  private func postOffer(url: String, sdp: String, peer: RTCPeerConnection, gen: Int) {
    guard let endpoint = URL(string: url) else {
      transition(.failed, reason: "whep_bad_url")
      return
    }
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.setValue("application/sdp", forHTTPHeaderField: "Content-Type")
    request.httpBody = sdp.data(using: .utf8)
    http.dataTask(with: request) { [weak self] data, response, error in
      guard let self, self.generation == gen else { return }
      let code = (response as? HTTPURLResponse)?.statusCode ?? -1
      NSLog("ACS-SPIKE P3 WHEP \(code) answer bytes=\(data?.count ?? 0)")
      guard error == nil, (200 ..< 300).contains(code),
            let data, let answer = String(data: data, encoding: .utf8) else {
        NSLog("ACS-SPIKE WHEP answer rejected code=\(code) error=\(error?.localizedDescription ?? "none")")
        self.transition(.failed, reason: error != nil ? "whep_post_failed" : "whep_http_\(code)")
        return
      }
      // Stay `.connecting`: setRemoteDescription, ICE and the decoder still have
      // to run before ACS is handed anything.
      self.armFirstFrame(gen: gen)
      let desc = RTCSessionDescription(type: .answer, sdp: answer)
      peer.setRemoteDescription(desc) { _ in }
    }.resume()
  }

  /// Arms the first-frame gate for `gen` and bounds the wait. An answered WHEP
  /// that never delivers is invisible to every other layer — ACS keeps the call
  /// up on a frozen frame — so it has to expire into `.failed` and let the
  /// module's rebuild backoff repair it.
  private func armFirstFrame(gen: Int) {
    firstFrameGeneration = gen
    firstFramePromoted = false
    cancelFirstFrameDeadline()
    let work = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.firstFrameDeadline = nil
      guard self.generation == gen, self.firstFrameGeneration == gen, !self.firstFramePromoted else { return }
      NSLog("ACS-SPIKE WHEP answered but delivered no frame in \(Self.firstFrameTimeout)s")
      self.transition(.failed, reason: "no_first_frame")
    }
    firstFrameDeadline = work
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.firstFrameTimeout, execute: work)
  }

  private func cancelFirstFrameDeadline() {
    firstFrameDeadline?.cancel()
    firstFrameDeadline = nil
  }

  /// The one honest `.live`: a decoded frame is on its way to ACS.
  private func notePromotableFrame() {
    guard !firstFramePromoted, firstFrameGeneration == generation else { return }
    firstFramePromoted = true
    cancelFirstFrameDeadline()
    transition(.live, reason: "first_frame")
  }

  private func isCurrent(_ peerConnection: RTCPeerConnection) -> Bool {
    pc === peerConnection
  }

  /// Matches Android's FIRST_FRAME_TIMEOUT_MS: a measured answer → first frame
  /// gap is ~3 s, and a cold subscribe on a bad network is slower.
  private static let firstFrameTimeout: TimeInterval = 9
}

extension WhepVideoSource: RTCPeerConnectionDelegate {
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
    guard isCurrent(peerConnection) else { return }
    stream.videoTracks.first.map(attachVideo)
    stream.audioTracks.first.map(attachAudio)
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
  func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
    NSLog("ACS-SPIKE ICE \(newState.rawValue)")
    guard isCurrent(peerConnection) else { return }
    if newState == .failed || newState == .disconnected {
      transition(.failed, reason: newState == .failed ? "ice_failed" : "ice_disconnected")
    } else if newState == .connected || newState == .completed {
      // ICE can bounce disconnected → connected on its own; only act once the
      // answer has been applied. A recovered candidate pair is a promise of
      // frames, not a frame, so go back to `.connecting` and let the next one
      // promote — immediately if media was already flowing, and if nothing
      // arrives the rearmed deadline fails us again for the rebuild backoff.
      if state == .failed, offerPosted {
        transition(.connecting, reason: "ice_recovered")
        armFirstFrame(gen: generation)
      }
    }
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
    guard isCurrent(peerConnection) else { return }
    if newState == .complete { postOfferIfNeeded() }
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didStartReceivingOn transceiver: RTCRtpTransceiver) {
    guard isCurrent(peerConnection) else { return }
    if let video = transceiver.receiver.track as? RTCVideoTrack {
      attachVideo(video)
    }
    if let audio = transceiver.receiver.track as? RTCAudioTrack {
      attachAudio(audio)
    }
  }
}

extension WhepVideoSource: RTCVideoRenderer {
  func setSize(_ size: CGSize) {}
  func renderFrame(_ frame: RTCVideoFrame?) {
    guard let frame, let buffer = frame.buffer as? RTCCVPixelBuffer else { return }
    notePromotableFrame()
    frameCount += 1
    let now = Date()
    if now.timeIntervalSince(lastFpsLog) >= 1 {
      NSLog("ACS-SPIKE P3 video \(Int(frame.width))x\(Int(frame.height)) fps=\(frameCount)")
      frameCount = 0
      lastFpsLog = now
    }
    onFrame?(buffer.pixelBuffer)
  }
}

extension WhepVideoSource: RTCAudioRenderer {
  func render(pcmBuffer: AVAudioPCMBuffer) {
    guard pcmEnabled else { return }
    let channels = Int(pcmBuffer.format.channelCount)
    let rate = Int(pcmBuffer.format.sampleRate)
    guard let data = Self.pcm16(from: pcmBuffer) else { return }
    onPcm?(data, rate, channels)
  }
}

private extension WhepVideoSource {
  static func pcm16(from buffer: AVAudioPCMBuffer) -> Data? {
    let channels = Int(buffer.format.channelCount)
    let frames = Int(buffer.frameLength)
    if frames == 0 || channels == 0 { return nil }
    var data = Data(count: frames * channels * 2)
    if let int16 = buffer.int16ChannelData {
      data.withUnsafeMutableBytes { raw in
        let dest = raw.bindMemory(to: Int16.self)
        for frame in 0 ..< frames {
          for channel in 0 ..< channels {
            dest[frame * channels + channel] = int16[channel][frame]
          }
        }
      }
      return data
    }
    if let float = buffer.floatChannelData {
      data.withUnsafeMutableBytes { raw in
        let dest = raw.bindMemory(to: Int16.self)
        for frame in 0 ..< frames {
          for channel in 0 ..< channels {
            let sample = max(-1, min(1, float[channel][frame]))
            dest[frame * channels + channel] = Int16(sample * Float(Int16.max))
          }
        }
      }
      return data
    }
    return nil
  }
}

private extension RTCRtpTransceiverInit {
  static func recvOnly() -> RTCRtpTransceiverInit {
    let value = RTCRtpTransceiverInit()
    value.direction = .recvOnly
    return value
  }
}
