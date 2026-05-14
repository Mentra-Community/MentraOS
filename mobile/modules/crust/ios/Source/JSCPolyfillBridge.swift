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
    /// Shared URLSession — uses default config so we get the usual HTTP/2,
    /// connection reuse, TLS cache. A custom delegate would let us
    /// intercept redirect / auth challenges; for v1 the default works.
    private static let session: URLSession = URLSession(configuration: .default)
    private static let log = OSLog(subsystem: "com.mentra.mentra", category: "MentraJS.fetch")

    public static func install(into dispatcher: JSCDispatcher) {
        installFetch(dispatcher)
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
}
