package com.mentra.bluetoothsdk.sgcs.nimo.ota

import java.security.MessageDigest
import org.junit.Assert.*
import org.junit.Test

class NimoOtaManagerTest {
  private fun bytes(hex: String) = hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
  private inner class Harness(hashValid: Boolean = true, capacity: Int = 512) : NimoOtaManager.Ports {
    val firmware = ByteArray(1024) { (it % 256).toByte() }
    val target = NimoOtaManager.Target(
      if (hashValid) MessageDigest.getInstance("SHA-256").digest(firmware).joinToString("") { "%02x".format(it.toInt() and 255) } else "invalid",
      firmware.size, bytes("00000201"), "FW-VERSION-v0.1.1.1-approved", "0.1.1.1", bytes("0001"))
    val manager = NimoOtaManager(firmware, target, capacity, 1, this)
    val writes = mutableListOf<ByteArray>()
    val snapshots = mutableListOf<NimoOtaManager.Snapshot>()
    val journals = mutableListOf<NimoOtaManager.Snapshot>()
    var journalFails = false
    var holdWrite = false
    var readback: ((Result<NimoOtaManager.Inventory>) -> Unit)? = null
    var now = 0L
    private var id = 0
    private val timers = mutableMapOf<Int, Pair<Long, () -> Unit>>()
    val command: Int get() = writes.last()[4].toInt() and 255
    override fun nowMs() = now
    override fun schedule(delayMs: Long, callback: () -> Unit): () -> Unit {
      val token = ++id; timers[token] = (now + delayMs) to callback
      return { timers.remove(token); Unit }
    }
    fun advance(ms: Long) {
      val end = now + ms
      while (true) {
        val next = timers.entries.filter { it.value.first <= end }.minWithOrNull(compareBy({ it.value.first }, { it.key })) ?: break
        now = next.value.first; timers.remove(next.key); next.value.second()
      }
      now = end
    }
    override fun write(data: ByteArray, completion: (Throwable?) -> Unit) { writes += data; if (!holdWrite) completion(null) }
    override fun readInventory(completion: (Result<NimoOtaManager.Inventory>) -> Unit) { readback = completion }
    override fun journal(snapshot: NimoOtaManager.Snapshot) { if (journalFails) error("Journal unavailable"); journals += snapshot }
    override fun changed(snapshot: NimoOtaManager.Snapshot) { snapshots += snapshot }
    fun reply(body: ByteArray, generation: Int = 1, status: Int = 0) {
      val sent = writes.last()
      val length = body.size + 2
      manager.receive(byteArrayOf(0x70, 7, 0x6e, 0, sent[4], (length shr 8).toByte(), length.toByte(), status.toByte(), sent[7]) + body + 0x33.toByte(), generation)
    }
    fun info(peer: String = "000e000e") = bytes("0600${peer}0205010000020103026464020301020400020501")
    fun preflight() {
      manager.start(); reply(info()); assertEquals(0xE1, command)
      reply(bytes("000000000012")); assertEquals(0xE2, command)
      reply(byteArrayOf(3))
    }
    fun transfer() {
      preflight(); assertEquals(0xE3, command)
      reply(bytes("0000000012038401")) // offset 18, 900 bytes, per-chunk CRC
      advance(5) // second/final block chunk
      assertEquals(0xE5, command)
      reply(ByteArray(9)); assertEquals(0xE6, command)
      reply(byteArrayOf(0)); assertEquals(0xE8, command)
    }
  }

  @Test fun verifiesImageAndBothSidesBeforeResetThenRequiresActualReadback() {
    val h = Harness(); h.transfer()
    h.reply(byteArrayOf(1)); assertFalse(h.writes.any { it[4] == 3.toByte() })
    h.advance(1000); h.reply(byteArrayOf(0))
    assertEquals(3, h.command); assertEquals("restarting", h.manager.snapshot.phase)
    assertFalse(h.manager.snapshot.safeToRelease)
    h.manager.disconnected(1)
    h.manager.reconnected(2, 244)
    assertEquals("verifying", h.manager.snapshot.phase)
    h.readback!!(Result.success(NimoOtaManager.Inventory(h.target.firmwareDetail, h.target.packedVersion)))
    h.reply(h.info("00010001"), generation = 2)
    assertEquals("complete", h.manager.snapshot.phase)
    assertTrue(h.manager.snapshot.safeToRelease)
    assertEquals(h.target.firmwareDetail, h.manager.snapshot.observedFirmware)
    assertEquals("preparing", h.journals.first().phase)
  }

  @Test fun noWriteOnHashFailureAndNoEntryWhenJournalFails() {
    val bad = Harness(hashValid = false); bad.manager.start()
    assertTrue(bad.writes.isEmpty()); assertTrue(bad.manager.snapshot.safeToRelease)
    val h = Harness(); h.journalFails = true; h.preflight()
    assertEquals("failed", h.manager.snapshot.phase)
    assertTrue(h.manager.snapshot.safeToRelease)
    assertFalse(h.writes.any { it[4] == 0xE3.toByte() })
  }

  @Test fun duplicateStartAndOldConnectionResponsesDoNotAdvanceOrRestart() {
    val h = Harness(); h.manager.start(); h.manager.start()
    assertEquals(1, h.writes.size)
    h.reply(h.info(), generation = 0); assertEquals(1, h.writes.size)
    h.advance(15000)
    assertEquals("failed", h.manager.snapshot.phase)
    assertTrue(h.manager.snapshot.safeToRelease)
  }

  @Test fun entryTimeoutAndMidTransferDisconnectRetainOwnershipWithoutReset() {
    val h = Harness(); h.preflight(); h.advance(15000)
    assertEquals("interrupted", h.manager.snapshot.phase)
    assertFalse(h.manager.snapshot.safeToRelease)
    val count = h.writes.size
    h.manager.start(); h.manager.reconnected(2, 512); h.advance(200000)
    assertEquals(count, h.writes.size)
    val during = Harness(); during.preflight(); during.reply(bytes("0000000012038401"))
    during.manager.disconnected(1); during.advance(10000)
    assertEquals("interrupted", during.manager.snapshot.phase)
    assertFalse(during.writes.any { it[4] == 3.toByte() })
  }

  @Test fun rejectedImageNeverReboots() {
    val h = Harness(); h.preflight(); h.reply(bytes("0000000012038401")); h.advance(5)
    h.reply(ByteArray(9)); h.reply(byteArrayOf(1))
    assertEquals("interrupted", h.manager.snapshot.phase)
    assertFalse(h.writes.any { it[4] == 3.toByte() || it[4] == 0xE8.toByte() })
  }

  @Test fun syncTimeoutBudgetNeverAuthorizesReset() {
    val h = Harness(); h.transfer()
    h.advance(8 * 9000L)
    assertEquals("interrupted", h.manager.snapshot.phase)
    assertFalse(h.manager.snapshot.safeToRelease)
    assertEquals(8, h.writes.count { it[4] == 0xE8.toByte() })
    assertFalse(h.writes.any { it[4] == 3.toByte() })
  }

  @Test fun syncPendingBudgetIsSeparateFromTransientFailureBudget() {
    val h = Harness(); h.transfer()
    repeat(7) { h.reply(byteArrayOf(2)); h.advance(1000) }
    repeat(179) { h.reply(byteArrayOf(1)); h.advance(1000) }
    assertEquals("synchronizing", h.manager.snapshot.phase)
    h.reply(byteArrayOf(1))
    assertEquals("interrupted", h.manager.snapshot.phase)
    assertFalse(h.writes.any { it[4] == 3.toByte() })
  }

  @Test fun wrongReadbackAndPeerMismatchAreNotSuccess() {
    val wrong = Harness(); wrong.transfer(); wrong.reply(byteArrayOf(0)); wrong.manager.reconnected(2, 512)
    wrong.readback!!(Result.success(NimoOtaManager.Inventory("wrong", wrong.target.packedVersion)))
    assertEquals("interrupted", wrong.manager.snapshot.phase)
    val peer = Harness(); peer.transfer(); peer.reply(byteArrayOf(0)); peer.manager.reconnected(2, 512)
    peer.readback!!(Result.success(NimoOtaManager.Inventory(peer.target.firmwareDetail, peer.target.packedVersion)))
    peer.reply(peer.info("0001000e"), generation = 2)
    assertEquals("interrupted", peer.manager.snapshot.phase)
    assertFalse(peer.manager.snapshot.safeToRelease)
  }

  @Test fun lateReconnectCanVerifyButNeverReflashAfterRebootDeadline() {
    val h = Harness(); h.transfer(); h.reply(byteArrayOf(0)); h.advance(180000)
    assertEquals("interrupted", h.manager.snapshot.phase)
    h.manager.reconnected(2, 512)
    assertEquals("verifying", h.manager.snapshot.phase)
    h.readback!!(Result.success(NimoOtaManager.Inventory(h.target.firmwareDetail, h.target.packedVersion)))
    h.reply(h.info("00010001"), generation = 2)
    assertEquals("complete", h.manager.snapshot.phase)
    assertEquals(1, h.writes.count { it[4] == 0xE3.toByte() })
    assertEquals(1, h.writes.count { it[4] == 3.toByte() })
  }

  @Test fun invalidRequestedSliceAndStalledNativeQueueDoNotContinue() {
    val bounds = Harness(); bounds.preflight(); bounds.reply(bytes("00ffffffffffff01"))
    assertEquals("interrupted", bounds.manager.snapshot.phase)
    assertFalse(bounds.writes.any { it[4] == 0xE5.toByte() })
    val queue = Harness(); queue.preflight(); queue.holdWrite = true; queue.reply(bytes("0000000012038401"))
    queue.advance(30000)
    assertEquals("interrupted", queue.manager.snapshot.phase)
    assertEquals(1, queue.writes.count { it[4] == 0xE5.toByte() })
  }
}
