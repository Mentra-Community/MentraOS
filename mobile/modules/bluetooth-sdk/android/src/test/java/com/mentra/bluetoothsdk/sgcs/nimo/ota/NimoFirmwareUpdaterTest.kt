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
    val writes = mutableListOf<ByteArray>()
    val timers = mutableListOf<() -> Unit>()
    var releases = 0
    val updater by lazy { NimoFirmwareUpdater("device", generation, this, directory) }
    override fun connection() = NimoFirmwareUpdater.Connection("device", generation, capacity)
    override fun prepare(completion: (Throwable?) -> Unit) { prepareCallbacks += completion }
    override fun release() { releases++ }
    override fun write(data: ByteArray, completion: (Throwable?) -> Unit) { writes += data; completion(null) }
    override fun readInventory(completion: (Result<NimoOtaManager.Inventory>) -> Unit) {}
    override fun schedule(delayMs: Long, callback: () -> Unit): () -> Unit {
      var cancelled = false; timers += { if (!cancelled) callback() }; return { cancelled = true }
    }
    override fun nowMs() = 0L
    override fun close() { directory.deleteRecursively() }
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

  @Test fun latePreparationCannotStartAfterTimeoutOrReconnect() = Harness().use { h ->
    h.updater.start(h.request); h.timers[0]()
    assertEquals("failed", h.updater.snapshot.phase); assertTrue(h.updater.snapshot.safeToRelease)
    h.capacity = 244; h.prepareCallbacks[0](null)
    assertTrue(h.writes.isEmpty()); assertEquals(1, h.releases)
    h.updater.acknowledge(); h.updater.start(h.request)
    h.generation = 2; h.prepareCallbacks[1](null)
    assertTrue(h.writes.isEmpty()); assertTrue(h.updater.snapshot.safeToRelease)
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
