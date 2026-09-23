package com.mentra.bluetoothsdk.sgcs.firmware

import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [33])
class LiveFirmwareUpdaterTest {
  private class Harness : AutoCloseable {
    val directory = Files.createTempDirectory("live-firmware-test").toFile()
    var writes = 0
    var queries = 0
    var token: String? = null
    val request = FirmwareStartRequest("live", 1, "offer", "manifest",
      manifestUrl = "https://example.com/manifest?private=secret", metadata = mapOf("authorization" to "secret"))
    val updater by lazy { makeUpdater() }
    fun makeUpdater(): LiveFirmwareUpdater {
      val value = LiveFirmwareUpdater("live", 1, { true }, { queries++ }, directory)
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

  @Test fun lostAckRequiresQueryAndColdRecordNeverResumesApproval() = Harness().use { h ->
    h.updater.start(h.request)
    h.updater.commandSettled(h.token!!, Exception("timeout"))
    assertEquals("interrupted", h.updater.snapshot.phase)
    val recovered = h.makeUpdater()
    assertFalse(recovered.snapshot.safeToRelease); assertEquals(1, h.writes)
    recovered.reconcile()
    assertEquals(1, h.queries); assertEquals(1, h.writes)
    recovered.status("", "download", "idle", 0, 1)
    assertTrue(recovered.snapshot.safeToRelease)
  }

  @Test fun statusBeforeAckAndSidChangePreserveOutcome() = Harness().use { h ->
    h.updater.start(h.request)
    h.updater.status("old", "install", "in_progress", 10, 1)
    h.updater.status("new", "install", "complete", 100, 1)
    h.updater.commandSettled(h.token!!, Exception("late timeout"))
    assertEquals("complete", h.updater.snapshot.phase)
    assertEquals("new", h.updater.snapshot.inventory["glassesSessionId"])
    assertFalse(h.updater.ownsDevice)
    h.updater.acknowledge()
    assertNull(FirmwareJournal("live", h.directory).read())
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
