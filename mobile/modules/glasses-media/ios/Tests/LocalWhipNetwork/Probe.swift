import Foundation
import WebRTC

@main enum ReceiverProbe {
    static let source = LocalWhipIngestSource()
    static var factory: RTCPeerConnectionFactory!
    static var sender: RTCPeerConnection!
    static var existingFactory: RTCPeerConnectionFactory!
    static var existingPeer: RTCPeerConnection!
    static var endpoint = ""
    static let address = ProcessInfo.processInfo.environment["WHIP_TEST_ADDRESS"]!
    static let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
    static func main() {
        RTCSetMinDebugLogLevel(.warning)
        // Match LiveKit's initialization order: enable the legacy global trial and create
        // a factory/peer before GlassesPeerFactory supplies its own M144 environment.
        RTCInitFieldTrialDictionary([kRTCFieldTrialUseNWPathMonitor: kRTCFieldTrialEnabledValue])
        RTCInitializeSSL()
        existingFactory = RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory(), audioDevice: ReceiveOnlyAudioDevice())
        existingPeer = existingFactory.peerConnection(with: RTCConfiguration(), constraints: constraints, delegate: nil)!
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
        postOffer(warmup: true)
    }

    static func postOffer(warmup: Bool) {
        var request = URLRequest(url: URL(string: endpoint)!)
        request.httpMethod = "POST"
        request.setValue("application/sdp", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(sender.localDescription!.sdp.utf8)
        URLSession.shared.dataTask(with: request) { data, response, error in
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            let result = code == 201 ? "OK" : (data.flatMap { String(data: $0, encoding: .utf8) } ?? String(describing: error))
            print("PROBE \(warmup ? "warmup" : "assertion") HTTP \(code): \(result)")
            let expected = ProcessInfo.processInfo.environment["WHIP_TEST_EXPECT_FAILURE"] == "1"
            // ObjCNetworkMonitor initially allows all interfaces until its asynchronous
            // first path update. Warm the receiver's shared network manager before the
            // assertion, so a fast first gathering cannot win that initialization race.
            // Reusing this receiver preserves the monitor's populated interface cache.
            if warmup, code == 201 || (expected && code == 500 && result.contains("Phone answer has no host ICE candidate")) {
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.25) {
                    if code == 201 { deleteWarmup(response as! HTTPURLResponse) }
                    else { postOffer(warmup: false) }
                }
                return
            }
            let passed = expected
                ? code == 500 && result.contains("Phone answer has no host ICE candidate")
                : code == 201 && (data.flatMap { String(data: $0, encoding: .utf8) }?.contains(address) == true)
            sender.close()
            existingPeer.close()
            source.stop { finish(passed ? "PASS stop complete" : "FAIL negotiation", passed ? 0 : 1) }
        }.resume()
    }

    static func deleteWarmup(_ response: HTTPURLResponse) {
        guard let location = response.value(forHTTPHeaderField: "Location"),
              let url = URL(string: location, relativeTo: URL(string: endpoint)) else { finish("FAIL warmup Location missing", 1); return }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        URLSession.shared.dataTask(with: request) { _, response, error in
            guard (response as? HTTPURLResponse)?.statusCode == 204, error == nil else { finish("FAIL warmup DELETE", 1); return }
            postOffer(warmup: false)
        }.resume()
    }

    static func finish(_ message: String, _ status: Int32) {
        print(message); fflush(stdout); exit(status)
    }
}
