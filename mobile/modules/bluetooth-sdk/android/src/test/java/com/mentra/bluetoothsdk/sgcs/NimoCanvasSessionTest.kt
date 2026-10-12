package com.mentra.bluetoothsdk.sgcs

import org.junit.Assert.*
import org.junit.Test

class NimoCanvasSessionTest {
  private val frameA = byteArrayOf(0, 0, 1)
  private val frameB = byteArrayOf(1, 0, 1, 1)
  private val frameC = byteArrayOf(2, 0, 1, 2)
  private fun send(actions: List<NimoCanvasSession.Action>): NimoCanvasSession.Action.Send =
    actions.single() as NimoCanvasSession.Action.Send
  private fun success(session: NimoCanvasSession, key: Int) = session.response(key,
    if (key == 4) byteArrayOf(0, 0xFD.toByte(), 0, 0, 0) else byteArrayOf(0, 0xFD.toByte()))
  private fun launched(session: NimoCanvasSession): NimoCanvasSession.Action.Send {
    assertTrue(session.offer(frameA, "one:1").isEmpty())
    assertEquals(1, send(session.readiness(true)).key)
    return send(success(session, 1))
  }

  @Test fun launchAckPrecedesUpdateAndLatestOfferWins() {
    val session = NimoCanvasSession()
    session.readiness(true)
    assertEquals(1, send(session.offer(frameA, "one:1")).key)
    assertTrue(session.offer(frameB, "one:1").isEmpty())
    assertTrue(session.offer(frameC, "one:1").isEmpty())
    val update = send(success(session, 1))
    assertEquals(4, update.key)
    assertArrayEquals(frameC, update.frame)
  }

  @Test fun inflightUpdatesCoalesceAndDedupUsesActualBytes() {
    val session = NimoCanvasSession()
    launched(session)
    session.offer(frameB, "one:1")
    session.offer(frameC, "one:1")
    assertArrayEquals(frameC, send(success(session, 4)).frame)
    assertTrue(success(session, 4).isEmpty())
    assertTrue(session.offer(frameC.copyOf(), "one:1").isEmpty())
    assertArrayEquals(frameB, send(session.offer(frameB, "one:1")).frame)
  }

  @Test fun dedupDoesNotOverrideReversionWhileUpdateIsInFlight() {
    val session = NimoCanvasSession()
    launched(session); success(session, 4)
    session.offer(frameB, "one:1")
    session.offer(frameA, "one:1")
    assertArrayEquals(frameA, send(success(session, 4)).frame)
  }

  @Test fun replayEpochAndReconnectForceAcceptedFrameAgain() {
    val session = NimoCanvasSession()
    launched(session); success(session, 4)
    assertEquals(4, send(session.offer(frameA, "one:1", force = true)).key)
    success(session, 4)
    assertEquals(4, send(session.offer(frameA, "one:2")).key)
    success(session, 4)
    session.disconnected()
    assertEquals(1, send(session.readiness(true)).key)
    assertEquals(4, send(success(session, 1)).key)
  }

  @Test fun malformedSuccessAndWrongCommandCannotAcknowledgeLaunch() {
    val session = NimoCanvasSession()
    session.offer(frameA, "one:1"); val launch = send(session.readiness(true))
    assertTrue(session.response(1, byteArrayOf(0)).isEmpty())
    assertTrue(session.response(1, byteArrayOf(0, 0x04)).isEmpty())
    assertTrue(session.response(4, byteArrayOf(0, 0xFD.toByte(), 0, 0, 0)).isEmpty())
    assertTrue(session.timeout(launch.ticket).single() is NimoCanvasSession.Action.Reconnect)
  }

  @Test fun timeoutRequiresFreshTransportBeforeLateAckCanDoAnything() {
    val session = NimoCanvasSession()
    val update = launched(session)
    assertTrue(session.timeout(update.ticket).single() is NimoCanvasSession.Action.Reconnect)
    assertTrue(success(session, 4).isEmpty())
    assertTrue(session.offer(frameB, "one:1").isEmpty())
    session.disconnected()
    assertEquals(1, send(session.readiness(true)).key)
    assertTrue(session.timeout(update.ticket).isEmpty())
    assertArrayEquals(frameB, send(success(session, 1)).frame)
  }

  @Test fun unsupportedAndInvalidDoNotRetryUnchangedFrame() {
    for (status in listOf(1, 5, 6)) {
      val session = NimoCanvasSession()
      launched(session)
      assertTrue(session.response(4, byteArrayOf(status.toByte())).single() is NimoCanvasSession.Action.Rejected)
      assertTrue(session.offer(frameA, "one:1").isEmpty())
      assertTrue(session.offer(frameA, "one:2", force = true).isEmpty())
      assertArrayEquals(frameB, send(session.offer(frameB, "one:1")).frame)
    }
  }

  @Test fun failedLaunchDoesNotRetryIdenticalLaunchForChangingCaptions() {
    for (status in listOf(1, 5, 6)) {
      val session = NimoCanvasSession()
      session.offer(frameA, "one:1"); session.readiness(true)
      assertTrue(session.response(1, byteArrayOf(status.toByte())).single() is NimoCanvasSession.Action.Rejected)
      assertTrue(session.offer(frameB, "one:1").isEmpty())
      assertTrue(session.offer(frameC, "one:2", true).isEmpty())
      session.disconnected()
      assertEquals(1, send(session.readiness(true)).key)
    }
  }

  @Test fun readinessErrorWaitsForExplicitReadySignal() {
    val session = NimoCanvasSession()
    launched(session)
    assertTrue(session.response(4, byteArrayOf(7)).single() is NimoCanvasSession.Action.Rejected)
    assertTrue(session.offer(frameB, "one:1").isEmpty())
    assertTrue(session.readiness(true).isEmpty())
    assertTrue(session.readiness(false).isEmpty())
    assertEquals(1, send(session.readiness(true)).key)
    assertArrayEquals(frameB, send(success(session, 1)).frame)
  }

  @Test fun freshConfirmedReadinessReleasesNotReadyWithoutFalseEdge() {
    for (key in listOf(1, 4)) {
      val session = NimoCanvasSession()
      session.offer(frameA, "one:1"); session.readiness(true)
      if (key == 4) success(session, 1)
      assertTrue(session.response(key, byteArrayOf(7)).single() is NimoCanvasSession.Action.Rejected)
      assertTrue(session.offer(frameB, "one:1").isEmpty())
      assertTrue("cached true must not release status 7", session.readiness(true).isEmpty())
      assertEquals(1, send(session.confirmedReadiness(true)).key)
      assertArrayEquals(frameB, send(success(session, 1)).frame)
    }
  }

  @Test fun confirmedNotReadyStaysBlockedUntilConfirmedReady() {
    val session = NimoCanvasSession()
    launched(session)
    session.response(4, byteArrayOf(7))
    assertTrue(session.confirmedReadiness(false).isEmpty())
    assertTrue(session.offer(frameB, "one:1").isEmpty())
    assertEquals(1, send(session.confirmedReadiness(true)).key)
    assertArrayEquals(frameB, send(success(session, 1)).frame)
  }

  @Test fun repeatedReadyButRejectedLaunchHasBoundedRecovery() {
    val session = NimoCanvasSession()
    session.offer(frameA, "one:1"); session.readiness(true)
    repeat(3) {
      session.response(1, byteArrayOf(7))
      assertEquals(1, send(session.confirmedReadiness(true)).key)
      assertTrue("duplicate heartbeat cannot overlap Launch", session.confirmedReadiness(true).isEmpty())
    }
    session.response(1, byteArrayOf(7))
    repeat(5) { assertTrue("ready-only recovery must stop after three retries", session.confirmedReadiness(true).isEmpty()) }
    session.offer(frameB, "one:2", true)
    assertTrue(session.confirmedReadiness(true).isEmpty())
    session.readiness(false)
    assertEquals(1, send(session.confirmedReadiness(true)).key)
    assertArrayEquals(frameB, send(success(session, 1)).frame)
    success(session, 4)
    session.offer(frameC, "one:2")
    session.response(4, byteArrayOf(7))
    assertEquals(1, send(session.confirmedReadiness(true)).key)
  }

  @Test fun confirmedReadyDoesNotUnlockRejectedLaunchOrDeviceLock() {
    for (status in listOf(1, 5, 6, 8)) {
      val session = NimoCanvasSession()
      session.offer(frameA, "one:1"); session.readiness(true)
      session.response(1, byteArrayOf(status.toByte()))
      assertTrue(session.offer(frameB, "one:2", true).isEmpty())
      assertTrue(session.confirmedReadiness(false).isEmpty())
      assertTrue(session.confirmedReadiness(true).isEmpty())
    }
  }

  @Test fun deviceLockedStopsAllCanvasUntilNewTransport() {
    val session = NimoCanvasSession()
    launched(session)
    session.response(4, byteArrayOf(8))
    assertTrue(session.readiness(true).isEmpty())
    assertTrue(session.confirmedReadiness(true).isEmpty())
    assertTrue(session.offer(frameB, "one:2", true).isEmpty())
    session.disconnected()
    assertEquals(1, send(session.readiness(true)).key)
  }

  @Test fun statusTwoResetsTransportInsteadOfBlindRetry() {
    val session = NimoCanvasSession()
    launched(session)
    val actions = session.response(4, byteArrayOf(2))
    assertEquals(2, actions.size)
    assertTrue(actions.last() is NimoCanvasSession.Action.Reconnect)
    assertTrue(session.offer(frameB, "one:1").isEmpty())
  }

  @Test fun explicitExitWaitsForCurrentCommandAndDoesNotReplayOldFrame() {
    val session = NimoCanvasSession()
    launched(session)
    assertTrue(session.exit().isEmpty())
    assertEquals(3, send(success(session, 4)).key)
    assertTrue(session.nativeApp(0xFD, false).isEmpty())
    assertTrue(success(session, 3).isEmpty())
    session.disconnected()
    assertTrue(session.readiness(true).isEmpty())
  }

  @Test fun newSceneDuringExitLaunchesOnlyAfterExitAck() {
    val session = NimoCanvasSession()
    launched(session); success(session, 4)
    assertEquals(3, send(session.exit()).key)
    assertTrue(session.offer(frameB, "two:1").isEmpty())
    assertTrue(session.nativeApp(0xFD, false).isEmpty())
    assertEquals(1, send(success(session, 3)).key)
    assertArrayEquals(frameB, send(success(session, 1)).frame)
  }

  @Test fun nativeReportDuringExitPreservesNewerHostScene() {
    val session = NimoCanvasSession()
    launched(session); success(session, 4)
    assertEquals(3, send(session.exit()).key)
    session.offer(frameB, "two:1")
    assertTrue(session.nativeApp(0, true).isEmpty())
    assertEquals(1, send(success(session, 3)).key)
    assertArrayEquals(frameB, send(success(session, 1)).frame)
  }

  @Test fun nativeTakeoverRestoresLatestSceneWithoutAnotherHostOffer() {
    for (app in listOf(0, 0xFD)) {
      val session = NimoCanvasSession()
      launched(session); success(session, 4)
      assertEquals(1, send(session.nativeApp(app, app != 0xFD)).key)
      assertArrayEquals(frameA, send(success(session, 1)).frame)
    }
  }

  @Test fun nativeTakeoverWaitsForCurrentAckInsteadOfOverlappingCommands() {
    val session = NimoCanvasSession(); launched(session)
    assertTrue(session.nativeApp(0, true).isEmpty())
    session.offer(frameB, "one:1")
    assertEquals(1, send(success(session, 4)).key)
    assertTrue(session.nativeApp(0, true).isEmpty()) // Startup report during Launch.
    assertArrayEquals(frameB, send(success(session, 1)).frame)
  }

  @Test fun takeoverDuringUpdateReplaysIdenticalFrameAfterRelaunch() {
    val session = NimoCanvasSession(); launched(session)
    assertTrue(session.nativeApp(0, true).isEmpty())
    // The old Update ACK must not deduplicate the same scene on a new canvas.
    assertEquals(1, send(success(session, 4)).key)
    assertArrayEquals(frameA, send(success(session, 1)).frame)
    assertTrue(success(session, 4).isEmpty())
    assertTrue(session.offer(frameA, "one:1").isEmpty())
  }

  @Test fun startupStockUiDoesNotDiscardRetainedSceneBeforeReadiness() {
    val session = NimoCanvasSession(); launched(session); success(session, 4)
    session.disconnected()
    assertTrue(session.nativeApp(0, true).isEmpty())
    session.activate()
    assertEquals(1, send(session.readiness(true)).key)
    assertArrayEquals(frameA, send(success(session, 1)).frame)
  }

  @Test fun explicitExitStillReturnsControlToStockUiUntilNextConnection() {
    val session = NimoCanvasSession(); launched(session); success(session, 4)
    assertEquals(3, send(session.exit()).key)
    assertTrue(session.nativeApp(0, true).isEmpty())
    assertTrue(success(session, 3).isEmpty())
    assertTrue(session.nativeApp(0, true).isEmpty())
    session.disconnected(); session.activate()
    assertEquals(1, send(session.readiness(true)).key)
    assertArrayEquals(byteArrayOf(0, 0, 1), send(success(session, 1)).frame)
  }

  @Test fun activationLaunchesBlankCanvasWithoutAnyMiniapp() {
    val session = NimoCanvasSession()
    assertTrue(session.activate().isEmpty())
    assertEquals(1, send(session.readiness(true)).key)
    assertArrayEquals(byteArrayOf(0, 0, 1), send(success(session, 1)).frame)
  }

  @Test fun successfulUpdateRestoresProbeBudgetForNextRecovery() {
    val session = NimoCanvasSession(); session.activate(); session.readiness(true)
    repeat(2) { episode ->
      if (episode > 0) assertEquals(1, send(session.nativeApp(0, true)).key)
      repeat(3) {
        session.response(1, byteArrayOf(7))
        assertEquals(1, send(session.retryNotReady()).key)
      }
      assertEquals(4, send(success(session, 1)).key)
      assertTrue(success(session, 4).isEmpty())
    }
  }

  @Test fun notReadyProbesAreBoundedAndFreshHeartbeatStillRecovers() {
    val session = NimoCanvasSession(); session.activate(); session.readiness(true)
    repeat(3) {
      session.response(1, byteArrayOf(7))
      assertEquals(1, send(session.retryNotReady()).key)
    }
    session.response(1, byteArrayOf(7))
    repeat(5) { assertTrue(session.retryNotReady().isEmpty()) }
    assertEquals(1, send(session.confirmedReadiness(true)).key)
    assertEquals(4, send(success(session, 1)).key)
  }

  @Test fun lostReadinessDuringCommandStillResets() {
    val session = NimoCanvasSession(); launched(session)
    assertTrue(session.readiness(false).single() is NimoCanvasSession.Action.Reconnect)
    assertTrue(session.retryNotReady().isEmpty())
  }

  @Test fun offersCopyMutableInputAndRejectOversizedFrame() {
    val session = NimoCanvasSession()
    val input = frameA.copyOf(); session.offer(input, "one:1"); input[0] = 99
    session.readiness(true)
    assertArrayEquals(frameA, send(success(session, 1)).frame)
    assertThrows(IllegalArgumentException::class.java) { session.offer(ByteArray(12281), "one:1") }
  }

  @Test fun diagnosticHoldRetainsOnlyLatestSceneUntilReleased() {
    val session = NimoCanvasSession()
    launched(session); success(session, 4)

    assertTrue(session.hold(true).isEmpty())
    assertTrue(session.offer(frameB, "two:1").isEmpty())
    assertTrue(session.offer(frameC, "two:2", force = true).isEmpty())

    val update = send(session.hold(false))
    assertEquals(4, update.key)
    assertArrayEquals(frameC, update.frame)
  }

  @Test fun preemptedHoldDoesNotFlushStaleSceneBeforeExit() {
    val session = NimoCanvasSession()
    launched(session); success(session, 4)
    session.hold(true)
    session.offer(frameB, "two:1")

    assertTrue(session.hold(false, resume = false).isEmpty())
    assertEquals(3, send(session.exit()).key)
  }
}
