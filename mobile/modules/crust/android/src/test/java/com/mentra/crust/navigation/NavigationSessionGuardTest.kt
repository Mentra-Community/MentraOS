package com.mentra.crust.navigation

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NavigationSessionGuardTest {
  @Test
  fun cachedCallbacksAreRejectedUntilTheCurrentInitialRouteIsReady() {
    val guard = NavigationSessionGuard()
    val session = guard.begin()

    assertTrue(guard.acceptsCallback(session))
    assertFalse(guard.acceptsLocation(session))
    assertFalse(guard.acceptRouteUpdate(session, "cached-route"))
    assertFalse(guard.acceptsProgress(session, "cached-route"))

    assertTrue(guard.activateInitialRoute(session, "current-route"))
    assertTrue(guard.acceptsProgress(session, "current-route"))

    guard.enableLocationCallbacks(session)
    assertTrue(guard.acceptsLocation(session))
  }

  @Test
  fun stoppedAndSupersededSessionsCannotMutateCurrentState() {
    val guard = NavigationSessionGuard()
    val oldSession = guard.begin()
    assertTrue(guard.activateInitialRoute(oldSession, "old-route"))

    guard.invalidate()
    assertFalse(guard.acceptsCallback(oldSession))
    guard.enableLocationCallbacks(oldSession)
    assertFalse(guard.acceptsLocation(oldSession))
    assertFalse(guard.activateInitialRoute(oldSession, "late-route"))
    assertFalse(guard.acceptRouteUpdate(oldSession, "late-reroute"))
    assertFalse(guard.acceptsProgress(oldSession, "old-route"))

    val currentSession = guard.begin()
    assertTrue(guard.activateInitialRoute(currentSession, "current-route"))
    assertTrue(guard.acceptsProgress(currentSession, "current-route"))
  }

  @Test
  fun rerouteMovesProgressIdentityToTheNewRoute() {
    val guard = NavigationSessionGuard()
    val session = guard.begin()
    assertTrue(guard.activateInitialRoute(session, "initial-route"))

    assertTrue(guard.acceptRouteUpdate(session, "rerouted-route"))
    assertFalse(guard.acceptsProgress(session, "initial-route"))
    assertTrue(guard.acceptsProgress(session, "rerouted-route"))
  }

  @Test
  fun delayedWorkCapturedBeforeStopCannotRunInTheNextSession() {
    val guard = NavigationSessionGuard()
    val oldWork = guard.begin()
    assertTrue(guard.captureActive() == oldWork)

    guard.invalidate()
    assertTrue(guard.captureActive() == null)
    val nextSession = guard.begin()

    assertFalse(guard.acceptsCallback(oldWork))
    assertTrue(guard.acceptsCallback(nextSession))
  }
}
