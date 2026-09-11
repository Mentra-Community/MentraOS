import Combine
import CoreLocation
import Foundation
import MapboxDirections
import MapboxNavigationCore

/// NavigationManager (iOS)
///
/// Singleton wrapper around the **Mapbox Navigation SDK v3 for iOS** (migrated
/// from the Google Navigation SDK). Mirrors the Android
/// `NavigationManager.kt`: owns the `MapboxNavigation` lifecycle, subscribes to
/// the Combine publishers (route progress, location, arrival, rerouting), and
/// fans out the SAME coarse callbacks the Google version exposed to
/// `CrustModule`.
///
/// ## Contract (UNCHANGED from the Google implementation)
///
/// The public surface — `start` / `stop` / `requestPermission` /
/// `simulateDeviation`, plus the `onEvent` / `onLocation` / `onRoute` payload
/// shapes — is identical to the Google version, so `CrustModule.swift` and
/// everything above it (the `@mentra/miniapp` SDK) does not change.
///
/// ## iOS-vs-Android API differences (why this isn't a line-for-line port)
///
/// - iOS v3 is **Combine publisher-based**, not observer-based. We hold
///   `AnyCancellable`s instead of registering observer objects.
/// - Routing is `async`: `routingProvider().calculateRoutes(options:)`.
/// - Simulation is a **CoreConfig location source** (`.simulation`), chosen at
///   provider-construction time — not a separate replay session object. Because
///   the source is fixed when the provider is built, switching sim on/off
///   rebuilds the provider (see `makeProvider`).
/// - Mapbox owns off-route detection + auto-reroute on iOS too, same as
///   Android — we observe, we don't re-derive.
///
/// VERIFY-IN-XCODE markers flag the few exact field/case/method names that the
/// (auth-gated) v3 docs didn't let me confirm. Everything else is from the
/// official v3 examples.
// @MainActor: the Mapbox Navigation v3 API surface (MapboxNavigation,
// NavigationController, SessionController, the routeProgress/locationMatching
// publishers) is main-actor-isolated. All our Mapbox access already happens on
// the main thread (we dispatch to DispatchQueue.main in start/stop), so marking
// the whole manager @MainActor aligns the compiler with the actual runtime
// threading and removes the "main actor-isolated … from a nonisolated context"
// errors. CrustModule calls these from AsyncFunctions, which await across the
// boundary cleanly.
@MainActor
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

  // The Mapbox engine. Rebuilt per-trip because the location source
  // (live vs simulation) is baked into CoreConfig at construction time.
  private var provider: MapboxNavigationProvider?
  private var mapboxNavigation: MapboxNavigation? { provider?.mapboxNavigation }

  // Combine subscriptions — torn down on stop().
  private var cancellables = Set<AnyCancellable>()

  // First-fix gate. Mapbox has no synchronous "current location" getter; the
  // device position arrives only via the locationMatching publisher AFTER the
  // session starts. So we start the session, capture the first fix, THEN
  // request the route from that real origin. Mirrors Android's
  // `pendingRouteRequest`. nil once fired (one-shot).
  private var pendingRouteRequest: ((_ originLat: Double, _ originLng: Double) -> Void)?

  // Per-trip config captured from start().
  private var tripStops: [(lat: Double, lng: Double)] = []
  private var travelMode: String = "driving"
  private var simulating: Bool = false
  private var simulationSpeed: Double = 1.0

  // Dedup the maneuver emission to ~1m granularity (matches Android's
  // emitManeuverIfChanged so the "In X m" countdown updates ~1 Hz and stays in
  // lockstep with the trip distance). Key = "type|distM|tripM".
  private var lastEmittedManeuverKey: String?

  // Arrival is reported once; the SDK keeps ticking COMPLETE afterwards.
  private var arrivedHandled = false
  // Off-route emitted once per episode (reset on reroute), same as Android.
  private var offRouteEmitted = false
  // The navigationRoutes publisher fires once with the INITIAL route (already
  // emitted by requestAndStartRoute). We skip that first emission and treat
  // every subsequent one as a reroute redraw. false until the first fires.
  private var didEmitInitialRoute = false

  // Last two forwarded coords — the Deviate dev walker derives its bearing
  // from prev→last so the user keeps moving in *their* direction of travel.
  private var lastReportedCoord: CLLocationCoordinate2D?
  private var prevReportedCoord: CLLocationCoordinate2D?
  private var deviateTimer: Timer?
  private let DEVIATE_DURATION_S: Double = 10.0

  // MARK: - Permissions

  /// Mapbox needs no Terms & Conditions dialog (that was Google-specific).
  /// Resolve immediately with `true` so the JS permission gate passes —
  /// mirrors Android `ensureTermsAccepted`, which is a no-op on Mapbox.
  /// (Location authorization itself is handled by the standard iOS prompts
  /// driven from the NSLocation* Info.plist usage strings + CoreLocation.)
  func requestPermission(completion: @escaping (Bool) -> Void) {
    completion(true)
  }

  // MARK: - Start

  func start(
    stops: [(lat: Double, lng: Double)],
    mode: String,
    simulate: Bool,
    speedMultiplier: Double,
    missedTurnRerouteMeters: Double? = nil,
    onEvent: @escaping EventCallback,
    onLocation: @escaping LocationCallback,
    onRoute: @escaping RouteCallback,
    completion: @escaping StartCompletion
  ) {
    // Clean baseline — like Android's start() calling stop() first.
    stopInternal()

    guard !stops.isEmpty else {
      completion(false, "at least one stop is required")
      return
    }

    self.onEvent = onEvent
    self.onLocation = onLocation
    self.onRoute = onRoute
    self.tripStops = stops
    self.travelMode = mode
    self.simulating = simulate
    self.simulationSpeed = max(0.5, min(speedMultiplier, 50))
    self.arrivedHandled = false
    self.offRouteEmitted = false
    self.didEmitInitialRoute = false
    self.lastEmittedManeuverKey = nil
    // (missedTurnRerouteMeters is intentionally unused on the Mapbox path —
    // Mapbox owns reroute natively, same decision as Android. Kept in the
    // signature for contract parity with CrustModule.)
    _ = missedTurnRerouteMeters

    DispatchQueue.main.async { [weak self] in
      guard let self else { return }

      // Build the provider with the right location source. Simulation is a
      // CoreConfig choice; `.simulation` drives a synthetic puck along the
      // active route once one is set.
      let provider = self.makeProvider(simulate: simulate)
      self.provider = provider

      // `mapboxNavigation` is non-optional on the provider.
      let nav = provider.mapboxNavigation

      // Subscribe to the publishers BEFORE starting the session so we don't
      // miss the first ticks.
      self.subscribe(nav)

      // Start a free-drive (passive) session so location starts flowing; the
      // first fix satisfies the gate below, then we request the route and
      // switch to active guidance.
      // VERIFY-IN-XCODE: free-drive start method name. v3 examples show
      // `nav.tripSession().startFreeDrive()`.
      nav.tripSession().startFreeDrive()

      // First-fix gate: request the route from the device's real origin.
      self.pendingRouteRequest = { [weak self] originLat, originLng in
        self?.requestAndStartRoute(
          nav: nav,
          originLat: originLat,
          originLng: originLng,
          completion: completion
        )
      }

      // First-fix TIMEOUT (live AND sim). The gate above waits for Mapbox's
      // locationMatching publisher to emit the first fix before requesting the
      // route. On a COLD APP LAUNCH that first fix can be slow or never arrive
      // until the CLLocationManager fully spins up — which is exactly the
      // "first nav after launch hangs at Starting…, works on the 2nd try" bug
      // (the 2nd try has a warm location manager). So we ALWAYS arm a timeout:
      // if no fix satisfies the gate in time, request the route from a one-shot
      // CoreLocation fix / last known location so we never hang.
      self.armFirstFixTimeout(nav: nav, completion: completion)
    }
  }

  /// Build a fresh MapboxNavigationProvider. `.simulation` vs `.live` is fixed
  /// at construction, which is why a sim toggle rebuilds the provider.
  private func makeProvider(simulate: Bool) -> MapboxNavigationProvider {
    // Explicit reroute config: native off-route detection + auto-reroute ON
    // (this is the SDK default — detectsReroute defaults to true — but we set it
    // explicitly so the intent is visible and can't silently regress). The
    // navigator runs this off-route check continuously while in active guidance.
    let routingConfig = RoutingConfig(
      rerouteConfig: RerouteConfig(detectsReroute: true)
    )
    let coreConfig = CoreConfig(
      routingConfig: routingConfig,
      locationSource: simulate ? .simulation(initialLocation: nil) : .live
    )
    return MapboxNavigationProvider(coreConfig: coreConfig)
  }

  /// Subscribe to route progress, location, arrival, and reroute publishers.
  private func subscribe(_ nav: MapboxNavigation) {
    let navigation = nav.navigation()

    // Location stream. `MapMatchingState` carries BOTH the raw GPS fix
    // (`.location`) and the snapped/map-matched fix (`.enhancedLocation`). We
    // forward the RAW location for the phone puck so that when the user
    // physically diverges from the route, the puck visibly leaves the line
    // (matching Android, which reports raw GPS). Using `.enhancedLocation` here
    // was the bug: it snaps the puck onto the route, hiding all divergence.
    // This is also our first-fix gate trigger.
    navigation.locationMatching
      .sink { [weak self] matched in
        let r = matched.mapMatchingResult
        print(String(format: "[NavMgr] loc raw=(%.6f,%.6f) offRoad=%@ offRoadProb=%.2f",
                     matched.location.coordinate.latitude,
                     matched.location.coordinate.longitude,
                     r.isOffRoad ? "YES" : "no",
                     r.offRoadProbability))
        self?.handleLocation(matched.location, isOffRoad: r.isOffRoad)
      }
      .store(in: &cancellables)

    // Route progress — drives the maneuver card + arrival.
    // VERIFY-IN-XCODE: `.routeProgress` publisher emits `RouteProgress?`
    // (v3 examples map `\.?.routeProgress`). Unwrap before use.
    navigation.routeProgress
      .sink { [weak self] progressState in
        guard let progress = progressState?.routeProgress else { return }
        self?.handleRouteProgress(progress)
      }
      .store(in: &cancellables)

    // Rerouting — Mapbox detects off-route and fetches a new route NATIVELY
    // (same as Android; we observe, we don't re-derive). `rerouting` is an
    // event publisher of `ReroutingStatus`, whose `.event` is one of
    // `.FetchingRoute` / `.Fetched` / `.Failed` / `.Interrupted`. We emit the
    // "rerouting" event when the fetch begins so the glasses show the
    // "Rerouting…" HUD + the phone shows the toast.
    navigation.rerouting
      .sink { [weak self] status in
        guard let self else { return }
        print("[NavMgr] rerouting event: \(type(of: status.event))")
        switch status.event {
        case is ReroutingStatus.Events.FetchingRoute:
          // A new route fetch has started — tell JS we're rerouting. The actual
          // new polyline arrives via the navigationRoutes publisher below.
          self.lastEmittedManeuverKey = nil
          self.onEvent?(["kind": "rerouting"])
        case is ReroutingStatus.Events.Failed:
          self.onEvent?(["kind": "error", "message": "reroute failed"])
        default:
          // .Fetched / .Interrupted — the route update is delivered separately.
          break
        }
      }
      .store(in: &cancellables)

    // Arrival — the authoritative signal is the waypoints-arrival publisher
    // (final destination), not a distance threshold. Emit `arrived` once.
    navigation.waypointsArrival
      .sink { [weak self] status in
        guard let self else { return }
        if status.event is WaypointArrivalStatus.Events.ToFinalDestination {
          if !self.arrivedHandled {
            self.arrivedHandled = true
            self.onEvent?(["kind": "arrived"])
          }
        }
      }
      .store(in: &cancellables)

    // Route updates — `navigationRoutes` emits the active NavigationRoutes
    // whenever they change: the initial route, AND every reroute. We skip the
    // very first emission (that's the initial route, already emitted by
    // requestAndStartRoute) and treat every subsequent non-nil emission as a
    // reroute: reset the maneuver dedup and re-emit the new polyline so the
    // phone map + glasses redraw it. This is the RoutesObserver-equivalent and
    // is the reliable redraw signal.
    nav.tripSession().navigationRoutes
      .sink { [weak self] routes in
        guard let self, let routes else { return }
        if !self.didEmitInitialRoute {
          // First emission is the initial route — requestAndStartRoute already
          // emitted it; just record that we've seen it.
          self.didEmitInitialRoute = true
          return
        }
        // Subsequent emission = reroute. Redraw.
        self.lastEmittedManeuverKey = nil
        self.emitRoute(routes)
      }
      .store(in: &cancellables)
  }

  /// Safety net for the first-fix gate. The gate fires when Mapbox's
  /// locationMatching emits the first fix; this fallback fires if that's slow
  /// (cold-launch) or never comes. It retries a few times — on a cold start the
  /// CLLocationManager populates `.location` within a second or two of starting
  /// updates — and once it has any origin (Mapbox fix, our keep-alive manager,
  /// or a fresh CLLocationManager) it requests the route from it. Only bails
  /// with an error after exhausting all retries with no location at all.
  private func armFirstFixTimeout(
    nav: MapboxNavigation,
    completion: @escaping StartCompletion,
    attempt: Int = 0
  ) {
    let maxAttempts = 8        // ~8 × 0.75s ≈ 6s total before giving up
    let interval: TimeInterval = 0.75
    DispatchQueue.main.asyncAfter(deadline: .now() + interval) { [weak self] in
      guard let self else { return }
      // Gate already fired (a real fix arrived) — nothing to do.
      guard let pending = self.pendingRouteRequest else { return }

      // Try every origin source we have, freshest first.
      let origin = self.lastReportedCoord
        ?? CLLocationManager().location?.coordinate

      if let origin {
        print("[NavMgr] first-fix timeout fallback fired (attempt \(attempt)) — requesting route from last-known origin")
        self.pendingRouteRequest = nil
        pending(origin.latitude, origin.longitude)
        return
      }

      // No location yet — keep retrying until we run out of attempts.
      if attempt + 1 < maxAttempts {
        self.armFirstFixTimeout(nav: nav, completion: completion, attempt: attempt + 1)
      } else {
        print("[NavMgr] first-fix timeout — no location after \(maxAttempts) attempts, giving up")
        self.pendingRouteRequest = nil
        completion(false, "no location fix to start navigation")
      }
    }
  }

  /// Build NavigationRouteOptions from origin + stops, request the route,
  /// set it, switch to active guidance, and emit it. Mirrors Android's
  /// `requestAndStartRoute`.
  private func requestAndStartRoute(
    nav: MapboxNavigation,
    originLat: Double,
    originLng: Double,
    completion: @escaping StartCompletion
  ) {
    var waypoints: [Waypoint] = []
    waypoints.append(Waypoint(coordinate: CLLocationCoordinate2D(latitude: originLat, longitude: originLng)))
    for stop in tripStops {
      waypoints.append(Waypoint(coordinate: CLLocationCoordinate2D(latitude: stop.lat, longitude: stop.lng)))
    }

    // VERIFY-IN-XCODE: NavigationRouteOptions init + profileIdentifier param.
    let options = NavigationRouteOptions(
      waypoints: waypoints,
      profileIdentifier: profileFor(travelMode)
    )

    // VERIFY-IN-XCODE: `routingProvider().calculateRoutes(options:)` returns a
    // Task whose `.result` is `Result<NavigationRoutes, Error>` (v3 example).
    let task = nav.routingProvider().calculateRoutes(options: options)
    Task { [weak self] in
      guard let self else { return }
      switch await task.result {
      case .success(let navigationRoutes):
        await MainActor.run {
          // v3 SessionController: startActiveGuidance(with:startLegIndex:).
          // Off-route detection + auto-reroute only run in ACTIVE GUIDANCE — so
          // this call (not the earlier free-drive) is what arms rerouting.
          print("[NavMgr] startActiveGuidance — \(navigationRoutes.mainRoute.route.legs.count) legs, profile=\(self.travelMode)")
          nav.tripSession().startActiveGuidance(with: navigationRoutes, startLegIndex: 0)
          self.emitRoute(navigationRoutes)
          completion(true, nil)
        }
      case .failure(let error):
        await MainActor.run {
          completion(false, "route request failed: \(error.localizedDescription)")
        }
      }
    }
  }

  /// SDK-agnostic mode string → Mapbox Directions profile. Google's
  /// `two_wheeler` has no Mapbox equivalent → driving (migration doc #3).
  private func profileFor(_ mode: String) -> ProfileIdentifier {
    switch mode.lowercased() {
    case "walking": return .walking
    case "cycling": return .cycling
    case "two_wheeler": return .automobile
    case "driving": return .automobileAvoidingTraffic
    default: return .automobileAvoidingTraffic
    }
  }

  // MARK: - Stop

  func stop() {
    DispatchQueue.main.async { [weak self] in
      self?.stopInternal()
    }
  }

  private func stopInternal() {
    deviateTimer?.invalidate()
    deviateTimer = nil
    cancellables.forEach { $0.cancel() }
    cancellables.removeAll()
    // Trip-session stop: SessionController.setToIdle(). `mapboxNavigation` is
    // non-optional, so only `provider?` carries the optional chain.
    provider?.mapboxNavigation.tripSession().setToIdle()
    provider = nil
    onEvent = nil
    onLocation = nil
    onRoute = nil
    pendingRouteRequest = nil
    tripStops = []
    arrivedHandled = false
    offRouteEmitted = false
    didEmitInitialRoute = false
    lastEmittedManeuverKey = nil
    lastReportedCoord = nil
    prevReportedCoord = nil
  }

  // MARK: - Location handling

  private func handleLocation(_ location: CLLocation, isOffRoad: Bool = false) {
    let coord = location.coordinate

    // First-fix gate: fire the deferred route request once.
    if let pending = pendingRouteRequest {
      pendingRouteRequest = nil
      pending(coord.latitude, coord.longitude)
    }

    prevReportedCoord = lastReportedCoord
    lastReportedCoord = coord

    onLocation?([
      "lat": coord.latitude,
      "lng": coord.longitude,
      "accuracy": location.horizontalAccuracy,
      "timestamp": location.timestamp.timeIntervalSince1970 * 1000,
    ])
    // Off-route DETECTION + auto-reroute is fully owned by Mapbox (see the
    // `rerouting` publisher in subscribe()) — no hand-rolled perpendicular
    // distance check here, matching Android. `isOffRoad` is the map-matcher's
    // own opinion; currently informational (the reroute publisher drives the
    // HUD), kept available for future advisory use.
    _ = isOffRoad
  }

  // MARK: - Route progress → maneuver

  private func handleRouteProgress(_ progress: RouteProgress) {
    // Arrival. VERIFY-IN-XCODE: completion check. v3 RouteProgress exposes a
    // session/route state; candidates: `progress.currentState == .complete`
    // or `progress.fractionTraveled >= 1`. Android uses
    // `RouteProgressState.COMPLETE`.
    if isArrived(progress) {
      if !arrivedHandled {
        arrivedHandled = true
        onEvent?(["kind": "arrived"])
        if simulating {
          // In sim the puck is parked at the destination; nothing more to do
          // on iOS (no replay session to tear back to live). The next start()
          // rebuilds the provider cleanly.
        }
      }
      return
    }

    // Distance to final destination + ETA.
    // VERIFY-IN-XCODE: `progress.distanceRemaining` (whole route, meters) and
    // `progress.durationRemaining` (seconds).
    let distToDest = Int(progress.distanceRemaining.rounded())
    let timeToDest = Int(progress.durationRemaining.rounded())

    // The UPCOMING step is what the user is walking toward (matches Android:
    // upcomingStep.maneuver + currentStepProgress.distanceRemaining).
    // VERIFY-IN-XCODE: leg/step accessors:
    //   progress.currentLegProgress.currentStepProgress.distanceRemaining
    //   progress.currentLegProgress.upcomingStep            (RouteStep?)
    //   progress.currentLegProgress.currentStep             (RouteStep)
    let legProgress = progress.currentLegProgress
    let stepProgress = legProgress.currentStepProgress
    let upcomingStep = legProgress.upcomingStep
    let currentStep = stepProgress.step

    // turnStep = upcoming normally; current only on the final/arrival leg.
    let turnStep = upcomingStep ?? currentStep
    let distToManeuver = Int(stepProgress.distanceRemaining.rounded())

    // Maneuver kind from the turn step.
    // VERIFY-IN-XCODE: `turnStep.maneuverType` / `.maneuverDirection`.
    let maneuver = maneuverString(type: turnStep.maneuverType, direction: turnStep.maneuverDirection)

    // Roads: current step's name = road we're on; upcoming step's name = the
    // road being entered at the turn.
    // VERIFY-IN-XCODE: `RouteStep.names?.first` / `.instructionsDisplayedAlongStep`
    // / `.name`. MapboxDirections exposes `names: [String]?`.
    let currentRoad = currentStep.names?.first?.nonBlank
    let nextStepRoad = upcomingStep?.names?.first?.nonBlank

    // Verbatim instruction for the turn we're showing (the upcoming turn).
    // VERIFY-IN-XCODE: the instruction text. Candidates:
    //   turnStep.instructions  (String)
    //   turnStep.instructionsDisplayedAlongStep?.first?.primaryInstruction.text
    let instruction = turnStep.instructions.nonBlank

    emitManeuverIfChanged(
      maneuverType: maneuver,
      distanceMeters: distToManeuver,
      fromRoad: currentRoad,
      nextStepRoad: nextStepRoad,
      distanceToDestinationMeters: distToDest,
      timeToDestinationSeconds: timeToDest,
      instruction: instruction
    )
  }

  /// Per-metre dedup, identical policy to Android's emitManeuverIfChanged, so
  /// the "In X m" countdown updates ~1 Hz and stays in lockstep with the trip
  /// distance shown on the HUD.
  private func emitManeuverIfChanged(
    maneuverType: String,
    distanceMeters: Int,
    fromRoad: String?,
    nextStepRoad: String?,
    distanceToDestinationMeters: Int,
    timeToDestinationSeconds: Int,
    instruction: String?
  ) {
    let distBucket = distanceMeters >= 0 ? distanceMeters : -1
    let tripBucket = distanceToDestinationMeters >= 0 ? distanceToDestinationMeters : -1
    let key = "\(maneuverType)|\(distBucket)|\(tripBucket)"
    if key == lastEmittedManeuverKey { return }
    lastEmittedManeuverKey = key

    var payload: [String: Any] = [
      "kind": "maneuver",
      "maneuverType": maneuverType,
      "distanceMeters": distanceMeters,
      "distanceToDestinationMeters": distanceToDestinationMeters,
      "timeToDestinationSeconds": timeToDestinationSeconds,
    ]
    if let fromRoad { payload["fromRoad"] = fromRoad; payload["toRoad"] = fromRoad }
    if let nextStepRoad { payload["nextStepRoad"] = nextStepRoad }
    if let instruction { payload["instruction"] = instruction }
    onEvent?(payload)
  }

  /// VERIFY-IN-XCODE: arrival predicate for v3 RouteProgress.
  private func isArrived(_ progress: RouteProgress) -> Bool {
    // Prefer an explicit completion state if the SDK exposes one; else fall
    // back to "essentially no distance left".
    // return progress.currentState == .complete
    return progress.distanceRemaining <= 1.0
  }

  // MARK: - Route emission

  private func emitRoute(_ navigationRoutes: NavigationRoutes) {
    // VERIFY-IN-XCODE: how to read the chosen route's geometry + steps.
    //   navigationRoutes.mainRoute.route            (Route)
    //   route.shape?.coordinates                    ([CLLocationCoordinate2D])
    //   route.legs.flatMap(\.steps)                 ([RouteStep])
    // mainRoute is non-optional; `.route` is the underlying Route.
    let route = navigationRoutes.mainRoute.route
    let coords = route.shape?.coordinates ?? []
    let points = coordinatesToPoints(coords)

    var payload: [String: Any] = ["points": points]

    // Build steps with polyline index + road + maneuver + distance, matching
    // Android's RouteStep shape (lat, lng, routeIndex, road, maneuver,
    // distanceMeters). Each step is anchored to its maneuver location.
    var steps: [[String: Any]] = []
    for leg in route.legs {
      for step in leg.steps {
        // VERIFY-IN-XCODE: `step.maneuverLocation` (CLLocationCoordinate2D),
        // `step.distance` (meters), `step.names`, maneuver type/direction.
        let loc = step.maneuverLocation
        let idx = closestPolylineIndex(in: points, lat: loc.latitude, lng: loc.longitude)
        var entry: [String: Any] = [
          "lat": loc.latitude,
          "lng": loc.longitude,
          "routeIndex": idx,
          "maneuver": maneuverString(type: step.maneuverType, direction: step.maneuverDirection),
          "distanceMeters": Int(step.distance.rounded()),
        ]
        if let road = step.names?.first?.nonBlank { entry["road"] = road }
        steps.append(entry)
      }
    }
    if !steps.isEmpty { payload["steps"] = steps }

    onRoute?(payload)
  }

  private func closestPolylineIndex(in points: [[String: Double]], lat: Double, lng: Double) -> Int {
    var best = 0
    var bestD = Double.greatestFiniteMagnitude
    for (i, p) in points.enumerated() {
      let dx = (p["lat"] ?? 0) - lat
      let dy = (p["lng"] ?? 0) - lng
      let d = dx * dx + dy * dy
      if d < bestD { bestD = d; best = i }
    }
    return best
  }

  // MARK: - Simulate deviation (dev only)

  /// Walk the user STRAIGHT FORWARD in their current direction of travel for
  /// DEVIATE_DURATION_S, pushing synthesized coords through `onLocation` so
  /// they go off-route and Mapbox's native reroute kicks in. Bearing comes
  /// from prev→last forwarded coords (their real direction of travel).
  /// `offsetMeters` is legacy/ignored. Mirrors Android `simulateDeviation`.
  func simulateDeviation(offsetMeters: Double) {
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      let origin = self.lastReportedCoord
        ?? CLLocationManager().location?.coordinate
        ?? CLLocationCoordinate2D(latitude: 0, longitude: 0)

      let bearing: Double = {
        if let prev = self.prevReportedCoord, let last = self.lastReportedCoord {
          let d = self.haversineMeters(prev, last)
          if d > 0.5 { return self.bearingDegrees(from: prev, to: last) }
        }
        return .nan
      }()
      guard !bearing.isNaN else {
        print("[NavigationManager] simulateDeviation: no recent movement to infer bearing")
        return
      }
      _ = offsetMeters

      self.deviateTimer?.invalidate()
      let baselineMps = 1.4
      let stepMeters = max(0.1, baselineMps * self.simulationSpeed * 0.4)
      let interval: TimeInterval = 0.4
      let totalTicks = Int((self.DEVIATE_DURATION_S / interval).rounded())
      var cursor = origin
      var ticksRemaining = totalTicks
      // The Timer fires on a @Sendable closure, but every property it touches is
      // @MainActor-isolated. Hop onto the main actor inside the tick so the
      // mutation is actor-safe (clears the Swift-6 concurrency warnings and
      // matches the rest of this class's main-actor model).
      self.deviateTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { t in
        Task { @MainActor [weak self] in
          guard let self else { t.invalidate(); return }
          if ticksRemaining <= 0 {
            t.invalidate(); self.deviateTimer = nil
            return
          }
          cursor = self.projectCoordinate(from: cursor, distanceMeters: stepMeters, bearingDegrees: bearing)
          self.prevReportedCoord = self.lastReportedCoord
          self.lastReportedCoord = cursor
          self.onLocation?([
            "lat": cursor.latitude,
            "lng": cursor.longitude,
            "accuracy": 5.0,
            "timestamp": Date().timeIntervalSince1970 * 1000,
          ])
          ticksRemaining -= 1
        }
      }
    }
  }

  // MARK: - Geo helpers

  private func bearingDegrees(from a: CLLocationCoordinate2D, to b: CLLocationCoordinate2D) -> Double {
    let toRad = Double.pi / 180, toDeg = 180 / Double.pi
    let lat1 = a.latitude * toRad, lat2 = b.latitude * toRad
    let dLng = (b.longitude - a.longitude) * toRad
    let y = sin(dLng) * cos(lat2)
    let x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dLng)
    return (atan2(y, x) * toDeg + 360).truncatingRemainder(dividingBy: 360)
  }

  private func projectCoordinate(from origin: CLLocationCoordinate2D, distanceMeters: Double, bearingDegrees: Double) -> CLLocationCoordinate2D {
    let earthRadius = 6_371_000.0
    let angular = distanceMeters / earthRadius
    let bearing = bearingDegrees * .pi / 180
    let lat1 = origin.latitude * .pi / 180, lng1 = origin.longitude * .pi / 180
    let lat2 = asin(sin(lat1) * cos(angular) + cos(lat1) * sin(angular) * cos(bearing))
    let lng2 = lng1 + atan2(sin(bearing) * sin(angular) * cos(lat1), cos(angular) - sin(lat1) * sin(lat2))
    return CLLocationCoordinate2D(latitude: lat2 * 180 / .pi, longitude: lng2 * 180 / .pi)
  }

  private func haversineMeters(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
    let R = 6_371_000.0, toRad = Double.pi / 180
    let dLat = (b.latitude - a.latitude) * toRad
    let dLng = (b.longitude - a.longitude) * toRad
    let lat1 = a.latitude * toRad, lat2 = b.latitude * toRad
    let s1 = sin(dLat / 2), s2 = sin(dLng / 2)
    let x = s1 * s1 + s2 * s2 * cos(lat1) * cos(lat2)
    return 2 * R * asin(min(1.0, sqrt(x)))
  }
}

private extension String {
  var nonBlank: String? {
    let t = trimmingCharacters(in: .whitespacesAndNewlines)
    return t.isEmpty ? nil : t
  }
}
