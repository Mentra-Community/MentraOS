package com.mentra.bluetoothsdk.sgcs.nimo.ota

import java.security.MessageDigest

/** Native single-attempt updater. All methods and callbacks run on the SGC's serial executor.
 * No failure path sends reset or guesses a resume offset. UI subscriptions do not own this object. */
internal class NimoOtaManager(
  firmware: ByteArray,
  target: Target,
  writeCapacity: Int,
  connectionGeneration: Int,
  private val ports: Ports,
  recoveringReboot: Boolean = false,
) {
  data class Target(val sha256: String, val size: Int, val hardwareId: ByteArray,
    val firmwareDetail: String, val packedVersion: String, val peerVersion: ByteArray)
  data class Inventory(val firmwareDetail: String, val packedVersion: String)
  data class Snapshot(val phase: String = "idle", val progress: Double? = null,
    val safeToRelease: Boolean = true, val error: String? = null, val observedFirmware: String? = null)
  interface Ports {
    fun nowMs(): Long
    fun schedule(delayMs: Long, callback: () -> Unit): () -> Unit
    /** Completion means submitted using native write-without-response backpressure, not a device ACK. */
    fun write(data: ByteArray, completion: (Throwable?) -> Unit)
    fun readInventory(completion: (Result<Inventory>) -> Unit)
    /** Persist atomically or throw. Called before any command that enters upgrade mode. */
    fun journal(snapshot: Snapshot)
    fun changed(snapshot: Snapshot)
  }
  private data class Pending(val command: Int, val sequence: Int, val id: Long, val callback: (Result<ByteArray>) -> Unit)

  var snapshot = Snapshot()
    private set
  private val firmware = firmware.copyOf()
  private val target = target.copy(hardwareId = target.hardwareId.copyOf(), peerVersion = target.peerVersion.copyOf())
  private var capacity = minOf(512, writeCapacity)
  private var generation = connectionGeneration
  private val decoder = NimoOtaProtocol.Decoder()
  private var sequence = 0
  private var exchangeId = 0L
  private var pending: Pending? = null
  private var cancelTimer: (() -> Unit)? = null
  private var cancelDelay: (() -> Unit)? = null
  private var entered = false
  private var rebootAttempted = false
  private var crc = false
  private val covered = BooleanArray(firmware.size)
  private var coveredCount = 0
  private var stalls = 0
  private var transferStarted = 0L
  private var syncPending = 0
  private var syncFailures = 0
  private var operation = 0

  init {
    if (recoveringReboot) {
      entered = true; rebootAttempted = true
      snapshot = snapshot.copy(phase = "interrupted", safeToRelease = false)
    }
  }

  /** Inspection only, including after process restart with a validated reboot-stage journal. */
  fun reconcileAfterReboot() {
    if (!rebootAttempted || (snapshot.phase != "interrupted" && snapshot.phase != "restarting")) return
    clearExchange(); cancelDelay?.invoke(); cancelDelay = null
    verifyReadback()
  }

  fun start() {
    if (snapshot.phase != "idle") return
    transition("preparing", false)
    try {
      val hash = MessageDigest.getInstance("SHA-256").digest(firmware).joinToString("") { "%02x".format(it.toInt() and 255) }
      require(firmware.size == target.size && firmware.isNotEmpty() && hash == target.sha256.lowercase() &&
        target.hardwareId.size == 4 && target.peerVersion.size == 2 && target.firmwareDetail.isNotEmpty() &&
        target.packedVersion.isNotEmpty() && capacity > 20) { "Firmware identity or OTA write capacity is invalid" }
    } catch (error: Exception) { fail(error); return }
    exchange(NimoOtaProtocol.INFO, ByteArray(4) { 255.toByte() }) { info ->
      validateInfo(info, false)
      exchange(NimoOtaProtocol.FILE_OFFSET) { body ->
        val header = NimoOtaProtocol.firmwareSlice(firmware, NimoOtaProtocol.fileOffset(body))
        exchange(NimoOtaProtocol.CAN_UPDATE, header) { result ->
          require(result.contentEquals(byteArrayOf(0)) || result.contentEquals(byteArrayOf(3))) { "Glasses refused this firmware or prerequisites" }
          ports.journal(snapshot)
          // A lost send outcome cannot prove entry failed. Keep ownership after this boundary.
          entered = true
          exchange(NimoOtaProtocol.ENTER) { entryBody ->
            val entry = NimoOtaProtocol.enterResult(entryBody)
            crc = entry.crc
            transferStarted = ports.nowMs()
            transition("transferring", false, 0.0)
            sendBlock(entry.slice)
          }
        }
      }
    }
  }

  fun receive(data: ByteArray, connectionGeneration: Int) {
    if (connectionGeneration != generation || snapshot.phase == "interrupted") return
    try {
      for (reply in decoder.feed(data)) {
        val expected = pending ?: continue
        if (expected.command != reply.command || expected.sequence != reply.sequence) continue
        pending = null
        cancelTimer?.invoke(); cancelTimer = null
        if (reply.status == 0) expected.callback(Result.success(reply.body))
        else expected.callback(Result.failure(IllegalStateException("OTA command ${reply.command} returned status ${reply.status}")))
      }
    } catch (error: Exception) { fail(error) }
  }

  fun disconnected(connectionGeneration: Int) {
    if (connectionGeneration != generation || snapshot.safeToRelease) return
    if (snapshot.phase == "restarting") clearExchange() // Preserve reconnect deadline; SGC reconnects same device.
    else fail(IllegalStateException("Connection lost; transfer recovery requires device inspection"))
  }

  /** Only called when the same physical device's OTA channel is ready on a new connection. */
  fun reconnected(connectionGeneration: Int, writeCapacity: Int) {
    if ((snapshot.phase != "restarting" && !(snapshot.phase == "interrupted" && rebootAttempted)) || connectionGeneration == generation) return
    generation = connectionGeneration
    capacity = minOf(512, writeCapacity)
    decoder.reset()
    cancelDelay?.invoke(); cancelDelay = null
    verifyReadback()
  }

  private fun verifyReadback() {
    snapshot = snapshot.copy(error = null)
    transition("verifying", false)
    val currentOperation = operation
    val currentGeneration = generation
    cancelTimer = ports.schedule(30000) { fail(IllegalStateException("Firmware readback timed out")) }
    ports.readInventory { result ->
      if (operation == currentOperation && generation == currentGeneration && snapshot.phase == "verifying") {
        cancelTimer?.invoke(); cancelTimer = null
        result.fold(onSuccess = { inventory ->
          snapshot = snapshot.copy(observedFirmware = inventory.firmwareDetail)
          if (inventory.firmwareDetail != target.firmwareDetail || inventory.packedVersion != target.packedVersion) {
            fail(IllegalStateException("Observed firmware does not match the approved target"))
          } else {
            exchange(NimoOtaProtocol.INFO, ByteArray(4) { 255.toByte() }) { body ->
              validateInfo(body, true)
              transition("complete", true)
              ports.journal(snapshot)
            }
          }
        }, onFailure = ::fail)
      }
    }
  }

  private fun validateInfo(body: ByteArray, verifying: Boolean) {
    val fields = NimoOtaProtocol.deviceInfo(body)
    val batteries = fields[2]
    require(fields[1]?.contentEquals(target.hardwareId) == true && fields[3]?.contentEquals(byteArrayOf(1)) == true &&
      fields[5]?.contentEquals(byteArrayOf(1)) == true && batteries?.size == 2 && batteries.all { (it.toInt() and 255) <= 100 }) {
      "Glasses identity, both batteries, or peer readiness is unavailable"
    }
    // CAN_UPDATE decides the vendor battery threshold; don't borrow Live's threshold.
    if (verifying) {
      val versions = fields[0]
      require(versions?.size == 5 && versions.copyOfRange(0, 2).contentEquals(target.peerVersion) &&
        versions.copyOfRange(2, 4).contentEquals(target.peerVersion)) { "The two glasses firmware versions have not converged" }
    }
  }

  private fun sendBlock(slice: NimoOtaProtocol.Slice) {
    check(ports.nowMs() - transferStarted <= 1200000) { "Transfer exceeded its 20-minute bound" }
    val parts = NimoOtaProtocol.blockParts(firmware, slice, crc, capacity)
    sendPart(parts, 0) { body ->
      val next = NimoOtaProtocol.blockResult(body)
      var added = 0
      for (index in slice.offset.toInt() until slice.offset.toInt() + slice.length) {
        if (!covered[index]) { covered[index] = true; added++ }
      }
      coveredCount += added
      stalls = if (added == 0) stalls + 1 else 0
      check(stalls < 5) { "Five repeated blocks without progress" }
      transition("transferring", false, coveredCount.toDouble() / firmware.size)
      if (next.slice.offset == 0L && next.slice.length == 0) {
        transition("validating", false)
        exchange(NimoOtaProtocol.VALIDATE, timeoutMs = 30000) { validation ->
          require(validation.contentEquals(byteArrayOf(0))) { "Device image validation failed" }
          transition("synchronizing", false)
          pollSync()
        }
      } else {
        NimoOtaProtocol.firmwareSlice(firmware, next.slice)
        delay(next.delayMs.toLong()) {
          try { sendBlock(next.slice) } catch (error: Exception) { fail(error) }
        }
      }
    }
  }

  private fun sendPart(parts: List<ByteArray>, index: Int, completion: (ByteArray) -> Unit) {
    if (index == parts.lastIndex) exchange(NimoOtaProtocol.BLOCK, parts[index], 30000, completion)
    else {
      try {
        val packet = nextPacket(NimoOtaProtocol.BLOCK, parts[index])
        val currentOperation = operation
        cancelTimer = ports.schedule(30000) { fail(IllegalStateException("OTA write queue stalled")) }
        ports.write(packet) { error ->
          if (operation == currentOperation) {
            cancelTimer?.invoke(); cancelTimer = null
            if (error != null) fail(error)
            else delay(5) { sendPart(parts, index + 1, completion) }
          }
        }
      } catch (error: Exception) { fail(error) }
    }
  }

  private fun pollSync() {
    exchangeResult(NimoOtaProtocol.SYNC, timeoutMs = 8000) { result ->
      val body = result.getOrNull()
      when {
        body?.contentEquals(byteArrayOf(0)) == true -> {
          try {
            transition("restarting", false)
            ports.journal(snapshot)
            val packet = nextPacket(NimoOtaProtocol.RESET, byteArrayOf(0))
            rebootAttempted = true
            ports.write(packet) { error -> if (error != null && snapshot.phase == "restarting") fail(error) }
            if (snapshot.phase == "restarting") delay(180000) { fail(IllegalStateException("Reconnect and firmware verification are still required")) }
          } catch (error: Exception) { fail(error) }
        }
        else -> {
          if (body?.contentEquals(byteArrayOf(1)) == true) syncPending++ else syncFailures++
          if (syncPending >= 180 || syncFailures >= 8) fail(IllegalStateException("Peer synchronization is unconfirmed; no reboot was sent"))
          else delay(1000) { pollSync() }
        }
      }
    }
  }

  private fun exchange(command: Int, params: ByteArray = byteArrayOf(), timeoutMs: Long = 15000, completion: (ByteArray) -> Unit) {
    exchangeResult(command, params, timeoutMs) { result ->
      try { completion(result.getOrThrow()) } catch (error: Exception) { fail(error) }
    }
  }

  private fun exchangeResult(command: Int, params: ByteArray = byteArrayOf(), timeoutMs: Long, completion: (Result<ByteArray>) -> Unit) {
    try {
      val packet = nextPacket(command, params)
      val id = ++exchangeId
      val currentOperation = operation
      pending = Pending(command, sequence, id, completion)
      cancelTimer = ports.schedule(timeoutMs) {
        if (pending?.id == id && operation == currentOperation) {
          pending = null; cancelTimer = null
          completion(Result.failure(IllegalStateException("OTA command $command timed out")))
        }
      }
      ports.write(packet) { error ->
        if (error != null && operation == currentOperation && pending?.id == id) {
          clearExchange()
          completion(Result.failure(error))
        }
      }
    } catch (error: Exception) { completion(Result.failure(error)) }
  }

  private fun nextPacket(command: Int, params: ByteArray = byteArrayOf()): ByteArray {
    sequence = (sequence + 1) and 255
    val packet = NimoOtaProtocol.request(command, sequence, params)
    require(packet.size <= capacity) { "OTA request exceeds the negotiated write capacity" }
    return packet
  }

  private fun delay(delayMs: Long, callback: () -> Unit) {
    cancelDelay?.invoke()
    val currentOperation = operation
    cancelDelay = ports.schedule(delayMs) {
      if (operation == currentOperation) { cancelDelay = null; callback() }
    }
  }

  private fun clearExchange() {
    cancelTimer?.invoke(); cancelTimer = null
    pending = null
    decoder.reset()
  }

  private fun transition(phase: String, safe: Boolean, progress: Double? = null) {
    snapshot = snapshot.copy(phase = phase, progress = progress, safeToRelease = safe)
    ports.changed(snapshot)
  }

  private fun fail(error: Throwable) {
    if (snapshot.phase == "complete") return
    operation++
    clearExchange()
    cancelDelay?.invoke(); cancelDelay = null
    snapshot = snapshot.copy(error = error.message ?: "OTA interrupted")
    transition(if (entered) "interrupted" else "failed", !entered)
    try { ports.journal(snapshot) } catch (_: Exception) { /* A failed journal never authorizes a write. */ }
  }
}
