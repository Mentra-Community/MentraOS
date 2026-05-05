import CoreLocation

final class HeadingManager: NSObject, CLLocationManagerDelegate {
  static let shared = HeadingManager()

  typealias Callback = (Float) -> Void

  private var locationManager: CLLocationManager?
  private var callback: Callback?
  private var lastEmitted: Float = -1000
  private var started = false

  private static let minDelta: Float = 1.0

  func start(callback: @escaping Callback) {
    guard !started else { return }
    started = true
    self.callback = callback

    // CLLocationManager must be created and used on the main thread (needs a run loop).
    NSLog("[HeadingManager] start called — dispatching CLLocationManager init to main thread")
    DispatchQueue.main.async { [weak self] in
      guard let self, self.started else { return }
      let lm = CLLocationManager()
      lm.delegate = self
      lm.headingFilter = Double(Self.minDelta)
      self.locationManager = lm

      let status = lm.authorizationStatus
      NSLog("[HeadingManager] authorizationStatus=%d — %@", status.rawValue,
            status == .notDetermined ? "requesting auth" : "starting heading updates")
      if status == .notDetermined {
        lm.requestWhenInUseAuthorization()
      } else {
        lm.startUpdatingHeading()
      }
    }
  }

  func stop() {
    DispatchQueue.main.async { [weak self] in
      self?.locationManager?.stopUpdatingHeading()
      self?.locationManager = nil
    }
    callback = nil
    lastEmitted = -1000
    started = false
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    let status = manager.authorizationStatus
    NSLog("[HeadingManager] authorizationChanged status=%d", status.rawValue)
    if status == .authorizedWhenInUse || status == .authorizedAlways {
      NSLog("[HeadingManager] authorized — starting heading updates")
      manager.startUpdatingHeading()
    }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
    let raw = newHeading.magneticHeading
    let degrees = Float(raw)
    guard abs(angleDiff(degrees, lastEmitted)) >= Self.minDelta else { return }
    lastEmitted = degrees
    NSLog("[HeadingManager] heading=%.1f°", degrees)
    callback?(degrees)
  }

  private func angleDiff(_ a: Float, _ b: Float) -> Float {
    var d = (a - b).truncatingRemainder(dividingBy: 360)
    if d > 180 { d -= 360 }
    if d < -180 { d += 360 }
    return d
  }
}
