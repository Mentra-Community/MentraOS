package com.mentra.crust.navigation

/**
 * Separates callbacks from successive uses of the process-wide MapboxNavigation instance.
 * Mapbox observers replay cached values when registered, and route requests can complete
 * after stop(), so callers must pass this guard before touching shared navigation state.
 */
internal class NavigationSessionGuard {
  @JvmInline
  value class Token internal constructor(internal val value: Long)

  private var generation = 0L
  private var activeSession = false
  private var activeRouteId: String? = null
  private var locationCallbacksEnabled = false

  @Synchronized
  fun begin(): Token {
    generation += 1
    activeSession = true
    activeRouteId = null
    locationCallbacksEnabled = false
    return Token(generation)
  }

  @Synchronized
  fun invalidate() {
    generation += 1
    activeSession = false
    activeRouteId = null
    locationCallbacksEnabled = false
  }

  @Synchronized
  fun acceptsCallback(token: Token): Boolean = token.value == generation

  /** Snapshot the active session for work that will execute asynchronously. */
  @Synchronized
  fun captureActive(): Token? = if (activeSession) Token(generation) else null

  /** Enable locations only after observer registration has replayed its cached values. */
  @Synchronized
  fun enableLocationCallbacks(token: Token) {
    if (token.value == generation) locationCallbacksEnabled = true
  }

  @Synchronized
  fun acceptsLocation(token: Token): Boolean =
    token.value == generation && locationCallbacksEnabled

  /** Accept the guarded initial request and establish the route progress may belong to. */
  @Synchronized
  fun activateInitialRoute(token: Token, routeId: String): Boolean {
    if (token.value != generation) return false
    activeRouteId = routeId
    return true
  }

  /**
   * Accept a route observer update only after this session established its initial route.
   * A different route id is valid here: Mapbox uses the observer for automatic reroutes.
   */
  @Synchronized
  fun acceptRouteUpdate(token: Token, routeId: String): Boolean {
    if (token.value != generation || activeRouteId == null) return false
    activeRouteId = routeId
    return true
  }

  /** Reject cached or queued progress from another route, including after a reroute. */
  @Synchronized
  fun acceptsProgress(token: Token, routeId: String): Boolean =
    token.value == generation && routeId == activeRouteId
}
