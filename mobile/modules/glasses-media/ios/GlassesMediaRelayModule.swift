import ExpoModulesCore
import Foundation

public final class GlassesMediaRelayModule: Module {
    private let queue = DispatchQueue(label: "com.mentra.glassesmedia.relay")
    private var session: ManagedRelaySession?

    public func definition() -> ModuleDefinition {
        Name("MentraGlassesMediaRelay")
        Events("onRelayState")

        OnCreate {
            // Temporary diagnostic PR: execute once in the normal signed Mac launch.
            // It does not change the network or product UI; this PR must not be merged.
            guard ProcessInfo.processInfo.isiOSAppOnMac else { return }
            let started = ProcessInfo.processInfo.systemUptime
            let output = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
                .appendingPathComponent("corewlan-readonly-probe.json")
            let persist: (String) -> Void = { facts in
                let value: [String: Any] = [
                    "schemaVersion": 1, "pid": ProcessInfo.processInfo.processIdentifier,
                    "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown",
                    "iosOnMac": true, "facts": facts,
                    "elapsedMs": (ProcessInfo.processInfo.systemUptime - started) * 1000,
                ]
                do {
                    guard let output else { throw CocoaError(.fileNoSuchFile) }
                    try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]).write(to: output, options: .atomic)
                    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
                } catch {
                    let error = error as NSError
                    NSLog("COREWLAN_READONLY result_write_failed domain=%@ code=%ld", error.domain, error.code)
                }
            }
            persist("state=entered")
            var finished = false
            let report: (String) -> Void = { facts in
                self.queue.async {
                    guard !finished else { return }
                    finished = true
                    persist(facts)
                }
            }
            self.queue.asyncAfter(deadline: .now() + 3) { report("state=timeout") }
            DispatchQueue.global(qos: .utility).async {
                // Documented public framework and selectors only. This probe never scans,
                // associates, requests permission or reads network identifiers.
                do {
                    guard let bundle = Bundle(path: "/System/Library/Frameworks/CoreWLAN.framework") else {
                        report("state=missing_bundle"); return
                    }
                    try bundle.loadAndReturnError()
                    guard let clientClass = NSClassFromString("CWWiFiClient") as? NSObject.Type,
                          clientClass.responds(to: NSSelectorFromString("sharedWiFiClient")),
                          let client = clientClass.perform(NSSelectorFromString("sharedWiFiClient"))?.takeUnretainedValue() as? NSObject,
                          client.responds(to: NSSelectorFromString("interface"))
                    else {
                        report("state=loaded public_client=0"); return
                    }
                    let interface = client.perform(NSSelectorFromString("interface"))?.takeUnretainedValue() as? NSObject
                    let canAssociate = interface?.responds(to: NSSelectorFromString("associateToNetwork:password:error:")) ?? false
                    report("state=loaded public_client=1 interface=\(interface == nil ? 0 : 1) association_selector=\(canAssociate ? 1 : 0)")
                } catch {
                    let error = error as NSError
                    let domain = error.domain.range(of: "^[A-Za-z0-9_.-]{1,128}$", options: .regularExpression) == nil ? "unavailable" : error.domain
                    report("state=load_failed domain=\(domain) code=\(error.code)")
                }
            }
        }

        AsyncFunction("prepare") { (options: [String: Any], promise: Promise) in
            guard let id = options["attemptId"] as? String,
                  let ingest = options["ingestUrl"] as? String, let url = URL(string: ingest), url.scheme == "https",
                  let ssid = options["ssid"] as? String, let password = options["password"] as? String,
                  let gateway = options["gatewayAddress"] as? String
            else {
                throw LocalMediaError("Invalid relay options")
            }
            self.queue.async {
                guard self.session == nil else { promise.reject(LocalMediaError("Previous relay has not stopped")); return }
                let session = ManagedRelaySession(id: id, queue: self.queue)
                self.session = session
                session.start(ssid: ssid, password: password, gateway: gateway, endpoint: url,
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

    func start(ssid: String, password: String, gateway: String, endpoint: URL, captureAudio: Bool, bitrate: Int,
               onState: @escaping (String, String) -> Void, completion: @escaping (Result<String, Error>) -> Void)
    {
        ready = completion
        hotspot.onLost = { reason in onState("failed", reason) }
        hotspot.onPermissionRequired = { [weak self] in
            self?.queue.async {
                guard let self, !self.stopped else { return }
                onState("permission_required", "Allow Local Network access to connect to your glasses. If you previously denied access, enable it in Settings, or cancel to return home.")
            }
        }
        hotspot.join(ssid: ssid, passphrase: password, gateway: gateway) { result in
            self.queue.async {
                guard !self.stopped else { return }
                switch result {
                case let .failure(error): self.finish(.failure(error))
                case let .success(address):
                    self.hotspot.awaitInternet { usable, _ in
                        self.queue.async {
                            guard !self.stopped else { return }
                            guard usable else { self.finish(.failure(LocalMediaError("Connect cellular or Ethernet internet to stream through the glasses hotspot"))); return }
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
        hotspot.onPermissionRequired = nil
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
