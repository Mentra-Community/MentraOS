import CoreLocation
import GoogleNavigation

// Mirrors Android's NavigationManager.kt: owns the GMSNavigator lifecycle,
// fans out events to CrustModule via the three typed callbacks, and handles
// T&C acceptance, simulation, and off-route detection.
final class NavigationManager: NSObject {
  static let shared = NavigationManager()

  typealias EventCallback = ([String: Any]) -> Void
  typealias LocationCallback = ([String: Any]) -> Void
  typealias RouteCallback = ([String: Any]) -> Void
  typealias StartCompletion = (Bool, String?) -> Void

  // Callbacks wired up by CrustModule and cleared on stop().
  private var onEvent: EventCallback?
  private var onLocation: LocationCallback?
  private var onRoute: RouteCallback?

  // GMSNavigator requires a GMSMapView. We keep a zero-frame off-screen view
  // purely to obtain the navigator — it is never added to any view hierarchy.
  private var mapView: GMSMapView?
  private var navigator: GMSNavigator?
  private var roadSnappedProvider: GMSRoadSnappedLocationProvider?

  // Off-route detection: emit once per off-route episode, reset on reroute.
  private static let offRouteThresholdMeters: Double = 30
  private var offRouteEmitted = false

  // Simulation polling: when GMSRoadSnappedLocationProvider doesn't fire
  // during simulation, fall back to polling mapView.myLocation.
  private var simTimer: Timer?
  private var isSimulating = false

  // MARK: - Permissions

  func requestPermission(completion: @escaping (Bool) -> Void) {
    DispatchQueue.main.async {
      let options = GMSNavigationTermsAndConditionsOptions(companyName: "Mentra")
      GMSNavigationServices.showTermsAndConditionsDialogIfNeeded(with: options) { accepted in
        completion(accepted)
      }
    }
  }

  // MARK: - Start

  func start(
    stops: [(lat: Double, lng: Double)],
    mode: String,
    simulate: Bool,
    speedMultiplier: Double,
    onEvent: @escaping EventCallback,
    onLocation: @escaping LocationCallback,
    onRoute: @escaping RouteCallback,
    completion: @escaping StartCompletion
  ) {
    self.onEvent = onEvent
    self.onLocation = onLocation
    self.onRoute = onRoute

    DispatchQueue.main.async { [weak self] in
      guard let self else { return }

      let camera = GMSCameraPosition(latitude: 0, longitude: 0, zoom: 1)
      let mapView = GMSMapView(frame: .zero, camera: camera)
      mapView.isNavigationEnabled = true
      self.mapView = mapView

      guard let nav = mapView.navigator else {
        completion(false, "Navigator unavailable — accept Terms & Conditions first")
        return
      }
      nav.add(self)
      nav.sendsBackgroundNotifications = false
      self.navigator = nav

      let provider = mapView.roadSnappedLocationProvider
      provider?.add(self)
      self.roadSnappedProvider = provider

      mapView.travelMode = self.gmsMode(from: mode)

      let waypoints = stops.compactMap {
        GMSNavigationWaypoint(
          location: CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lng),
          title: ""
        )
      }

      nav.setDestinations(waypoints) { [weak self] routeStatus in
        guard let self else { return }
        guard routeStatus == .OK else {
          completion(false, "Route calculation failed (status \(routeStatus.rawValue))")
          return
        }
        nav.isGuidanceActive = true
        nav.isVoiceInstructionsMuted = true

        if simulate {
          mapView.locationSimulator?.simulateLocationsAlongExistingRoute()
          if let sim = mapView.locationSimulator, speedMultiplier > 0 {
            sim.speedMultiplier = Float(speedMultiplier)
          }
          self.isSimulating = true
          self.startSimulationPolling()
        }

        // Emit the initial route.
        self.emitRoute()
        completion(true, nil)
      }
    }
  }

  // MARK: - Stop

  func stop() {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.stopSimulationPolling()
      self.isSimulating = false
      self.navigator?.isGuidanceActive = false
      self.navigator?.clearDestinations()
      if let nav = self.navigator { nav.remove(self) }
      self.roadSnappedProvider?.remove(self)
      self.navigator = nil
      self.roadSnappedProvider = nil
      self.mapView = nil
      self.onEvent = nil
      self.onLocation = nil
      self.onRoute = nil
      self.offRouteEmitted = false
    }
  }

  // MARK: - Simulate deviation (dev only)

  func simulateDeviation(offsetMeters: Double) {
    guard let sim = mapView?.locationSimulator else { return }
    sim.simulateLocation(at: CLLocationCoordinate2D(latitude: 0, longitude: offsetMeters / 111_320))
  }

  // MARK: - Simulation polling

  // GMSRoadSnappedLocationProvider may not fire during simulation on iOS.
  // Poll mapView.myLocation at 1Hz as a fallback so the miniapp map dot moves.
  private func startSimulationPolling() {
    guard simTimer == nil else { return }
    simTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
      guard let self, let mapView = self.mapView,
            let loc = mapView.myLocation else { return }
      self.onLocation?([
        "lat": loc.coordinate.latitude,
        "lng": loc.coordinate.longitude,
        "accuracy": loc.horizontalAccuracy,
        "timestamp": loc.timestamp.timeIntervalSince1970 * 1000,
      ])
    }
  }

  private func stopSimulationPolling() {
    simTimer?.invalidate()
    simTimer = nil
  }

  // MARK: - Helpers

  private func gmsMode(from mode: String) -> GMSNavigationTravelMode {
    switch mode {
    case "walking": return .walking
    case "cycling": return .cycling
    case "two_wheeler": return .twoWheeler
    default: return .driving
    }
  }

  private func emitRoute() {
    guard let path = navigator?.currentRouteLeg?.path else { return }
    onRoute?(["points": pathToPoints(path)])
  }
}

// MARK: - GMSNavigatorListener

extension NavigationManager: GMSNavigatorListener {

  func navigator(_ navigator: GMSNavigator, didArriveAt waypoint: GMSNavigationWaypoint) {
    onEvent?(["kind": "arrived"])
  }

  func navigatorDidChangeRoute(_ navigator: GMSNavigator) {
    offRouteEmitted = false
    emitRoute()
    onEvent?(["kind": "rerouting"])
  }

  func navigator(_ navigator: GMSNavigator, didUpdate navInfo: GMSNavigationNavInfo) {
    guard let step = navInfo.currentStep else { return }

    var payload: [String: Any] = [
      "kind": "maneuver",
      "maneuverType": maneuverString(step.maneuver),
      "distanceMeters": step.distanceFromPrevStepMeters,
      "distanceToDestinationMeters": navInfo.distanceToFinalDestinationMeters,
      "timeToDestinationSeconds": navInfo.timeToFinalDestinationSeconds,
      "fromRoad": step.fullRoadName,
    ]
    if let exitNum = step.exitNumber { payload["toRoad"] = exitNum }

    onEvent?(payload)
  }
}

// MARK: - GMSRoadSnappedLocationProviderListener

extension NavigationManager: GMSRoadSnappedLocationProviderListener {

  func locationProvider(
    _ locationProvider: GMSRoadSnappedLocationProvider,
    didUpdate location: CLLocation
  ) {
    onLocation?([
      "lat": location.coordinate.latitude,
      "lng": location.coordinate.longitude,
      "accuracy": location.horizontalAccuracy,
      "timestamp": location.timestamp.timeIntervalSince1970 * 1000,
    ])

    // Off-route detection: measure distance from current position to the route polyline.
    guard !offRouteEmitted,
          let path = navigator?.currentRouteLeg?.path,
          path.count() > 1
    else { return }

    let distanceToRoute = minDistanceToPath(path, from: location.coordinate)
    if distanceToRoute > Self.offRouteThresholdMeters {
      offRouteEmitted = true
      onEvent?([
        "kind": "off_route",
        "offRouteDistanceMeters": distanceToRoute,
      ])
    }
  }

  private func minDistanceToPath(_ path: GMSPath, from point: CLLocationCoordinate2D) -> Double {
    let count = path.count()
    guard count >= 2 else { return 0 }

    var minDist = Double.greatestFiniteMagnitude
    for i in 0..<(count - 1) {
      let a = path.coordinate(at: i)
      let b = path.coordinate(at: i + 1)
      let d = pointToSegmentDistance(point, segA: a, segB: b)
      if d < minDist { minDist = d }
    }
    return minDist
  }

  private func pointToSegmentDistance(
    _ p: CLLocationCoordinate2D,
    segA: CLLocationCoordinate2D,
    segB: CLLocationCoordinate2D
  ) -> Double {
    let metersPerDegLat: Double = 111_320
    let cosLat = cos(p.latitude * .pi / 180)
    let metersPerDegLng = metersPerDegLat * cosLat

    let px = (p.longitude - segA.longitude) * metersPerDegLng
    let py = (p.latitude - segA.latitude) * metersPerDegLat
    let dx = (segB.longitude - segA.longitude) * metersPerDegLng
    let dy = (segB.latitude - segA.latitude) * metersPerDegLat

    let lenSq = dx * dx + dy * dy
    guard lenSq > 0 else {
      return sqrt(px * px + py * py)
    }

    let t = max(0, min(1, (px * dx + py * dy) / lenSq))
    let nearX = px - t * dx
    let nearY = py - t * dy
    return sqrt(nearX * nearX + nearY * nearY)
  }
}
