import ExpoModulesCore
import UIKit

class MentraDirectReceiverView: ExpoView {
  private var hostedVideoView: UIView?

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    backgroundColor = .black
    DirectReceiverViewRegistry.shared.register(self)
  }

  deinit {
    DirectReceiverViewRegistry.shared.unregister(self)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    hostedVideoView?.frame = bounds
  }

  func setVideoView(_ videoView: UIView?) {
    hostedVideoView?.removeFromSuperview()
    hostedVideoView = videoView

    guard let videoView else {
      return
    }

    videoView.frame = bounds
    videoView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(videoView)
  }
}

final class DirectReceiverViewRegistry {
  static let shared = DirectReceiverViewRegistry()

  private let views = NSHashTable<MentraDirectReceiverView>.weakObjects()
  private weak var videoView: UIView?

  private init() {}

  func register(_ view: MentraDirectReceiverView) {
    onMain {
      self.views.add(view)
      view.setVideoView(self.videoView)
    }
  }

  func unregister(_ view: MentraDirectReceiverView) {
    onMain {
      self.views.remove(view)
    }
  }

  func setVideoView(_ videoView: UIView) {
    DispatchQueue.main.async {
      self.videoView = videoView
      self.views.allObjects.last?.setVideoView(videoView)
    }
  }

  func clear() {
    DispatchQueue.main.async {
      self.videoView = nil
      for view in self.views.allObjects {
        view.setVideoView(nil)
      }
    }
  }

  private func onMain(_ operation: @escaping () -> Void) {
    if Thread.isMainThread {
      operation()
    } else {
      DispatchQueue.main.sync(execute: operation)
    }
  }
}
