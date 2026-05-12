import ExpoModulesCore

public class MentraDirectReceiverModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MentraDirectReceiver")

    Events("photoUpload", "receiverStatus", "streamFirstFrame")

    AsyncFunction("isSupported") {
      false
    }

    AsyncFunction("startPhotoReceiver") { () -> [String: Any] in
      throw UnsupportedDirectReceiverError()
    }

    AsyncFunction("stopPhotoReceiver") {
    }

    AsyncFunction("startWebRtcReceiver") { () -> [String: Any] in
      throw UnsupportedDirectReceiverError()
    }

    AsyncFunction("stopWebRtcReceiver") {
    }

    View(MentraDirectReceiverView.self) {
    }
  }
}

final class UnsupportedDirectReceiverError: Exception {
  override var reason: String {
    "The React Native example direct receiver is implemented on Android for now."
  }
}
