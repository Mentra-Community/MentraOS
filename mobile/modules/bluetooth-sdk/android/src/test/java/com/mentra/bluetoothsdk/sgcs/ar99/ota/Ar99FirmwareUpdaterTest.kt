package com.mentra.bluetoothsdk.sgcs.ar99.ota

import com.mentra.bluetoothsdk.sgcs.firmware.*
import java.io.File
import java.security.MessageDigest
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, sdk = [33])
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
    val updater by lazy { makeUpdater() }
    fun makeUpdater() = Ar99FirmwareUpdater("ar99", 1, this, directory)
    override fun connected() = true
    override fun start(bytes: ByteArray, callback: Ar99OtaManager.OTACallback): Boolean {
      assertArrayEquals(this.bytes, bytes); starts++; this.callback = callback; onStart?.invoke(); return true
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
  @Test fun imageValidationDoesNotInventRunningVersionAndOldCallbackCannotReopenAcknowledgedResult() = Harness().use { h ->
    h.updater.inventoryChanged("old", "serial", "AR99", 1)
    h.updater.start(h.request)
    val stale = h.callback!!
    stale.onCompleted(false)
    assertEquals("old", h.updater.snapshot.observedFirmware)
    assertEquals("unverified", h.updater.snapshot.inventory["activation"])
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
