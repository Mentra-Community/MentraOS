package com.mentra.bluetoothsdk.sgcs.nimo.ota

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
class NimoFirmwareUpdaterTest {
  private class Harness : NimoFirmwareUpdater.Ports, AutoCloseable {
    val directory = java.nio.file.Files.createTempDirectory("nimo-firmware-test").toFile()
    val firmware = ByteArray(1024) { 1 }
    val file = File(directory, "image.bin").apply { writeBytes(firmware) }
    val request = FirmwareStartRequest("device", 1, "offer", "file", FirmwareArtifact(file.absolutePath, "full-target", firmware.size,
      MessageDigest.getInstance("SHA-256").digest(firmware).joinToString("") { "%02x".format(it.toInt() and 255) }),
      metadata = mapOf("hardwareId" to "00000201", "packedVersion" to "0.1.1.1", "peerVersion" to "0001"))
    var generation = 1
    var capacity = 20
    val prepareCallbacks = mutableListOf<(Throwable?) -> Unit>()
    val inventoryCallbacks = mutableListOf<(Result<NimoOtaManager.Inventory>) -> Unit>()
    val writes = mutableListOf<ByteArray>()
    val timers = mutableListOf<() -> Unit>()
    var releases = 0
    val updater by lazy { NimoFirmwareUpdater("device", generation, this, directory) }
    override fun connection() = NimoFirmwareUpdater.Connection("device", generation, capacity)
    override fun prepare(completion: (Throwable?) -> Unit) { prepareCallbacks += completion }
    override fun release() { releases++ }
    override fun write(data: ByteArray, completion: (Throwable?) -> Unit) { writes += data; completion(null) }
    override fun readInventory(completion: (Result<NimoOtaManager.Inventory>) -> Unit) { inventoryCallbacks += completion }
    override fun schedule(delayMs: Long, callback: () -> Unit): () -> Unit {
      var cancelled = false; timers += { if (!cancelled) callback() }; return { cancelled = true }
    }
    override fun nowMs() = 0L
    override fun close() { directory.deleteRecursively() }
    fun reply(body: ByteArray) {
      val sent = writes.last()
      val length = body.size + 2
      updater.receive(byteArrayOf(0x70, 7, 0x6e, 0, sent[4], (length shr 8).toByte(), length.toByte(), 0, sent[7]) + body + 0x33.toByte(), generation)
    }
  }

  @Test fun admissionPrecedesPreparationAndUsesNegotiatedCapacity() = Harness().use { h ->
    val first = h.updater.start(h.request)
    assertFalse(first.safeToRelease); assertEquals("preparing", first.phase)
    assertEquals(first.sessionId, h.updater.start(h.request).sessionId)
    val observed = mutableListOf<Int>()
    val unsubscribe = h.updater.observe { observed += it.revision }; unsubscribe()
    assertEquals(1, h.prepareCallbacks.size); assertTrue(h.writes.isEmpty())
    assertThrows(FirmwareUpdaterException::class.java) { h.updater.acknowledge() }
    h.capacity = 244; h.prepareCallbacks[0](null)
    assertEquals(1, h.writes.size); assertEquals(2, h.writes[0][4].toInt())
    assertEquals(0, h.releases); assertEquals(1, observed.size)
  }

  @Test fun idleReconnectAcceptsFreshInventoryBeforeOtaChannelPreparation() = Harness().use { h ->
    h.updater.inventoryChanged(NimoOtaManager.Inventory("old", "0.1.0.14"), 1)
    h.updater.disconnected(1)
    h.generation = 2
    h.updater.connectionChanged("device", 2)
    h.updater.inventoryChanged(NimoOtaManager.Inventory("fresh", "0.1.1.1"), 2)
    h.updater.inventoryChanged(NimoOtaManager.Inventory("stale", "0.1.0.14"), 1)
    assertEquals("fresh", h.updater.snapshot.observedFirmware)
    assertEquals("2", h.updater.snapshot.inventory["revision"])
    assertTrue(h.prepareCallbacks.isEmpty()); assertTrue(h.writes.isEmpty())
    assertTrue(h.updater.snapshot.safeToRelease)
  }

  @Test fun journalRetainsOnlyRecoveryMetadata() = Harness().use { h ->
    h.updater.start(h.request.copy(manifestUrl = "https://example.com/?secret=private-token",
      metadata = h.request.metadata + ("authorization" to "private-token")))
    val saved = FirmwareJournal("device", h.directory).read()
    assertNull(saved?.request?.manifestUrl)
    assertEquals(h.request.metadata, saved?.request?.metadata)
    assertEquals(h.request.artifact?.sha256, saved?.request?.artifact?.sha256)
  }

  @Test fun coldStartReleasesOnlyAttemptsProvenToPrecedeUpgradeEntry() {
    // Stop during preparation, INFO, FILE_OFFSET, CAN_UPDATE, or after ENTER is submitted.
    for (stage in 0..4) Harness().use { h ->
      h.updater.start(h.request)
      if (stage >= 1) { h.capacity = 244; h.prepareCallbacks[0](null) }
      if (stage >= 2) h.reply("0600000e000e0205010000020103026464020301020400020501".chunked(2).map { it.toInt(16).toByte() }.toByteArray())
      if (stage >= 3) h.reply(byteArrayOf(0, 0, 0, 0, 0, 18))
      if (stage >= 4) h.reply(byteArrayOf(3))
      assertFalse(h.updater.snapshot.safeToRelease)
      val writes = h.writes.size
      val preparations = h.prepareCallbacks.size
      val recovered = NimoFirmwareUpdater("device", 2, h, h.directory)
      assertEquals(stage < 4, recovered.snapshot.safeToRelease)
      assertEquals(if (stage < 4) "failed" else "interrupted", recovered.snapshot.phase)
      assertEquals(writes, h.writes.size); assertEquals(preparations, h.prepareCallbacks.size)
      if (stage < 4) {
        assertEquals("idle", recovered.acknowledge().phase)
      } else {
        assertEquals(0xE3, h.writes.last()[4].toInt() and 255)
        assertThrows(FirmwareUpdaterException::class.java) { recovered.acknowledge() }
        assertThrows(FirmwareUpdaterException::class.java) { recovered.reconcile() }
      }
      assertEquals(writes, h.writes.size) // No automatic retry, guessed resume, or reset.
    }
  }

  @Test fun oldPreparingJournalWithoutPreEntryProofRemainsUnsafe() = Harness().use { h ->
    FirmwareJournal("device", h.directory).write(FirmwareRecoveryRecord(
      FirmwareUpdateSnapshot("nimo", "device", 1, phase = "preparing", safeToRelease = false, sessionId = "old-session"), h.request))
    assertFalse(h.updater.snapshot.safeToRelease)
    assertThrows(FirmwareUpdaterException::class.java) { h.updater.acknowledge() }
    assertTrue(h.writes.isEmpty())
  }

  @Test fun latePreparationCannotStartAfterTimeoutOrReconnect() = Harness().use { h ->
    h.updater.start(h.request); h.timers[0]()
    assertEquals("failed", h.updater.snapshot.phase); assertTrue(h.updater.snapshot.safeToRelease)
    h.capacity = 244; h.prepareCallbacks[0](null)
    assertTrue(h.writes.isEmpty()); assertEquals(1, h.releases)
    h.updater.acknowledge(); h.updater.start(h.request)
    h.generation = 2; h.prepareCallbacks[1](null)
    assertTrue(h.writes.isEmpty()); assertTrue(h.updater.snapshot.safeToRelease)
  }

  @Test fun recoveryRetryRebindsAfterPreparationFailsOnNewConnection() = Harness().use { h ->
    val interrupted = FirmwareUpdateSnapshot("nimo", "device", 1, phase = "interrupted", safeToRelease = false, sessionId = "native-session")
    FirmwareJournal("device", h.directory).write(FirmwareRecoveryRecord(interrupted, h.request, recoveryStage = "synchronized"))
    h.updater.reconcile()
    h.prepareCallbacks[0](Exception("not ready"))
    h.generation = 2
    h.updater.connected(NimoFirmwareUpdater.Connection("device", 2, 244))
    h.prepareCallbacks[1](Exception("not ready yet"))
    h.updater.reconcile()
    h.capacity = 244; h.prepareCallbacks[2](null)
    h.inventoryCallbacks.last()(Result.success(NimoOtaManager.Inventory("full-target", "0.1.1.1")))
    val sent = h.writes.last()
    val body = "0600000100010205010000020103026464020301020400020501".chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    val length = body.size + 2
    val reply = byteArrayOf(0x70, 7, 0x6e, 0, sent[4], (length shr 8).toByte(), length.toByte(), 0, sent[7]) + body + 0x33.toByte()
    h.updater.receive(reply, 1)
    assertFalse(h.updater.snapshot.safeToRelease)
    h.updater.receive(reply, 2)
    assertEquals("complete", h.updater.snapshot.phase)
    assertTrue(h.updater.snapshot.safeToRelease)
    assertEquals(1, h.writes.size)
  }

  @Test fun corruptJournalNeverAuthorizesStartOrAcknowledgement() = Harness().use { h ->
    val name = MessageDigest.getInstance("SHA-256").digest("device".toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
    File(h.directory, "$name.json").writeText("broken")
    assertFalse(h.updater.snapshot.safeToRelease)
    assertThrows(FirmwareUpdaterException::class.java) { h.updater.start(h.request) }
    assertThrows(FirmwareUpdaterException::class.java) { h.updater.acknowledge() }
    assertTrue(h.writes.isEmpty())
  }

  @Test fun coldRecoveryRetainsSyncEvidenceWithoutReplayingFlash() = Harness().use { h ->
    val interrupted = FirmwareUpdateSnapshot("nimo", "device", 0, sessionId = "native-session", phase = "interrupted", safeToRelease = false)
    FirmwareJournal("device", h.directory).write(FirmwareRecoveryRecord(interrupted, h.request, recoveryStage = "synchronized"))
    assertTrue(h.updater.snapshot.canReconcile)
    assertTrue(h.writes.isEmpty()); assertTrue(h.prepareCallbacks.isEmpty())
    h.updater.reconcile(); assertEquals(1, h.prepareCallbacks.size)
    h.capacity = 244; h.prepareCallbacks[0](null)
    assertEquals("verifying", h.updater.snapshot.phase)
    assertTrue(h.writes.isEmpty()) // Fresh inventory query, never ENTER or RESET.
  }

  @Test fun observersAreOrderedAcrossReentrantPublication() {
    val state = FirmwareSessionState(FirmwareUpdateSnapshot("test", "device", 1), publish = {})
    val revisions = mutableListOf<Int>(); val second = mutableListOf<Int>()
    val unsubscribe = state.observe { snapshot ->
      revisions += snapshot.revision
      if (snapshot.revision == 1) {
        state.update { it.copy(phase = "complete") }
        state.observe { second += it.revision }
      }
    }
    state.update { it.copy(phase = "preparing") }; unsubscribe()
    assertEquals(listOf(0, 1, 2), revisions); assertEquals(listOf(2), second)
  }
}
