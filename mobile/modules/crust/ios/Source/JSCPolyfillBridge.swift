//
//  JSCPolyfillBridge.swift
//  MentraJS — native handlers for the browser-flavoured polyfills that
//  can't be implemented in pure JS (fetch, WebSocket).
//
//  Built-in JS shims (console, timers, localStorage, crypto.randomUUID)
//  live in JSCDispatcher.swift because they're small synchronous routes
//  that the dispatcher serves inline. The async networking surfaces here
//  warrant their own file: each request opens a URLSession task that
//  outlives the originating __dispatch call, so the handler must return
//  .async and schedule a dispatchToJs callback when the task finishes.
//

import Foundation
import os.log

/// Hooks the network polyfill routes into a JSCDispatcher. Call once on
/// host boot, after the dispatcher is created. Idempotent.
public enum JSCPolyfillBridge {
    /// Single URLSession shared by fetch (closure-based dataTasks) and
    /// WebSocket (delegate-driven). Apple's URLSession supports mixing:
    /// dataTasks with completion handlers bypass the delegate for data
    /// callbacks, while WebSocket-specific delegate methods still fire
    /// for `webSocketTask(with:)`. One session = one connection pool =
    /// one place to configure TLS, proxies, timeouts.
    ///
    /// The delegate is required so we fire JS-side `open` only after the
    /// server has accepted the handshake (matches RFC 6455 + the browser
    /// WebSocket spec). Without it, onopen could fire before the server
    /// has actually upgraded.
    private static let session: URLSession = URLSession(
        configuration: .default,
        delegate: WebSocketSessionDelegate.shared,
        delegateQueue: nil,
    )

    fileprivate final class WebSocketSessionDelegate: NSObject, URLSessionWebSocketDelegate {
        static let shared = WebSocketSessionDelegate()

        func urlSession(
            _ session: URLSession,
            webSocketTask: URLSessionWebSocketTask,
            didOpenWithProtocol protocol_: String?,
        ) {
            // Look up the wrapper for this task and fire the JS-side open.
            JSCPolyfillBridge.socketsLock.lock()
            let wrapper = JSCPolyfillBridge.sockets.values.first { $0.task === webSocketTask }
            JSCPolyfillBridge.socketsLock.unlock()
            guard let wrapper else { return }
            var payload: [String: Any] = [:]
            if let proto = protocol_, !proto.isEmpty {
                payload["protocol"] = proto
            }
            JSCPolyfillBridge.deliverWebSocketEvent(
                packageName: wrapper.packageName,
                sid: wrapper.sid,
                wsType: "open",
                payload: payload,
            )
        }

        func urlSession(
            _ session: URLSession,
            webSocketTask: URLSessionWebSocketTask,
            didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
            reason: Data?,
        ) {
            JSCPolyfillBridge.socketsLock.lock()
            let wrapper = JSCPolyfillBridge.sockets.values.first { $0.task === webSocketTask }
            JSCPolyfillBridge.socketsLock.unlock()
            guard let wrapper else { return }
            if wrapper.closedSent { return }
            wrapper.closedSent = true
            let reasonStr = reason.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            JSCPolyfillBridge.deliverWebSocketEvent(
                packageName: wrapper.packageName,
                sid: wrapper.sid,
                wsType: "close",
                payload: ["code": closeCode.rawValue, "reason": reasonStr],
            )
            JSCPolyfillBridge.dropSocket(sid: wrapper.sid)
        }
    }
    private static let log = OSLog(subsystem: "com.mentra.mentra", category: "MentraJS.fetch")

    public static func install(into dispatcher: JSCDispatcher) {
        installFetch(dispatcher)
        installWebSocket(dispatcher)
    }

    private static func installFetch(_ dispatcher: JSCDispatcher) {
        dispatcher.register(iface: "fetch", method: "request") { packageName, args, reqId in
            guard let req = args.first as? [String: Any],
                  let urlString = req["url"] as? String,
                  let url = URL(string: urlString) else {
                return .error(code: "INVALID_ARGS", message: "fetch.request expects {url, method, headers, body}")
            }
            guard let reqId else {
                return .error(code: "INVALID_ARGS", message: "fetch.request requires reqId (use __mentraSendRequest)")
            }

            var urlRequest = URLRequest(url: url)
            urlRequest.httpMethod = (req["method"] as? String) ?? "GET"
            if let headers = req["headers"] as? [String: Any] {
                for (k, v) in headers {
                    urlRequest.setValue(String(describing: v), forHTTPHeaderField: k)
                }
            }
            if let body = req["body"] as? String, !body.isEmpty {
                urlRequest.httpBody = body.data(using: .utf8)
            }

            // Reasonable defaults — caller can override later by passing
            // {timeoutMs} in the request shape, but the polyfill doesn't
            // surface that yet.
            urlRequest.timeoutInterval = 60

            let task = session.dataTask(with: urlRequest) { data, response, error in
                if let error {
                    let payload: [String: Any] = [
                        "kind": "response",
                        "reqId": reqId,
                        "ok": false,
                        "error": [
                            "code": "NATIVE_THROW",
                            "message": "fetch: \(error.localizedDescription)",
                        ],
                    ]
                    JSCRuntime.shared.dispatchToJs(packageName: packageName, envelope: payload)
                    return
                }
                let http = response as? HTTPURLResponse
                let status = http?.statusCode ?? 0
                let headersDict: [String: String] = {
                    guard let http else { return [:] }
                    var out: [String: String] = [:]
                    for (k, v) in http.allHeaderFields {
                        if let ks = k as? String, let vs = v as? String {
                            out[ks.lowercased()] = vs
                        }
                    }
                    return out
                }()
                let bodyStr: String = {
                    guard let data else { return "" }
                    return String(data: data, encoding: .utf8) ?? ""
                }()
                let payload: [String: Any] = [
                    "kind": "response",
                    "reqId": reqId,
                    "ok": true,
                    "result": [
                        "status": status,
                        "statusText": HTTPURLResponse.localizedString(forStatusCode: status),
                        "headers": headersDict,
                        "body": bodyStr,
                        "ok": (200..<300).contains(status),
                    ] as [String: Any],
                ]
                JSCRuntime.shared.dispatchToJs(packageName: packageName, envelope: payload)
            }
            task.resume()
            return .async
        }
    }

    // MARK: - WebSocket

    /// Per-sid map of active socket tasks. The wrapper holds the
    /// URLSessionWebSocketTask and pumps inbound frames back via __deliver.
    private static var sockets: [String: WebSocketTaskWrapper] = [:]
    private static let socketsLock = NSLock()

    private final class WebSocketTaskWrapper {
        let sid: String
        let packageName: String
        let task: URLSessionWebSocketTask
        var closedSent = false

        init(sid: String, packageName: String, request: URLRequest, session: URLSession) {
            self.sid = sid
            self.packageName = packageName
            self.task = session.webSocketTask(with: request)
        }

        func resume() {
            task.resume()
            readNext()
        }

        func send(text: String, completion: @escaping (Error?) -> Void) {
            task.send(.string(text), completionHandler: completion)
        }

        func send(binary: Data, completion: @escaping (Error?) -> Void) {
            task.send(.data(binary), completionHandler: completion)
        }

        func close(code: URLSessionWebSocketTask.CloseCode, reason: String?) {
            let data = reason?.data(using: .utf8)
            task.cancel(with: code, reason: data)
        }

        private func readNext() {
            task.receive { [weak self] result in
                guard let self else { return }
                switch result {
                case .success(let msg):
                    switch msg {
                    case .string(let text):
                        JSCPolyfillBridge.deliverWebSocketEvent(
                            packageName: self.packageName,
                            sid: self.sid,
                            wsType: "message",
                            payload: ["kind": "text", "data": text],
                        )
                    case .data(let data):
                        let b64 = data.base64EncodedString()
                        JSCPolyfillBridge.deliverWebSocketEvent(
                            packageName: self.packageName,
                            sid: self.sid,
                            wsType: "message",
                            payload: ["kind": "binary", "data": b64],
                        )
                    @unknown default:
                        break
                    }
                    self.readNext()
                case .failure(let error):
                    JSCPolyfillBridge.deliverWebSocketEvent(
                        packageName: self.packageName,
                        sid: self.sid,
                        wsType: "error",
                        payload: ["message": error.localizedDescription],
                    )
                    if !self.closedSent {
                        self.closedSent = true
                        JSCPolyfillBridge.deliverWebSocketEvent(
                            packageName: self.packageName,
                            sid: self.sid,
                            wsType: "close",
                            payload: ["code": 1006, "reason": error.localizedDescription],
                        )
                        JSCPolyfillBridge.dropSocket(sid: self.sid)
                    }
                }
            }
        }
    }

    private static func installWebSocket(_ dispatcher: JSCDispatcher) {
        dispatcher.register(iface: "ws", method: "open") { packageName, args, _ in
            guard let req = args.first as? [String: Any],
                  let sid = req["sid"] as? String,
                  let urlString = req["url"] as? String,
                  let url = URL(string: urlString) else {
                return .error(code: "INVALID_ARGS", message: "ws.open expects {sid, url, protocols?}")
            }
            var urlRequest = URLRequest(url: url)
            if let protocols = req["protocols"] as? [String], !protocols.isEmpty {
                urlRequest.setValue(protocols.joined(separator: ", "), forHTTPHeaderField: "Sec-WebSocket-Protocol")
            }
            let wrapper = WebSocketTaskWrapper(
                sid: sid,
                packageName: packageName,
                request: urlRequest,
                session: session,
            )
            socketsLock.lock()
            sockets[sid] = wrapper
            socketsLock.unlock()
            wrapper.resume()
            // `open` is fired by the URLSessionWebSocketDelegate's
            // didOpenWithProtocol callback once the server has accepted
            // the handshake — not synthesized here. JS code that calls
            // send() before that fires is queued internally by
            // URLSessionWebSocketTask (it's safe to call pre-open).
            return .sync(NSNull())
        }

        dispatcher.register(iface: "ws", method: "send") { _, args, _ in
            guard let req = args.first as? [String: Any],
                  let sid = req["sid"] as? String,
                  let kind = req["kind"] as? String,
                  let payload = req["payload"] as? String else {
                return .error(code: "INVALID_ARGS", message: "ws.send expects {sid, kind, payload}")
            }
            socketsLock.lock()
            let wrapper = sockets[sid]
            socketsLock.unlock()
            guard let wrapper else {
                return .error(code: "INVALID_ARGS", message: "ws.send: unknown sid")
            }
            let pkg = wrapper.packageName
            if kind == "text" {
                wrapper.send(text: payload) { error in
                    if let error {
                        JSCPolyfillBridge.deliverWebSocketEvent(
                            packageName: pkg,
                            sid: sid,
                            wsType: "error",
                            payload: ["message": error.localizedDescription],
                        )
                    }
                }
            } else if kind == "binary" {
                guard let data = Data(base64Encoded: payload) else {
                    return .error(code: "INVALID_ARGS", message: "ws.send: bad base64")
                }
                wrapper.send(binary: data) { error in
                    if let error {
                        JSCPolyfillBridge.deliverWebSocketEvent(
                            packageName: pkg,
                            sid: sid,
                            wsType: "error",
                            payload: ["message": error.localizedDescription],
                        )
                    }
                }
            } else {
                return .error(code: "INVALID_ARGS", message: "ws.send: kind must be text|binary")
            }
            return .sync(NSNull())
        }

        dispatcher.register(iface: "ws", method: "close") { _, args, _ in
            guard let req = args.first as? [String: Any],
                  let sid = req["sid"] as? String else {
                return .error(code: "INVALID_ARGS", message: "ws.close expects {sid, code?, reason?}")
            }
            socketsLock.lock()
            let wrapper = sockets[sid]
            socketsLock.unlock()
            guard let wrapper else {
                return .sync(NSNull())
            }
            let rawCode = (req["code"] as? Int) ?? 1000
            let code = URLSessionWebSocketTask.CloseCode(rawValue: rawCode) ?? .goingAway
            wrapper.close(code: code, reason: req["reason"] as? String)
            if !wrapper.closedSent {
                wrapper.closedSent = true
                JSCPolyfillBridge.deliverWebSocketEvent(
                    packageName: wrapper.packageName,
                    sid: sid,
                    wsType: "close",
                    payload: ["code": rawCode, "reason": (req["reason"] as? String) ?? ""],
                )
                socketsLock.lock()
                sockets[sid] = nil
                socketsLock.unlock()
            }
            return .sync(NSNull())
        }
    }

    /// Push a ws-event envelope to the JS side. The polyfill bundle's
    /// __deliver dispatches kind="ws-event" to the matching socket.
    fileprivate static func deliverWebSocketEvent(
        packageName: String,
        sid: String,
        wsType: String,
        payload: [String: Any],
    ) {
        let envelope: [String: Any] = [
            "kind": "ws-event",
            "sid": sid,
            "wsType": wsType,
            "payload": payload,
        ]
        JSCRuntime.shared.dispatchToJs(packageName: packageName, envelope: envelope)
    }

    fileprivate static func dropSocket(sid: String) {
        socketsLock.lock()
        sockets[sid] = nil
        socketsLock.unlock()
    }
}
