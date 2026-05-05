import CoreLocation

final class HeadingManager: NSObject, CLLocationManagerDelegate {
  static let shared = HeadingManager()

  typealias Callback = (Float) -> Void

  private var locationManager: CLLocationManager?
  private var callback: Callback?
  private var lastEmitted: Float = -1000

  private static let minDelta: Float = 1.0

  func start(callback: @escaping Callback) {
    guard self.callback == nil else { return }
    self.callback = callback

    let lm = CLLocationManager()
    lm.delegate = self
    lm.headingFilter = Double(Self.minDelta)
    lm.startUpdatingHeading()
    locationManager = lm
  }

  func stop() {
    locationManager?.stopUpdatingHeading()
    locationManager = nil
    callback = nil
    lastEmitted = -1000
  }

  func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
    // Use trueHeading when available (requires location); fall back to magneticHeading.
    let raw = newHeading.trueHeading >= 0 ? newHeading.trueHeading : newHeading.magneticHeading
    let degrees = Float(raw)
    guard abs(angleDiff(degrees, lastEmitted)) >= Self.minDelta else { return }
    lastEmitted = degrees
    callback?(degrees)
  }

  private func angleDiff(_ a: Float, _ b: Float) -> Float {
    var d = (a - b).truncatingRemainder(dividingBy: 360)
    if d > 180 { d -= 360 }
    if d < -180 { d += 360 }
    return d
  }
}
