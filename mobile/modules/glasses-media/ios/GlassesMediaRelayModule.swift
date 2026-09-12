import ExpoModulesCore
import Foundation

public final class GlassesMediaRelayModule: Module {
    private let queue = DispatchQueue(label: "com.mentra.glassesmedia.relay")
    private var session: ManagedRelaySession?

    public func definition() -> ModuleDefinition {
        Name("MentraGlassesMediaRelay")
        Events("onRelayState")

        AsyncFunction("prepare") { (options: [String: Any], promise: Promise) in
            guard let id = options["attemptId"] as? String,
                  let ingest = options["ingestUrl"] as? String, let url = URL(string: ingest), url.scheme == "https",
                  let ssid = options["ssid"] as? String, let password = options["password"] as? String
            else {
                throw LocalMediaError("Invalid relay options")
            }
            self.queue.async {
                guard self.session == nil else { promise.reject(LocalMediaError("Previous relay has not stopped")); return }
                let session = ManagedRelaySession(id: id, queue: self.queue)
                self.session = session
                session.start(ssid: ssid, password: password, endpoint: url,
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

        AsyncFunction("stop") { (id: String, promise: Promise) in
            self.queue.async {
                guard let session = self.session, session.id == id else { promise.resolve(nil); return }
                session.stop {
                    if self.session === session { self.session = nil }
                    promise.resolve(nil)
                }
            }
        }

        OnDestroy {
            self.queue.async {
                self.session?.stop { self.session = nil }
            }
        }
    }
}

/// Serialized owner of both native peers and the persistent hotspot join; no JS media callbacks.
private final class ManagedRelaySession {
    let id: String
    private let queue: DispatchQueue
    private let hotspot = GlassesHotspotNetwork()
    private var receiver: LocalWhipIngestSource?
    private var publisher: PhoneWhipPublisher?
    private var stopped = false
    private var stopFinished = false
    private var stopReplies: [() -> Void] = []
    private var ready: ((Result<String, Error>) -> Void)?

    init(id: String, queue: DispatchQueue) {
        self.id = id; self.queue = queue
    }

    func start(ssid: String, password: String, endpoint: URL, captureAudio: Bool, bitrate: Int,
               onState: @escaping (String, String) -> Void, completion: @escaping (Result<String, Error>) -> Void)
    {
        ready = completion
        hotspot.onLost = { reason in onState("failed", reason) }
        hotspot.join(ssid: ssid, passphrase: password) { result in
            self.queue.async {
                guard !self.stopped else { return }
                switch result {
                case let .failure(error): self.finish(.failure(error))
                case let .success(address):
                    self.hotspot.awaitInternet { usable, _ in
                        self.queue.async {
                            guard !self.stopped else { return }
                            guard usable else { self.finish(.failure(LocalMediaError("Turn on phone mobile data to stream through the glasses hotspot"))); return }
                            let publisher = PhoneWhipPublisher(endpoint: endpoint, captureAudio: captureAudio, bitrate: bitrate, onState: onState)
                            self.publisher = publisher
                            let receiver = LocalWhipIngestSource()
                            self.receiver = receiver
                            receiver.onFrame = { [weak publisher] in publisher?.onFrame($0) }
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
            }
        }
    }

    private func finish(_ result: Result<String, Error>) {
        let callback = ready; ready = nil; callback?(result)
    }

    func stop(completion: @escaping () -> Void) {
        if stopFinished { completion(); return }
        stopReplies.append(completion)
        guard !stopped else { return }
        stopped = true
        finish(.failure(LocalMediaError("Relay cancelled")))
        hotspot.onLost = nil
        let group = DispatchGroup()
        if let receiver {
            group.enter(); receiver.stop { group.leave() }
        }
        if let publisher {
            group.enter(); publisher.stop { group.leave() }
        }
        group.enter(); hotspot.leave { group.leave() }
        group.notify(queue: queue) {
            self.receiver = nil; self.publisher = nil; self.stopFinished = true
            let replies = self.stopReplies; self.stopReplies.removeAll(); replies.forEach { $0() }
        }
    }
}
