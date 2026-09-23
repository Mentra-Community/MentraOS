import ExpoModulesCore
import Foundation

/// Native surface of the stream preview. One consumer; the host decides who may bind.
///
/// This module enforces the lifetimes (binding, document, production) and the build's ceilings:
/// diagnostics sources, modes and fault hooks are refused unless diagnostics are enabled, which
/// they are by default only in debug builds. iOS needs no native view handle because frames
/// travel over a loopback socket rather than through the WebView's own message port.
public final class FramePreviewModule: Module {
  private static let protocolVersion = 1

  private lazy var trace = PreviewTrace(sink: { [weak self] level, line in self?.emitLog(level, line) })
  private lazy var session = FramePreviewSession(trace: trace)
  private let stateLock = NSLock()
  private var boundPackage: String?
  private var document: (docGen: Int, token: String, url: String)?

  public func definition() -> ModuleDefinition {
    Name("MentraFramePreview")
    Events("onStatus", "onStopped", "onLog")

    OnCreate {
      #if DEBUG
        let debugBuild = true
      #else
        let debugBuild = false
      #endif
      self.session.setDiagnosticsEnabled(debugBuild)
      self.session.setRunLogEnabled(debugBuild)
      self.session.onStatus = { [weak self] status in self?.sendEvent("onStatus", status) }
      self.session.onStopped = { [weak self] reason, docGen in
        self?.sendEvent("onStopped", ["reason": reason, "docGen": docGen])
      }
    }

    AsyncFunction("bind") { (options: [String: Any], promise: Promise) in
      guard let package = options["packageName"] as? String else {
        promise.reject("invalid_argument", "packageName is required")
        return
      }
      if let traceId = options["traceId"] as? String { self.trace.traceId = traceId }
      self.stateLock.lock()
      self.boundPackage = package
      self.stateLock.unlock()
      self.trace.info("transport_bind", ["transport": "websocket", "reloadRequired": false])
      // The socket is created per document, so there is never a reason to reload on iOS.
      promise.resolve(["installReloadRequired": false])
    }

    AsyncFunction("prepareDocument") { (options: [String: Any], promise: Promise) in
      self.stateLock.lock()
      let bound = self.boundPackage != nil
      let cached = self.document
      self.stateLock.unlock()
      guard bound else {
        promise.reject("not_bound", "prepareDocument before bind")
        return
      }
      if let traceId = options["traceId"] as? String { self.trace.traceId = traceId }
      guard let docGen = (options["docGen"] as? NSNumber)?.intValue else {
        promise.reject("invalid_argument", "docGen is required")
        return
      }
      // Idempotent per document: a page that asks twice must not invalidate its own credit.
      if let cached, cached.docGen == docGen {
        promise.resolve(Self.documentPayload(docGen: docGen, token: cached.token, url: cached.url))
        return
      }
      let token = UUID().uuidString
      self.session.prepareDocument(token: token, docGen: docGen) { result in
        switch result {
        case let .success(url):
          self.stateLock.lock()
          self.document = (docGen, token, url)
          self.stateLock.unlock()
          promise.resolve(Self.documentPayload(docGen: docGen, token: token, url: url))
        case let .failure(error):
          promise.reject("transport_failed", "loopback listener failed: \(error.localizedDescription)")
        }
      }
    }

    AsyncFunction("configure") { (options: [String: Any], promise: Promise) in
      let config: PreviewConfig
      do {
        config = try PreviewConfig.parse(options)
      } catch let rejection as PreviewRejection {
        promise.reject(rejection.code, rejection.message)
        return
      } catch {
        promise.reject("invalid_argument", "\(error)")
        return
      }
      self.session.configure(config) { rejection in
        if let rejection {
          promise.reject(rejection.code, rejection.message)
        } else {
          promise.resolve(nil)
        }
      }
    }

    AsyncFunction("start") { (promise: Promise) in
      self.session.start()
      promise.resolve(nil)
    }

    AsyncFunction("stop") { (reason: String, promise: Promise) in
      self.session.stop(reason: reason)
      promise.resolve(nil)
    }

    AsyncFunction("unbind") { (reason: String, promise: Promise) in
      self.stateLock.lock()
      self.boundPackage = nil
      self.document = nil
      self.stateLock.unlock()
      self.session.teardown(reason: reason)
      promise.resolve(nil)
    }

    AsyncFunction("resetStats") { (promise: Promise) in
      self.session.resetStats()
      promise.resolve(nil)
    }

    AsyncFunction("runLogPath") { (promise: Promise) in
      promise.resolve(self.session.runLogPath)
    }

    AsyncFunction("setDiagnosticsEnabled") { (enabled: Bool, promise: Promise) in
      self.session.setDiagnosticsEnabled(enabled)
      promise.resolve(nil)
    }

    AsyncFunction("setTapTelemetry") { (enabled: Bool, promise: Promise) in
      self.session.setTapTelemetry(enabled)
      promise.resolve(nil)
    }

    AsyncFunction("setRunLogEnabled") { (enabled: Bool, promise: Promise) in
      self.session.setRunLogEnabled(enabled)
      promise.resolve(nil)
    }

    AsyncFunction("injectFault") { (options: [String: Any], promise: Promise) in
      guard let raw = options["kind"] as? String, let kind = PreviewFaultKind(rawValue: raw) else {
        promise.reject("invalid_argument", "unknown fault \(options["kind"] ?? "nil")")
        return
      }
      let ms = (options["ms"] as? NSNumber)?.intValue ?? 0
      self.session.injectFault(kind, ms: ms) { rejection in
        if let rejection {
          promise.reject(rejection.code, rejection.message)
        } else {
          promise.resolve(nil)
        }
      }
    }

    OnDestroy {
      self.session.teardown(reason: "destroy")
    }
  }

  private static func documentPayload(docGen: Int, token: String, url: String) -> [String: Any] {
    [
      "protocolVersion": protocolVersion,
      "transport": "websocket",
      "url": url,
      "token": token,
      "docGen": docGen,
    ]
  }

  private func emitLog(_ level: PreviewTrace.Level, _ line: String) {
    NSLog("%@", line)
    sendEvent("onLog", ["level": level.rawValue, "message": line])
  }
}
