import ExpoModulesCore
import Foundation
import OSLog

private let permissionLog = Logger(subsystem: "com.mentra.mentra", category: "Permission")

public final class GlassesMediaRelayModule: Module {
    private let queue = DispatchQueue(label: "com.mentra.glassesmedia.relay")
    private var session: ManagedRelaySession?
    private let localHotspot = GlassesHotspotNetwork.shared
    private var localHotspotOwner: String?

    public func definition() -> ModuleDefinition {
        Name("MentraGlassesMediaRelay")
        Events("onRelayState", "onLocalHotspotPermissionRequired", "onLocalHotspotLost", "onNativeLog")

        OnCreate {
            MediaLog.sink = { [weak self] message in self?.sendEvent("onNativeLog", ["message": message]) }
        }

        // The app's `[Permission]` lines, readable in the unified log: NSLog and the JS console are not.
        Function("logPermission") { (line: String) in
            permissionLog.notice("\(line, privacy: .public)")
        }

        AsyncFunction("joinLocalHotspot") { (id: String, ssid: String, password: String, gateway: String?, purpose: String, frequency: Int?, promise: Promise) in
            self.queue.async {
                guard self.localHotspotOwner == nil else {
                    promise.reject(LocalMediaError("Previous hotspot session has not been released")); return
                }
                guard let accessPurpose = HotspotAccessPurpose(rawValue: purpose) else {
                    promise.reject(LocalMediaError("Invalid hotspot access purpose")); return
                }
                self.localHotspotOwner = id
                // The join waits while Local Network access is pending or denied; the caller explains it.
                self.localHotspot.onPermissionRequired = { [weak self] systemAnswer in
                    self?.sendEvent("onLocalHotspotPermissionRequired", ["id": id, "systemAnswer": systemAnswer])
                }
                self.localHotspot.onLost = { [weak self] reason in
                    self?.sendEvent("onLocalHotspotLost", ["id": id, "reason": reason])
                }
                self.localHotspot.join(ssid: ssid, passphrase: password, gateway: gateway, frequency: frequency, purpose: accessPurpose) { result in
                    switch result {
                    case let .success(address): promise.resolve(address)
                    case let .failure(error):
                        let failure = HotspotJoinFailure(error)
                        promise.reject(Exception(name: "HotspotJoinFailure", description: failure.message, code: failure.code))
                    }
                }
            }
        }

        AsyncFunction("leaveLocalHotspot") { (id: String, promise: Promise) in
            self.queue.async {
                guard self.localHotspotOwner == id else { promise.resolve(nil); return }
                self.localHotspot.leave { result in
                    self.queue.async {
                        switch result {
                        case .success:
                            if self.localHotspotOwner == id { self.localHotspotOwner = nil }
                            promise.resolve(nil)
                        case let .failure(error): promise.reject(error)
                        }
                    }
                }
            }
        }

        AsyncFunction("prepare") { (options: [String: Any], promise: Promise) in
            guard let id = options["attemptId"] as? String,
                  let ingest = options["ingestUrl"] as? String, let url = URL(string: ingest), url.scheme == "https",
                  let address = options["bindAddress"] as? String
            else {
                throw LocalMediaError("Invalid relay options")
            }
            self.queue.async {
                guard self.session == nil else { promise.reject(LocalMediaError("Previous relay has not stopped")); return }
                let session = ManagedRelaySession(id: id, queue: self.queue, hotspot: self.localHotspot)
                self.session = session
                session.start(address: address, endpoint: url,
                              captureAudio: options["captureAudio"] as? Bool ?? true,
                              bitrate: options["bitrate"] as? Int ?? 2_000_000,
                              onState: { [weak self] state, reason in
                                  self?.sendEvent("onRelayState", ["attemptId": id, "state": state, "reason": reason])
                              }) { result in
                    switch result {
                    case let .success(url): promise.resolve(url)
                    case let .failure(error): promise.reject(error)
                    }
                }
            }
        }

        // Milliseconds since this phone last decoded a glasses frame, or -1. Covers ACS calls
        // too: they decode through the same receivers.
        Function("streamFrameAgeMs") { () -> Double in
            StreamFrameGrab.shared.frameAgeMs()
        }

        AsyncFunction("grabStreamFrame") { (options: [String: Any], promise: Promise) in
            let quality = min(max((options["quality"] as? NSNumber)?.doubleValue ?? 90, 1), 100)
            let timeoutMs = min(max((options["timeoutMs"] as? NSNumber)?.intValue ?? 1500, 100), 5000)
            StreamFrameGrab.shared.grab(quality: quality / 100, timeoutMs: timeoutMs) { result in
                switch result {
                case let .success(frame):
                    promise.resolve([
                        "base64": frame.jpeg.base64EncodedString(),
                        "width": frame.width,
                        "height": frame.height,
                        "bytes": frame.jpeg.count,
                    ])
                case let .failure(error):
                    promise.reject("STREAM_FRAME_UNAVAILABLE", error.reason)
                }
            }
        }

        AsyncFunction("stop") { (id: String, promise: Promise) in
            self.queue.async {
                guard let session = self.session, session.id == id else { promise.resolve(nil); return }
                session.stop { result in
                    switch result {
                    case .success:
                        if self.session === session { self.session = nil }
                        promise.resolve(nil)
                    case let .failure(error): promise.reject(error)
                    }
                }
            }
        }

        OnDestroy {
            MediaLog.sink = nil
            self.queue.async {
                self.session?.stop { result in
                    if case .success = result { self.session = nil }
                }
                self.localHotspot.leave { _ in }
            }
        }
    }
}

/// Serialized owner of both native peers on the glasses network the service joined; no JS media callbacks.
private final class ManagedRelaySession {
    let id: String
    private let queue: DispatchQueue
    private let hotspot: GlassesHotspotNetwork
    private var receiver: LocalWhipIngestSource?
    private var publisher: PhoneWhipPublisher?
    private var stopped = false
    private var stopFinished = false
    private var stopReplies: [(Result<Void, Error>) -> Void] = []
    private var ready: ((Result<String, Error>) -> Void)?

    init(id: String, queue: DispatchQueue, hotspot: GlassesHotspotNetwork) {
        self.id = id; self.queue = queue; self.hotspot = hotspot
    }

    func start(address: String, endpoint: URL, captureAudio: Bool, bitrate: Int,
               onState: @escaping (String, String) -> Void, completion: @escaping (Result<String, Error>) -> Void)
    {
        ready = completion
        hotspot.verifiedAddress { verified in
            self.queue.async {
                guard !self.stopped else { return }
                guard verified == address else {
                    self.finish(.failure(LocalMediaError("The glasses hotspot address changed before the relay started"))); return
                }
                // Internet traffic uses the phone's default network, whatever it is.
                let publisher = PhoneWhipPublisher(endpoint: endpoint, captureAudio: captureAudio, bitrate: bitrate, onState: onState)
                self.publisher = publisher
                let receiver = LocalWhipIngestSource()
                self.receiver = receiver
                // The publisher takes the frame first. The phone's own preview of the
                // stream is a guest: it reads the pixels this relay already decoded, so
                // showing the wearer their video downloads nothing.
                receiver.onFrame = { [weak publisher] buffer in
                    DecodedFrameTap.shared.relay(buffer) { publisher?.onFrame($0) }
                }
                receiver.onPcm = { [weak publisher] in publisher?.onPcm($0, rate: $1, channels: $2) }
                receiver.onStateChange = { state, reason in if state == .failed { onState("failed", "Glasses receiver: \(reason)") } }
                receiver.setPcmDeliveryEnabled(captureAudio)
                receiver.prepare(config: SourceConfig(url: "", kind: .softap, bindAddress: address)) { result in
                    self.queue.async {
                        guard !self.stopped else { return }
                        if case .success = result { publisher.start() }
                        self.finish(result)
                    }
                }
            }
        }
    }

    private func finish(_ result: Result<String, Error>) {
        let callback = ready; ready = nil; callback?(result)
    }

    func stop(completion: @escaping (Result<Void, Error>) -> Void) {
        if stopFinished { completion(.success(())); return }
        let stopping = !stopReplies.isEmpty
        stopReplies.append(completion)
        guard !stopping else { return }
        stopped = true
        finish(.failure(LocalMediaError("Relay cancelled")))
        let group = DispatchGroup()
        if let receiver {
            group.enter(); receiver.stop { group.leave() }
        }
        if let publisher {
            group.enter(); publisher.stop { group.leave() }
        }
        group.notify(queue: queue) {
            self.receiver = nil; self.publisher = nil
            self.stopFinished = true
            let replies = self.stopReplies; self.stopReplies.removeAll(); replies.forEach { $0(.success(())) }
        }
    }
}
