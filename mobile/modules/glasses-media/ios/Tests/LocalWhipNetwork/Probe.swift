import Foundation
import WebRTC

@main enum ReceiverProbe {
    static let source = LocalWhipIngestSource()
    static var factory: RTCPeerConnectionFactory!
    static var sender: RTCPeerConnection!
    static var endpoint = ""
    static let address = ProcessInfo.processInfo.environment["WHIP_TEST_ADDRESS"]!
    static let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
    static func main() {
        RTCSetMinDebugLogLevel(.warning)
        RTCInitFieldTrialDictionary([kRTCFieldTrialUseNWPathMonitor: kRTCFieldTrialEnabledValue])
        source.onStateChange = { state, reason in print("SOURCE \(state): \(reason)") }
        source.prepare(config: SourceConfig(url: "", kind: .softap, bindAddress: address)) { result in
            switch result {
            case let .failure(error): finish("prepare: \(error)", 1)
            case let .success(url): endpoint = url; makeOffer()
            }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + 20) { finish("timeout", 2) }
        dispatchMain()
    }

    static func makeOffer() {
        factory = RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory(), audioDevice: ReceiveOnlyAudioDevice())
        let config = RTCConfiguration()
        config.sdpSemantics = .unifiedPlan
        sender = factory.peerConnection(with: config, constraints: constraints, delegate: nil)!
        let sendOnly = RTCRtpTransceiverInit()
        sendOnly.direction = .sendOnly
        sender.addTransceiver(with: factory.videoTrack(with: factory.videoSource(), trackId: "video"), init: sendOnly)
        sender.addTransceiver(with: factory.audioTrack(with: factory.audioSource(with: constraints), trackId: "audio"), init: sendOnly)
        sender.offer(for: constraints) { offer, error in
            guard let offer, error == nil else { finish("offer: \(String(describing: error))", 1); return }
            sender.setLocalDescription(offer) { error in
                guard error == nil else { finish("setLocal: \(String(describing: error))", 1); return }
                postWhenGathered()
            }
        }
    }

    static func postWhenGathered() {
        guard sender.iceGatheringState == .complete else {
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.05) { postWhenGathered() }
            return
        }
        guard sender.localDescription!.sdp.contains(address) else { finish("FAIL sender has no local candidate", 1); return }
        if let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "enableMissingWifiPath") {
            unsafeBitCast(symbol, to: (@convention(c) () -> Void).self)()
            print("PROBE default internet path now omits Wi-Fi")
        } else { finish("FAIL network shim missing", 1); return }
        print("PROBE offer has hotspot candidate: \(sender.localDescription!.sdp.contains(address))")
        var request = URLRequest(url: URL(string: endpoint)!)
        request.httpMethod = "POST"
        request.setValue("application/sdp", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(sender.localDescription!.sdp.utf8)
        URLSession.shared.dataTask(with: request) { data, response, error in
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            let result = code == 201 ? "OK" : (data.flatMap { String(data: $0, encoding: .utf8) } ?? String(describing: error))
            print("PROBE HTTP \(code): \(result)")
            let expected = ProcessInfo.processInfo.environment["WHIP_TEST_EXPECT_FAILURE"] == "1"
            let passed = expected
                ? code == 500 && result.contains("Phone answer has no host ICE candidate")
                : code == 201 && (data.flatMap { String(data: $0, encoding: .utf8) }?.contains(address) == true)
            sender.close()
            source.stop { finish(passed ? "PASS stop complete" : "FAIL negotiation", passed ? 0 : 1) }
        }.resume()
    }

    static func finish(_ message: String, _ status: Int32) {
        print(message); fflush(stdout); exit(status)
    }
}
