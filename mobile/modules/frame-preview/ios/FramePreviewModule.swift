import ExpoModulesCore
import Foundation

/// Experiment surface for the raw-frame preview. One consumer, host-gated.
///
/// The host decides who may bind (the Mentra Call miniapp, in a development build); this module
/// only enforces that there is exactly one subscription and that its lifetime is explicit. iOS
/// needs no native view handle because the frames travel over a loopback socket rather than
/// through the WebView's own message port.
public final class FramePreviewModule: Module {
  private let session = FramePreviewSession()
  private var boundPackage: String?

  public func definition() -> ModuleDefinition {
    Name("MentraFramePreview")
    Events("onStatus", "onStopped")

    OnCreate {
      self.session.onStatus = { [weak self] status in self?.sendEvent("onStatus", status) }
      self.session.onStopped = { [weak self] reason in self?.sendEvent("onStopped", ["reason": reason]) }
    }

    AsyncFunction("bind") { (options: [String: Any], promise: Promise) in
      guard let package = options["packageName"] as? String else {
        promise.reject(FramePreviewError("packageName is required")); return
      }
      self.boundPackage = package
      promise.resolve([
        "supported": true,
        "transport": "websocket",
        // The socket is created per document, so there is no page-level installation step and
        // never a reason to reload the WebView on iOS.
        "listenerInstalled": true,
        "installReloadRequired": false,
      ])
    }

    AsyncFunction("prepareDocument") { (options: [String: Any], promise: Promise) in
      guard self.boundPackage != nil else {
        promise.reject(FramePreviewError("prepareDocument before bind")); return
      }
      let token = UUID().uuidString
      let documentGeneration = (options["docGen"] as? NSNumber)?.intValue ?? 0
      self.session.prepareDocument(token: token) { result in
        switch result {
        case var .success(payload):
          payload["token"] = token
          payload["docGen"] = documentGeneration
          promise.resolve(payload)
        case let .failure(error):
          promise.reject(FramePreviewError("loopback listener failed: \(error.localizedDescription)"))
        }
      }
    }

    AsyncFunction("configure") { (options: [String: Any], promise: Promise) in
      self.session.configure(options)
      promise.resolve(nil)
    }

    AsyncFunction("start") { (promise: Promise) in
      self.session.start()
      promise.resolve(nil)
    }

    AsyncFunction("stop") { (reason: String?, promise: Promise) in
      self.session.stop(reason: reason ?? "host")
      promise.resolve(nil)
    }

    AsyncFunction("resetStats") { (promise: Promise) in
      self.session.resetStats()
      promise.resolve(nil)
    }

    AsyncFunction("unbind") { (promise: Promise) in
      self.boundPackage = nil
      self.session.teardown(reason: "unbind")
      promise.resolve(nil)
    }

    OnDestroy {
      self.session.teardown(reason: "destroy")
    }
  }
}

struct FramePreviewError: Error, LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}
