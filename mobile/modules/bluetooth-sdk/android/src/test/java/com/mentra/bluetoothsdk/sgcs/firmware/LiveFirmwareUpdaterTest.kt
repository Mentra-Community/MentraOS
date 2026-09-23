package com.mentra.bluetoothsdk.sgcs.firmware

import java.nio.file.Files
import java.io.File
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [33])
class LiveFirmwareUpdaterTest {
  private fun quietActivity(id: String): Map<String, Any> = mapOf(
    "schema" to 1, "request_id" to id, "consistent" to true, "admission_held" to false,
    "updating" to false, "mtk_in_progress" to false, "bes_in_progress" to false,
    "session" to mapOf("status" to "idle", "restart_pending" to false),
  )
  private class Harness : AutoCloseable {
    val directory = Files.createTempDirectory("live-firmware-test").toFile()
    var writes = 0
    var queries = 0
    var token: String? = null
    val request = FirmwareStartRequest("live", 1, "offer", "manifest",
      manifestUrl = "https://example.com/manifest?private=secret", metadata = mapOf("authorization" to "secret"))
    val updater by lazy { makeUpdater() }
    fun makeUpdater(journalDirectory: File = directory): LiveFirmwareUpdater {
      val value = LiveFirmwareUpdater("live", 1, { true }, { queries++ }, journalDirectory)
      value.launch = { token = value.commandStarted(it.manifestUrl!!, it); writes++ }
      return value
    }
    override fun close() { directory.deleteRecursively() }
  }

  @Test fun managedStartAdoptsAndJournalsWithoutCredentials() = Harness().use { h ->
    val first = h.updater.start(h.request)
    assertEquals(first.sessionId, h.updater.start(h.request).sessionId)
    assertEquals(1, h.writes); assertTrue(h.updater.ownsDevice)
    val saved = FirmwareJournal("live", h.directory).read()!!
    assertNull(saved.request.manifestUrl); assertNull(saved.request.artifact)
    assertEquals(setOf("manifestSha256"), saved.request.metadata.keys)
    assertFalse(saved.snapshot.safeToRelease)
    assertThrows(FirmwareUpdaterException::class.java) { h.updater.acknowledge() }
    Unit
  }
  @Test fun unavailableNewJournalDoesNotOwnAnUnmodifiedDevice() = Harness().use { h ->
    val blocked = File(h.directory, "blocked").apply { writeText("not a directory") }
    val updater = h.makeUpdater(blocked)
    assertTrue(updater.snapshot.safeToRelease)
    assertThrows(Exception::class.java) { updater.start(h.request) }
    assertTrue(updater.snapshot.safeToRelease); assertEquals(0, h.writes)
    updater.acknowledge()
    assertTrue(h.makeUpdater(blocked).snapshot.safeToRelease)
  }

  @Test fun lostAckRequiresQueryAndColdRecordNeverResumesApproval() = Harness().use { h ->
    h.updater.start(h.request)
    h.updater.commandSettled(h.token!!, Exception("timeout"))
    assertEquals("interrupted", h.updater.snapshot.phase)
    val recovered = h.makeUpdater()
    assertFalse(recovered.snapshot.safeToRelease); assertEquals(1, h.writes)
    recovered.reconcile()
    assertEquals(1, h.queries); assertEquals(1, h.writes)
    recovered.status("", "download", "idle", 0, 1)
    assertFalse(recovered.snapshot.safeToRelease)
    val activity = quietActivity(recovered.beginStatusQuery())
    recovered.status("", "download", "idle", 0, 1, activity)
    assertTrue(recovered.snapshot.safeToRelease)
    recovered.acknowledge()
    assertNull(FirmwareJournal("live", h.directory).read())
    assertEquals(1, h.writes)
  }

  @Test fun quiescenceRequiresEveryOwnerToBeKnownIdleAndAConsistentRead() = Harness().use { h ->
    h.updater.start(h.request)
    h.updater.commandSettled(h.token!!, null)
    val invalid = listOf(
      "schema" to 2, "consistent" to false, "admission_held" to true, "updating" to true,
      "mtk_in_progress" to true, "bes_in_progress" to true, "bes_in_progress" to "false",
      "session" to mapOf("status" to "in_progress", "restart_pending" to false),
      "session" to mapOf("status" to "idle", "restart_pending" to true),
      "session" to emptyMap<String, Any>(),
    )
    for ((key, value) in invalid) {
      val activity = quietActivity(h.updater.beginStatusQuery()) + (key to value)
      h.updater.status("", "download", "idle", 0, 1, activity)
      assertTrue("Rejected $key=$value", h.updater.ownsDevice)
    }
    val missing = quietActivity(h.updater.beginStatusQuery()) - "bes_in_progress"
    h.updater.status("", "download", "idle", 0, 1, missing)
    assertTrue(h.updater.ownsDevice)
  }

  @Test fun staleQueriesCannotReleaseAChangedAttemptOrObservation() = Harness().use { h ->
    h.updater.start(h.request)
    h.updater.commandSettled(h.token!!, null)
    val old = quietActivity(h.updater.beginStatusQuery())
    h.updater.beginStatusQuery()
    h.updater.status("", "download", "idle", 0, 1, old)
    assertTrue(h.updater.ownsDevice)
    val beforeProgress = quietActivity(h.updater.beginStatusQuery())
    h.updater.status("new", "download", "in_progress", 10, 1)
    h.updater.status("", "download", "idle", 0, 1, beforeProgress)
    assertTrue(h.updater.ownsDevice)
    val beforeRetry = quietActivity(h.updater.beginStatusQuery())
    val token = h.updater.commandStarted("https://example.com/retry")
    h.updater.commandSettled(token, null)
    h.updater.status("", "download", "idle", 0, 1, beforeRetry)
    assertTrue(h.updater.ownsDevice)
    val beforeReconnect = quietActivity(h.updater.beginStatusQuery())
    h.updater.connectionChanged(2)
    h.updater.status("", "download", "idle", 0, 2, beforeReconnect)
    assertTrue(h.updater.ownsDevice)
    h.updater.status("", "download", "idle", 0, 2, quietActivity(h.updater.beginStatusQuery()))
    assertFalse(h.updater.ownsDevice)
  }

  @Test fun idleAfterStartAckCannotReleaseOwnershipBeforeTerminalStatus() = Harness().use { h ->
    h.updater.status("", "download", "idle", 0, 1)
    assertFalse(h.updater.ownsDevice)
    h.updater.start(h.request)
    h.updater.commandSettled(h.token!!, null)
    // ASG acknowledges Start before fetching the manifest and creating its session.
    h.updater.reconcile()
    h.updater.status("", "download", "idle", 0, 1)
    assertTrue(h.updater.ownsDevice)
    assertThrows(FirmwareUpdaterException::class.java) { h.updater.acknowledge() }
    h.updater.status("new", "download", "in_progress", 10, 1)
    h.updater.status("", "download", "idle", 0, 1)
    assertTrue(h.updater.ownsDevice)
    h.updater.status("new", "install", "complete", 100, 1)
    assertFalse(h.updater.ownsDevice)
    h.updater.acknowledge()
    assertNull(FirmwareJournal("live", h.directory).read())
  }

  @Test fun statusBeforeAckAndSidChangePreserveOutcome() = Harness().use { h ->
    h.updater.start(h.request)
    h.updater.status("old", "install", "in_progress", 10, 1)
    h.updater.status("new", "install", "in_progress", 90, 1)
    h.updater.status("new", "install", "complete", 100, 1)
    assertFalse(h.updater.snapshot.safeToRelease)
    h.updater.commandSettled(h.token!!, Exception("late timeout"))
    assertEquals("complete", h.updater.snapshot.phase)
    assertEquals("new", h.updater.snapshot.inventory["glassesSessionId"])
    assertFalse(h.updater.ownsDevice)
    h.updater.acknowledge()
    assertNull(FirmwareJournal("live", h.directory).read())
  }

  @Test fun previousTerminalCannotReleaseNewAckedAttemptIncludingColdRecovery() {
    for (terminal in listOf("complete", "failed")) Harness().use { h ->
      h.updater.status("previous", "install", "in_progress", 20, 1)
      h.updater.status("previous", "install", terminal, 100, 1)
      h.updater.start(h.request)
      // Cached terminal may arrive before or after the start ACK.
      assertFalse(h.updater.status("previous", "install", terminal, 100, 1))
      h.updater.commandSettled(h.token!!, null)
      assertEquals(1, h.queries)
      for (value in listOf(h.updater, h.makeUpdater())) {
        val before = value.snapshot
        val busy = quietActivity(value.beginStatusQuery()) + ("admission_held" to true)
        assertFalse(value.status("previous", "install", terminal, 100, 1, busy))
        assertFalse(value.activity(busy, 1))
        assertEquals(before, value.snapshot)
        assertTrue(value.ownsDevice)
        assertThrows(FirmwareUpdaterException::class.java) { value.acknowledge() }
      }
      assertEquals(1, h.writes)
    }
  }

  @Test fun ambiguousTerminalCanResolveAsIdleOnlyFromFreshQuietActivity() = Harness().use { h ->
    h.updater.start(h.request); h.updater.commandSettled(h.token!!, null)
    val recovered = h.makeUpdater()
    assertFalse(recovered.status("previous", "install", "complete", 100, 1))
    assertEquals(1, h.queries)
    val quiet = quietActivity(recovered.beginStatusQuery())
    assertTrue(recovered.activity(quiet, 1))
    assertEquals("idle", recovered.snapshot.phase); assertFalse(recovered.ownsDevice)
    assertFalse(recovered.activity(quiet, 1))
    recovered.start(h.request.copy(offerId = "next"))
    assertFalse(recovered.activity(quiet, 1)); assertTrue(recovered.ownsDevice)
  }

  @Test fun boundSessionSurvivesRestartAndRejectsOtherTerminalSessions() = Harness().use { h ->
    h.updater.start(h.request); h.updater.commandSettled(h.token!!, null)
    h.updater.status("current", "download", "in_progress", 30, 1)
    val recovered = h.makeUpdater()
    val diagnostic = quietActivity(recovered.beginStatusQuery())
    assertFalse(recovered.status("previous", "install", "complete", 100, 1))
    assertTrue(recovered.ownsDevice)
    assertTrue(recovered.status("current", "install", "complete", 100, 1))
    assertFalse(recovered.ownsDevice)
    assertFalse(recovered.activity(diagnostic, 1))
    assertEquals("complete", recovered.snapshot.phase)
  }

  @Test fun busyActivityOverridesEvenBoundTerminalCompletion() = Harness().use { h ->
    h.updater.start(h.request); h.updater.commandSettled(h.token!!, null)
    h.updater.status("current", "install", "in_progress", 90, 1)
    val busy = quietActivity(h.updater.beginStatusQuery()) + ("bes_in_progress" to true)
    assertFalse(h.updater.status("current", "install", "complete", 100, 1, busy))
    assertTrue(h.updater.ownsDevice)
    assertTrue(h.updater.activity(quietActivity(h.updater.beginStatusQuery()), 1))
    assertEquals("idle", h.updater.snapshot.phase)
  }

  @Test fun transientLegacyTerminalRemainsSupportedButWaitsForPendingCommand() = Harness().use { h ->
    h.updater.start(h.request)
    assertTrue(h.updater.status("", "install", "failed", 0, 1, legacyEvent = true))
    assertFalse(h.updater.snapshot.safeToRelease)
    h.updater.commandSettled(h.token!!, Exception("late timeout"))
    assertEquals("failed", h.updater.snapshot.phase); assertFalse(h.updater.ownsDevice)
    assertTrue(h.makeUpdater().snapshot.safeToRelease)
  }

  @Test fun idleDuringPendingStartAndPriorConnectionCannotReleaseOwner() = Harness().use { h ->
    h.updater.start(h.request)
    h.updater.status("", "download", "idle", 0, 1)
    assertFalse(h.updater.snapshot.safeToRelease)
    h.updater.connectionChanged(2)
    h.updater.status("stale", "install", "complete", 100, 1)
    assertFalse(h.updater.snapshot.safeToRelease)
    assertThrows(FirmwareUpdaterException::class.java) { h.updater.start(h.request) }
    Unit
  }

  @Test fun observedGlassesOwnedUpdateSurvivesPhoneRestartWithoutApproval() = Harness().use { h ->
    h.updater.status("already-running", "install", "in_progress", 40, 1)
    val recovered = h.makeUpdater()
    assertFalse(recovered.snapshot.safeToRelease)
    assertEquals("interrupted", recovered.snapshot.phase)
    assertEquals(0.4, recovered.snapshot.progress!!, 0.0001)
    assertEquals("already-running", recovered.snapshot.inventory["glassesSessionId"])
    assertEquals(0, h.writes)
    assertThrows(FirmwareUpdaterException::class.java) { recovered.start(h.request) }
    recovered.reconcile()
    assertEquals(1, h.queries); assertEquals(0, h.writes)
  }

  @Test fun providerCompletionReleasesOnlyMatchingSettledTransactionAndSurvivesRestart() {
    for (kind in listOf("live-bes-reboot", "live-apk-build-increase", "live-apk-target-convergence")) Harness().use { h ->
      fun evidence(value: FirmwareUpdateSnapshot, proofKind: String = kind) = FirmwareCompletionEvidence(
        value.deviceId, value.updaterId, value.sessionId!!, value.connectionGeneration, value.revision, proofKind)
      h.updater.start(h.request)
      assertThrows(FirmwareUpdaterException::class.java) { h.updater.reconcileCompletion(evidence(h.updater.snapshot)) }
      h.updater.commandSettled(h.token!!, null)
      h.updater.status("legacy", "install", "step_complete", 100, 1)
      val old = h.updater.snapshot
      h.updater.connectionChanged(2, true)
      assertTrue(h.updater.ownsDevice)
      assertThrows(FirmwareUpdaterException::class.java) { h.updater.reconcileCompletion(evidence(old)) }
      val current = h.updater.snapshot
      assertThrows(FirmwareUpdaterException::class.java) { h.updater.reconcileCompletion(evidence(current, "generic-reconnect")) }
      for (value in listOf(current.copy(deviceId = "other"), current.copy(updaterId = "other"),
        current.copy(sessionId = "other"), current.copy(revision = current.revision - 1))) {
        assertThrows(FirmwareUpdaterException::class.java) { h.updater.reconcileCompletion(evidence(value)) }
      }
      val proof = evidence(current)
      assertEquals("complete", h.updater.reconcileCompletion(proof).phase)
      assertFalse(h.updater.ownsDevice)
      assertTrue(h.makeUpdater().snapshot.safeToRelease)
      h.updater.commandStarted("http://local/next")
      assertThrows(FirmwareUpdaterException::class.java) { h.updater.reconcileCompletion(proof) }
      assertTrue(h.updater.ownsDevice)
    }
  }

  @Test fun explicitLowLevelRetryKeepsExistingCommandSemantics() = Harness().use { h ->
    val first = h.updater.commandStarted("http://local/manifest")
    assertThrows(FirmwareUpdaterException::class.java) { h.updater.commandStarted("http://local/manifest") }
    h.updater.commandSettled(first, Exception("timeout"))
    val next = h.updater.commandStarted("http://local/manifest")
    assertNotEquals(first, next)
    h.updater.commandSettled(first, null)
    assertEquals("preparing", h.updater.snapshot.phase)
  }
}
