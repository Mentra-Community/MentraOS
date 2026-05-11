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

  // Pivot enrichment: when emitRoute() fires before the first NavInfo
  // tick, we don't yet have step metadata (road / maneuver per step).
  // We cache the latest NavInfo's `remainingSteps` here as they arrive,
  // and re-emit the route with steps folded in the first time they
  // become available after a route change. Cleared on every new route.
  private var latestStepsPayload: [[String: Any]]? = nil
  private var lastEmittedPoints: [[String: Double]]? = nil
  private var pendingRouteReEmit: Bool = false

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
      // Enable full voice guidance (turn-by-turn announcements + alerts).
      nav.voiceGuidance = .alertsAndGuidance
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
      self.latestStepsPayload = nil
      self.lastEmittedPoints = nil
      self.pendingRouteReEmit = false
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
    let points = pathToPoints(path)
    // Reset cached state — this is a fresh route, any stale steps
    // from a previous route are now wrong.
    lastEmittedPoints = points
    // Build steps from latest NavInfo cache if we have them; otherwise
    // mark for re-emit when the first NavInfo arrives.
    var payload: [String: Any] = ["points": points]
    if let steps = buildStepsForRoute(points: points) {
      payload["steps"] = steps
      pendingRouteReEmit = false
    } else {
      pendingRouteReEmit = true
    }
    onRoute?(payload)
  }

  /**
   * Re-attach polyline indices to the cached NavInfo step list. Each
   * step's coordinate is matched to the closest polyline vertex so the
   * SDK consumer can correlate steps with geometry. Returns nil when
   * we don't have a cached step list yet — the caller registers for a
   * re-emit when NavInfo first delivers one.
   */
  private func buildStepsForRoute(points: [[String: Double]]) -> [[String: Any]]? {
    guard let raw = latestStepsPayload, !raw.isEmpty, !points.isEmpty else { return nil }
    var out: [[String: Any]] = []
    out.reserveCapacity(raw.count)
    for step in raw {
      guard let lat = step["lat"] as? Double, let lng = step["lng"] as? Double else { continue }
      let idx = closestPolylineIndex(in: points, lat: lat, lng: lng)
      var enriched = step
      enriched["routeIndex"] = idx
      out.append(enriched)
    }
    return out.isEmpty ? nil : out
  }

  /**
   * Index of the polyline vertex closest to `(lat, lng)`. Linear scan
   * — step lists are short and routes have at most a few hundred
   * vertices, so a spatial index isn't worth the complexity.
   */
  private func closestPolylineIndex(in points: [[String: Double]], lat: Double, lng: Double) -> Int {
    var best = 0
    var bestD = Double.greatestFiniteMagnitude
    for (i, p) in points.enumerated() {
      let plat = p["lat"] ?? 0
      let plng = p["lng"] ?? 0
      let dx = plat - lat
      let dy = plng - lng
      let d = dx * dx + dy * dy
      if d < bestD {
        bestD = d
        best = i
      }
    }
    return best
  }

  /**
   * Capture the latest NavInfo's current + remaining steps into a
   * wire-shaped cache. Each step's lat/lng is derived by walking the
   * polyline using `distanceFromPrevStepMeters` as a cumulative offset
   * — this avoids depending on undocumented SDK position accessors
   * that vary by SDK version. Called from the `didUpdate navInfo:`
   * listener on every NavInfo tick.
   */
  private func captureStepsFromNavInfo(_ navInfo: GMSNavigationNavInfo) {
    // Without a polyline we can't anchor steps. Defer until route lands.
    guard let points = lastEmittedPoints, !points.isEmpty else {
      return
    }
    // Combine currentStep + remainingSteps into one ordered list. The
    // current step always starts at the user's position relative to
    // the polyline, but we approximate as polyline[0] for simplicity —
    // the SDK consumer's pivot extractor matches by proximity to the
    // closest polyline vertex anyway, so a few-meters offset on the
    // start doesn't change which pivot a step is paired with.
    var orderedSteps: [(road: String?, maneuver: String, distance: Int)] = []
    if let current = navInfo.currentStep {
      orderedSteps.append((
        road: current.simpleRoadName?.nonBlank ?? current.fullRoadName?.nonBlank,
        maneuver: maneuverString(current.maneuver),
        distance: Int(current.distanceFromPrevStepMeters),
      ))
    }
    if let remaining = navInfo.remainingSteps {
      for step in remaining {
        orderedSteps.append((
          road: step.simpleRoadName?.nonBlank ?? step.fullRoadName?.nonBlank,
          maneuver: maneuverString(step.maneuver),
          distance: Int(step.distanceFromPrevStepMeters),
        ))
      }
    }
    if orderedSteps.isEmpty {
      latestStepsPayload = nil
      return
    }

    // Walk the polyline accumulating distance; for each step, find the
    // polyline vertex closest to the running cumulative offset and use
    // its coords as the step's start.
    let stepStarts = stepStartCoordinates(points: points, stepDistances: orderedSteps.map { $0.distance })

    var list: [[String: Any]] = []
    list.reserveCapacity(orderedSteps.count)
    for (i, s) in orderedSteps.enumerated() {
      let coord = stepStarts[i]
      var entry: [String: Any] = [
        "lat": coord.lat,
        "lng": coord.lng,
        "maneuver": s.maneuver,
        "distanceMeters": s.distance,
      ]
      if let r = s.road { entry["road"] = r }
      list.append(entry)
    }
    latestStepsPayload = list

    // If a previous `emitRoute()` ran before we had steps, re-emit now
    // that the metadata is available. Pivot enrichment in the SDK
    // consumer rebuilds atomically per onRoute event, so a second
    // emission with the same polyline + fresh steps is correct.
    if pendingRouteReEmit, let points = lastEmittedPoints {
      pendingRouteReEmit = false
      var payload: [String: Any] = ["points": points]
      if let steps = buildStepsForRoute(points: points) {
        payload["steps"] = steps
      }
      onRoute?(payload)
    }
  }

  /**
   * Walk the polyline accumulating segment distances; for each step,
   * find the polyline vertex whose cumulative distance is closest to
   * the running step-offset. Returns the (lat, lng) for each step's
   * start point. First step is always the polyline's first point.
   */
  private func stepStartCoordinates(points: [[String: Double]], stepDistances: [Int]) -> [(lat: Double, lng: Double)] {
    var result: [(lat: Double, lng: Double)] = []
    result.reserveCapacity(stepDistances.count)
    guard !points.isEmpty else { return result }

    // Cumulative meters from polyline[0] to each vertex.
    var cumulative: [Double] = [0]
    cumulative.reserveCapacity(points.count)
    for i in 1..<points.count {
      let a = points[i - 1]
      let b = points[i]
      let alat = a["lat"] ?? 0, alng = a["lng"] ?? 0
      let blat = b["lat"] ?? 0, blng = b["lng"] ?? 0
      cumulative.append(cumulative[i - 1] + haversineMeters(aLat: alat, aLng: alng, bLat: blat, bLng: blng))
    }

    var runningOffset: Double = 0
    for (i, dist) in stepDistances.enumerated() {
      if i == 0 {
        // First step starts at polyline[0].
        let p = points[0]
        result.append((lat: p["lat"] ?? 0, lng: p["lng"] ?? 0))
      } else {
        runningOffset += Double(stepDistances[i - 1])
        let idx = closestCumulativeIndex(cumulative: cumulative, target: runningOffset)
        let p = points[idx]
        result.append((lat: p["lat"] ?? 0, lng: p["lng"] ?? 0))
      }
      _ = dist // silence unused warning; we use the offset on the next iteration
    }
    return result
  }

  /** Polyline vertex index whose cumulative distance is closest to `target`. */
  private func closestCumulativeIndex(cumulative: [Double], target: Double) -> Int {
    var best = 0
    var bestD = Double.greatestFiniteMagnitude
    for (i, c) in cumulative.enumerated() {
      let d = abs(c - target)
      if d < bestD {
        bestD = d
        best = i
      }
    }
    return best
  }

  /** Great-circle distance in meters between two lat/lng pairs. */
  private func haversineMeters(aLat: Double, aLng: Double, bLat: Double, bLng: Double) -> Double {
    let R = 6_371_000.0
    let toRad = Double.pi / 180.0
    let dLat = (bLat - aLat) * toRad
    let dLng = (bLng - aLng) * toRad
    let lat1 = aLat * toRad
    let lat2 = bLat * toRad
    let s1 = sin(dLat / 2)
    let s2 = sin(dLng / 2)
    let x = s1 * s1 + s2 * s2 * cos(lat1) * cos(lat2)
    return 2 * R * asin(min(1.0, sqrt(x)))
  }
}

private extension String {
  var nonBlank: String? {
    let t = self.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.isEmpty ? nil : t
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
    // Capture the step list for pivot enrichment on every tick. Side-
    // effect: if a route was emitted before the first NavInfo, this
    // also triggers a re-emit with the steps folded in.
    captureStepsFromNavInfo(navInfo)

    guard let step = navInfo.currentStep else { return }

    // remainingSteps[0] is the road the user will be on AFTER the
    // upcoming maneuver — this is what the miniapp UI shows as the
    // "next street" headline. simpleRoadName falls back to
    // fullRoadName when Google leaves the simple variant blank.
    let nextStep = navInfo.remainingSteps?.first
    let nextStepRoad: String? = {
      let candidates: [String?] = [nextStep?.simpleRoadName, nextStep?.fullRoadName]
      for c in candidates {
        if let s = c?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
          return s
        }
      }
      return nil
    }()

    var payload: [String: Any] = [
      "kind": "maneuver",
      "maneuverType": maneuverString(step.maneuver),
      "distanceMeters": step.distanceFromPrevStepMeters,
      "distanceToDestinationMeters": navInfo.distanceToFinalDestinationMeters,
      "timeToDestinationSeconds": navInfo.timeToFinalDestinationSeconds,
      "fromRoad": step.fullRoadName,
    ]
    if let exitNum = step.exitNumber { payload["toRoad"] = exitNum }
    if let nsr = nextStepRoad { payload["nextStepRoad"] = nsr }

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
