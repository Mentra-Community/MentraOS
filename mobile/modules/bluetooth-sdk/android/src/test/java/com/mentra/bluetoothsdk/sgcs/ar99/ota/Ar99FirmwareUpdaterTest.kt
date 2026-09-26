package com.mentra.bluetoothsdk.sgcs.ar99.ota

import com.mentra.bluetoothsdk.sgcs.firmware.*
import java.io.File
import java.security.MessageDigest
import android.os.Looper
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [33])
@LooperMode(LooperMode.Mode.PAUSED)
class Ar99FirmwareUpdaterTest {
  private class Harness : Ar99FirmwareUpdater.Ports, AutoCloseable {
    val directory = java.nio.file.Files.createTempDirectory("ar99-session-test").toFile()
    val bytes = byteArrayOf(1, 2, 3)
    val file = File(directory, "image.bin").apply { writeBytes(bytes) }
    val request = FirmwareStartRequest("ar99", 1, "offer", "file", FirmwareArtifact(file.absolutePath, "new", 3,
      MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }))
    var callback: Ar99OtaManager.OTACallback? = null
    var starts = 0
    var queries = 0
    var onStart: (() -> Unit)? = null
    var rejectChannel = false
    val updater by lazy { makeUpdater() }
    fun makeUpdater(journalDirectory: File = directory) = Ar99FirmwareUpdater("ar99", 1, this, journalDirectory)
    override fun connected() = true
    override fun start(bytes: ByteArray, callback: Ar99OtaManager.OTACallback): Boolean {
      assertArrayEquals(this.bytes, bytes); starts++; this.callback = callback; onStart?.invoke()
      if (rejectChannel) return Ar99OtaManager().apply { setCallback(callback) }.startOTA(bytes)
      return true
    }
    override fun queryInventory() { queries++ }
    override fun close() { directory.deleteRecursively() }
  }

  @Test fun admitsBeforePreparationAndDuplicateAdopts() = Harness().use { h ->
    h.onStart = {
      assertFalse(h.updater.snapshot.safeToRelease)
      assertNotNull(FirmwareJournal("ar99", h.directory).read())
      assertThrows(FirmwareUpdaterException::class.java) { h.updater.beginLegacy() }
    }
    val first = h.updater.start(h.request)
    assertEquals(first.sessionId, h.updater.start(h.request).sessionId)
    assertEquals(1, h.starts)
    assertThrows(FirmwareUpdaterException::class.java) { h.updater.cancel() }
    assertThrows(FirmwareUpdaterException::class.java) { h.updater.acknowledge() }
    Unit
  }
  @Test fun legacyOwnershipIsPublishedAndRetainedAcrossConnections() = Harness().use { h ->
    val observed = mutableListOf<Boolean>()
    val remove = h.updater.observe { observed.add(it.safeToRelease) }
    h.updater.beginLegacy()
    assertFalse(h.updater.snapshot.safeToRelease); assertFalse(observed.last())
    h.updater.connectionChanged(2)
    assertFalse(observed.last())
    h.updater.assertLegacyControlAllowed() // Existing explicit legacy retry/cancel remains admitted.
    h.updater.beginLegacy()
    assertThrows(FirmwareUpdaterException::class.java) { h.updater.start(h.request) }
    h.updater.endLegacy()
    assertTrue(observed.last()); assertFalse(h.updater.ownsDevice)
    assertTrue(observed.first())
    remove()
  }
  @Test fun legacyPreparationCannotBeReplaced() = Harness().use { h ->
    h.updater.beginLegacy()
    assertThrows(FirmwareUpdaterException::class.java) { h.updater.start(h.request) }
    assertTrue(h.updater.ownsDevice); assertEquals(0, h.starts)
    h.updater.endLegacy(); h.updater.start(h.request)
    assertEquals(1, h.starts)
  }
  @Test fun changedFileNeverReachesWireManager() = Harness().use { h ->
    h.file.writeBytes(byteArrayOf(4, 5, 6))
    val result = h.updater.start(h.request)
    assertEquals(0, h.starts); assertEquals("failed", result.phase); assertTrue(result.safeToRelease)
  }
  @Test fun rejectedChannelRetiresQueuedManagerCallbacksBeforeAcknowledgement() = Harness().use { h ->
    h.rejectChannel = true
    assertEquals("failed", h.updater.start(h.request).phase)
    assertTrue(h.updater.snapshot.safeToRelease)
    shadowOf(Looper.getMainLooper()).idle() // Actual manager queued onError before returning false.
    assertTrue(h.updater.snapshot.safeToRelease)
    assertTrue(h.makeUpdater().snapshot.safeToRelease)
    val stale = h.callback!!
    h.updater.acknowledge()
    h.rejectChannel = false
    h.updater.start(h.request)
    stale.onCompleted(false)
    assertFalse(h.updater.snapshot.safeToRelease)
    assertEquals(0, h.queries)
  }
  @Test fun unavailableNewJournalDoesNotOwnAnUnmodifiedDevice() = Harness().use { h ->
    val blocked = File(h.directory, "blocked").apply { writeText("not a directory") }
    val updater = h.makeUpdater(blocked)
    assertTrue(updater.snapshot.safeToRelease)
    val failed = updater.start(h.request)
    assertEquals("failed", failed.phase); assertTrue(failed.safeToRelease)
    assertEquals(0, h.starts)
    updater.acknowledge()
    assertTrue(h.makeUpdater(blocked).snapshot.safeToRelease)
  }
  @Test fun imageValidationDoesNotInventRunningVersionAndOldCallbackCannotReopenAcknowledgedResult() = Harness().use { h ->
    h.updater.inventoryChanged("old", "serial", "AR99", 1)
    h.updater.start(h.request)
    val stale = h.callback!!
    stale.onCompleted(false)
    assertEquals("old", h.updater.snapshot.observedFirmware)
    assertEquals("unverified", h.updater.snapshot.inventory["activation"])
    assertTrue(h.updater.snapshot.safeToRelease)
    stale.onError(255, "late error")
    assertTrue(h.updater.snapshot.safeToRelease)
    h.updater.acknowledge(); stale.onProgress(3, 3, 100)
    assertEquals("idle", h.updater.snapshot.phase)
  }
  @Test fun pausedAndColdRecoveryOnlyInspectAndRejectOldConnectionInventory() = Harness().use { h ->
    h.updater.start(h.request); h.callback!!.onPausedWaitingReconnect()
    assertFalse(h.updater.snapshot.safeToRelease); h.updater.reconcile()
    val restored = h.makeUpdater()
    assertEquals("interrupted", restored.snapshot.phase); assertFalse(restored.snapshot.safeToRelease)
    restored.reconcile(); assertEquals(1, h.starts); assertEquals(2, h.queries)
    restored.connectionChanged(2); restored.inventoryChanged("new", "serial", "AR99", 1)
    assertFalse(restored.snapshot.safeToRelease)
    restored.inventoryChanged("new", "serial", "AR99", 2)
    assertTrue(restored.snapshot.safeToRelease); assertEquals("verified", restored.snapshot.inventory["activation"])
  }
  @Test fun timeoutDoesNotAuthorizeReflashOrDisconnect() = Harness().use { h ->
    h.updater.start(h.request); h.callback!!.onError(255, "OTA reconnect timed out")
    assertFalse(h.updater.snapshot.safeToRelease)
    assertThrows(FirmwareUpdaterException::class.java) { h.updater.acknowledge() }
    assertThrows(FirmwareUpdaterException::class.java) { h.updater.beginLegacy() }
    assertEquals(1, h.starts)
    h.updater.inventoryChanged("old", "serial", "AR99", 1)
    val restored = h.makeUpdater()
    restored.reconcile()
    restored.inventoryChanged("old", "serial", "AR99", 1)
    assertFalse(restored.snapshot.safeToRelease)
    assertThrows(FirmwareUpdaterException::class.java) { restored.acknowledge() }
    assertThrows(FirmwareUpdaterException::class.java) { restored.cancel() }
    assertEquals(1, h.starts) // Old inventory is not proof of a remote abort. Rollout remains gated.
  }
}
