import AVFoundation
import CoreVideo
import Foundation
import WebRTC

/// Recvonly WHEP subscriber. Decoded frames become CVPixelBuffers for ACS.
/// Remote PCM is the P4 hard gate (RTCAudioRenderer on LiveKit/WebRTC-SDK 137).
final class WhepVideoSource: NSObject {
  var onFrame: ((CVPixelBuffer) -> Void)?
  var onPcm: ((Data, Int, Int) -> Void)?

  private var factory: RTCPeerConnectionFactory?
  private var pc: RTCPeerConnection?
  private var currentUrl: String?
  private var offerPosted = false
  private var pcmEnabled = true
  private var audioTracks: [RTCAudioTrack] = []
  private var frameCount = 0
  private var lastFpsLog = Date()

  func start(whepUrl: String) {
    stop()
    currentUrl = whepUrl
    offerPosted = false
    RTCInitializeSSL()
    let encoder = RTCDefaultVideoEncoderFactory()
    let decoder = RTCDefaultVideoDecoderFactory()
    factory = RTCPeerConnectionFactory(encoderFactory: encoder, decoderFactory: decoder)
    let config = RTCConfiguration()
    config.iceServers = [RTCIceServer(urlStrings: ["stun:stun.l.google.com:19302"])]
    let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
    guard let factory, let peer = factory.peerConnection(with: config, constraints: constraints, delegate: self) else {
      return
    }
    pc = peer
    peer.addTransceiver(of: .video, init: RTCRtpTransceiverInit.recvOnly())
    peer.addTransceiver(of: .audio, init: RTCRtpTransceiverInit.recvOnly())
    peer.offer(for: constraints) { sdp, error in
      guard let sdp, error == nil else { return }
      peer.setLocalDescription(sdp) { _ in
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
          self?.postOfferIfNeeded()
        }
      }
    }
  }

  func updateUrl(_ whepUrl: String) {
    if whepUrl == currentUrl { return }
    start(whepUrl: whepUrl)
  }

  func setPcmEnabled(_ enabled: Bool) {
    pcmEnabled = enabled
    audioTracks.forEach { $0.isEnabled = enabled }
    NSLog("ACS-SPIKE WHEP audio track enabled=\(enabled)")
  }

  func stop() {
    currentUrl = nil
    offerPosted = false
    pcmEnabled = true
    audioTracks.removeAll()
    pc?.close()
    pc = nil
  }

  private func attachAudio(_ track: RTCAudioTrack) {
    if !audioTracks.contains(where: { $0 === track }) {
      audioTracks.append(track)
    }
    track.isEnabled = pcmEnabled
    track.add(self as RTCAudioRenderer)
  }

  private func postOfferIfNeeded() {
    guard !offerPosted, let url = currentUrl, let peer = pc, let sdp = peer.localDescription?.sdp else { return }
    offerPosted = true
    postOffer(url: url, sdp: sdp, peer: peer)
  }

  private func postOffer(url: String, sdp: String, peer: RTCPeerConnection) {
    guard let endpoint = URL(string: url) else { return }
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.setValue("application/sdp", forHTTPHeaderField: "Content-Type")
    request.httpBody = sdp.data(using: .utf8)
    URLSession.shared.dataTask(with: request) { data, response, error in
      let code = (response as? HTTPURLResponse)?.statusCode ?? -1
      NSLog("ACS-SPIKE P3 WHEP \(code) answer bytes=\(data?.count ?? 0)")
      guard error == nil, let data, let answer = String(data: data, encoding: .utf8) else { return }
      let desc = RTCSessionDescription(type: .answer, sdp: answer)
      peer.setRemoteDescription(desc) { _ in }
    }.resume()
  }
}

extension WhepVideoSource: RTCPeerConnectionDelegate {
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
    stream.videoTracks.first?.add(self as RTCVideoRenderer)
    stream.audioTracks.first.map(attachAudio)
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
  func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
    NSLog("ACS-SPIKE ICE \(newState.rawValue)")
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
    if newState == .complete { postOfferIfNeeded() }
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didStartReceivingOn transceiver: RTCRtpTransceiver) {
    if let video = transceiver.receiver.track as? RTCVideoTrack {
      video.add(self as RTCVideoRenderer)
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
  func renderPCMBuffer(_ pcmBuffer: AVAudioPCMBuffer) {
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
