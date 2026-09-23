package com.mentra.bluetoothsdk.sgcs.nimo.ota

import com.mentra.bluetoothsdk.sgcs.firmware.*
import java.io.File
import java.net.URI
import java.util.UUID

/** Owns admission before notification setup; the SGC retains this object across transient link loss. */
internal class NimoFirmwareUpdater(deviceId: String, connectionGeneration: Int, private val ports: Ports, journalDirectory: File) : FirmwareUpdater {
  data class Connection(val deviceId: String, val generation: Int, val writeCapacity: Int)
  interface Ports {
    fun connection(): Connection?
    fun prepare(completion: (Throwable?) -> Unit)
    fun release()
    fun write(data: ByteArray, completion: (Throwable?) -> Unit)
    fun readInventory(completion: (Result<NimoOtaManager.Inventory>) -> Unit)
    fun schedule(delayMs: Long, callback: () -> Unit): () -> Unit
    fun nowMs(): Long
    fun isCompatible(fullVersion: String, packedVersion: String): Boolean = false
    fun configureCompatibility(metadata: Map<String, String>) {
      throw FirmwareUpdaterException("unsupported", "NIMO compatibility policy is unavailable")
    }
  }
  private val state = FirmwareSessionState(FirmwareUpdateSnapshot("nimo", deviceId, connectionGeneration))
  override val snapshot: FirmwareUpdateSnapshot get() = state.snapshot
  override fun configure(metadata: Map<String, String>): FirmwareUpdateSnapshot {
    if (!snapshot.safeToRelease || preparing) throw FirmwareUpdaterException("busy", "The active NIMO update owns its policy")
    connected()
    ports.configureCompatibility(metadata)
    state.update { it.copy(inventory = it.inventory + ("compatible" to ports.isCompatible(it.observedFirmware.orEmpty(), it.inventory["packedVersion"].orEmpty()).toString())) }
    return snapshot
  }
  private var journal: FirmwareJournal? = null
  private var request: FirmwareStartRequest? = null
  private var manager: NimoOtaManager? = null
  private var owned = false
  private var operation = 0
  private var preparing = false
  private var preparationGeneration = 0
  private var cancelPrepare: (() -> Unit)? = null
  private var rebootEvidence = false

  init {
    try {
      val storage = FirmwareJournal(deviceId, journalDirectory)
      journal = storage
      storage.read()?.let { record ->
        require(record.snapshot.integrationId == "nimo" && record.request.kind == "file") { "Recovery record belongs to another updater" }
        request = record.request
        rebootEvidence = record.recoveryStage == "synchronized" || record.snapshot.phase in listOf("restarting", "verifying", "complete")
        state.update { initial ->
          record.snapshot.copy(updaterId = initial.updaterId, connectionGeneration = connectionGeneration,
            phase = if (record.snapshot.safeToRelease) record.snapshot.phase else "interrupted",
            error = if (record.snapshot.safeToRelease) record.snapshot.error else "A previous firmware update requires device inspection",
            canReconcile = rebootEvidence && !record.snapshot.safeToRelease)
        }
      }
    } catch (error: Exception) {
      state.update { it.copy(phase = "interrupted", safeToRelease = false, error = "Firmware recovery information is unavailable: ${error.message}") }
    }
  }

  override fun observe(listener: (FirmwareUpdateSnapshot) -> Unit) = state.observe(listener)

  override fun start(request: FirmwareStartRequest): FirmwareUpdateSnapshot {
    if (request.deviceId != snapshot.deviceId) throw FirmwareUpdaterException("wrong_device", "The update belongs to another device")
    if (snapshot.sessionId != null || !snapshot.safeToRelease) {
      if (request.offerId == snapshot.offerId && !snapshot.safeToRelease) return snapshot
      throw FirmwareUpdaterException("busy", "A previous update still owns this device or awaits acknowledgement")
    }
    val connection = connected()
    if (request.connectionGeneration != connection.generation) throw FirmwareUpdaterException("stale_offer", "The device reconnected; check the update again")
    val artifact = request.artifact
    if (request.offerId.isEmpty() || request.kind != "file" || artifact?.size == null || artifact.size !in 1..(32 * 1024 * 1024)) {
      throw FirmwareUpdaterException("invalid_artifact", "NIMO requires a bounded, verified firmware file")
    }
    val target = target(request)
    val storage = journal ?: throw FirmwareUpdaterException("invalid_journal", "Firmware recovery storage is unavailable")
    val recoveryRequest = request.copy(manifestUrl = null,
      metadata = request.metadata.filterKeys { it in setOf("hardwareId", "packedVersion", "peerVersion") })
    this.request = recoveryRequest
    operation++
    state.update { it.copy(sessionId = UUID.randomUUID().toString(), offerId = request.offerId, phase = "preparing",
      safeToRelease = false, targetFirmware = target.firmwareDetail, error = null) }
    try {
      val file = if (artifact.path.startsWith("file://")) File(URI(artifact.path)) else File(artifact.path)
      require(file.isAbsolute && file.isFile && file.length() == artifact.size.toLong()) { "Firmware file size or location changed" }
      val firmware = file.inputStream().use { input ->
        // Bound allocation even if another writer grows the file after stat.
        val bytes = ByteArray(artifact.size)
        var read = 0
        while (read < bytes.size) {
          val count = input.read(bytes, read, bytes.size - read)
          check(count > 0) { "Firmware file was truncated" }; read += count
        }
        check(input.read() == -1) { "Firmware file grew after validation" }
        bytes
      }
      storage.write(FirmwareRecoveryRecord(snapshot, recoveryRequest))
      prepare {
        ports.connection()?.let { ready -> manager = makeManager(firmware, target, ready); manager?.start() }
      }
    } catch (error: Exception) { preparationFailed(error) }
    return snapshot
  }

  override fun reconcile(): FirmwareUpdateSnapshot {
    val connection = connected()
    if (snapshot.phase == "idle" || snapshot.safeToRelease) {
      ports.readInventory { result ->
        if (ports.connection()?.generation == connection.generation) result.getOrNull()?.let { inventoryChanged(it, connection.generation) }
      }
      return snapshot
    }
    if (preparing) return snapshot
    if (snapshot.phase != "interrupted") return snapshot
    if (!rebootEvidence) throw FirmwareUpdaterException("recovery_required", "Interrupted transfer recovery must be confirmed with NIMO; no reset was sent")
    if (manager == null) {
      val saved = request ?: throw FirmwareUpdaterException("invalid_journal", "The update target is unavailable")
      manager = makeManager(byteArrayOf(), target(saved), connection, true)
    }
    prepare { manager?.reconcileAfterReboot() }
    return snapshot
  }

  override fun cancel(): FirmwareUpdateSnapshot = throw FirmwareUpdaterException("action_unavailable", "NIMO has no verified safe abort command")

  override fun acknowledge(): FirmwareUpdateSnapshot {
    if (!snapshot.safeToRelease || preparing) throw FirmwareUpdaterException("busy", "The glasses still require update recovery")
    journal?.remove()
    operation++; manager = null; request = null; rebootEvidence = false
    state.update { it.copy(sessionId = null, offerId = null, phase = "idle", progress = null, targetFirmware = null, error = null, canReconcile = false) }
    return snapshot
  }

  fun receive(data: ByteArray, connectionGeneration: Int) { manager?.receive(data, connectionGeneration) }
  fun disconnected(connectionGeneration: Int) {
    if (snapshot.connectionGeneration != connectionGeneration) return
    if (preparing) preparationFailed(FirmwareUpdaterException("disconnected", "Device disconnected during OTA preparation"))
    manager?.disconnected(connectionGeneration)
  }
  fun connected(connection: Connection) {
    if (connection.deviceId != snapshot.deviceId) return
    connectionChanged(connection.deviceId, connection.generation)
    if (manager != null && rebootEvidence && !snapshot.safeToRelease) {
      prepare { ports.connection()?.let { ready -> manager?.reconnected(ready.generation, ready.writeCapacity) } }
    }
  }
  /** Ordinary version replies must use the new link before OTA channel preparation is relevant. */
  fun connectionChanged(deviceId: String, generation: Int) {
    if (deviceId == snapshot.deviceId) state.update { it.copy(connectionGeneration = generation) }
  }
  fun inventoryChanged(inventory: NimoOtaManager.Inventory, connectionGeneration: Int) {
    if (snapshot.connectionGeneration != connectionGeneration) return
    state.update { it.copy(observedFirmware = inventory.firmwareDetail, inventory = it.inventory + mapOf(
      "packedVersion" to inventory.packedVersion,
      "compatible" to ports.isCompatible(inventory.firmwareDetail, inventory.packedVersion).toString(),
      "revision" to ((it.inventory["revision"]?.toLongOrNull() ?: 0L) + 1).toString(),
    )) }
  }

  private fun makeManager(firmware: ByteArray, target: NimoOtaManager.Target, connection: Connection, recoveringReboot: Boolean = false): NimoOtaManager {
    val admittedOperation = operation
    return NimoOtaManager(firmware, target, connection.writeCapacity, connection.generation, object : NimoOtaManager.Ports {
      override fun nowMs() = ports.nowMs()
      override fun schedule(delayMs: Long, callback: () -> Unit) = ports.schedule(delayMs, callback)
      override fun write(data: ByteArray, completion: (Throwable?) -> Unit) = ports.write(data, completion)
      override fun readInventory(completion: (Result<NimoOtaManager.Inventory>) -> Unit) = ports.readInventory(completion)
      override fun journal(snapshot: NimoOtaManager.Snapshot) {
        val saved = request; val storage = journal
        if (operation != admittedOperation || saved == null || storage == null) throw FirmwareUpdaterException("invalid_journal", "The update owner or recovery record changed")
        val record = this@NimoFirmwareUpdater.snapshot.copy(phase = snapshot.phase, safeToRelease = snapshot.safeToRelease,
          progress = snapshot.progress, error = snapshot.error)
        storage.write(FirmwareRecoveryRecord(record, saved, recoveryStage = if (rebootEvidence) "synchronized" else null))
      }
      override fun changed(snapshot: NimoOtaManager.Snapshot) {
        if (operation != admittedOperation) return
        if (snapshot.phase in listOf("restarting", "verifying")) rebootEvidence = true
        if (snapshot.safeToRelease) release()
        state.update { it.copy(phase = snapshot.phase, progress = snapshot.progress, safeToRelease = snapshot.safeToRelease,
          error = snapshot.error, canReconcile = rebootEvidence && !snapshot.safeToRelease,
          observedFirmware = snapshot.observedFirmware ?: it.observedFirmware) }
      }
    }, recoveringReboot)
  }

  private fun prepare(completion: () -> Unit) {
    if (preparing) return
    val connection = ports.connection()
    if (connection?.deviceId != snapshot.deviceId) { preparationFailed(FirmwareUpdaterException("disconnected", "The intended NIMO is not connected")); return }
    preparing = true; owned = true
    val preparation = ++preparationGeneration
    val expected = operation
    cancelPrepare = ports.schedule(30000) {
      if (operation == expected && preparationGeneration == preparation && preparing) preparationFailed(FirmwareUpdaterException("timeout", "OTA channel preparation timed out"))
    }
    ports.prepare { error ->
      if (operation == expected && preparationGeneration == preparation && preparing) {
        cancelPrepare?.invoke(); cancelPrepare = null; preparing = false
        if (error != null) preparationFailed(error)
        else if (ports.connection()?.generation != connection.generation || ports.connection()?.deviceId != connection.deviceId) {
          preparationFailed(FirmwareUpdaterException("stale_offer", "The NIMO connection changed during preparation"))
        } else completion()
      }
    }
  }

  private fun preparationFailed(error: Throwable) {
    preparationGeneration++
    cancelPrepare?.invoke(); cancelPrepare = null; preparing = false
    val safe = manager == null || manager?.snapshot?.phase == "idle" || manager?.snapshot?.safeToRelease == true
    if (safe) release()
    state.update { it.copy(phase = if (safe) "failed" else "interrupted", safeToRelease = safe, error = error.message) }
    request?.let { try { journal?.write(FirmwareRecoveryRecord(snapshot, it, recoveryStage = if (rebootEvidence) "synchronized" else null)) } catch (_: Exception) {} }
  }
  private fun release() { if (owned) { owned = false; ports.release() } }
  private fun connected(): Connection = ports.connection()?.takeIf { it.deviceId == snapshot.deviceId }
    ?: throw FirmwareUpdaterException("disconnected", "The intended NIMO is not connected")

  private fun target(request: FirmwareStartRequest): NimoOtaManager.Target {
    val artifact = request.artifact
    val hardware = hex(request.metadata["hardwareId"], 4)
    val peer = hex(request.metadata["peerVersion"], 2)
    val packed = request.metadata["packedVersion"]
    if (artifact?.sha256?.matches(Regex("[0-9a-fA-F]{64}")) != true || artifact.size == null || hardware == null || peer == null || packed.isNullOrEmpty() || artifact.targetVersion.isEmpty()) {
      throw FirmwareUpdaterException("invalid_artifact", "NIMO requires a SHA-256 pin and full target identity")
    }
    return NimoOtaManager.Target(artifact.sha256, artifact.size, hardware, artifact.targetVersion, packed, peer)
  }
  private fun hex(value: String?, count: Int): ByteArray? = value?.takeIf { it.matches(Regex("[0-9a-fA-F]{${count * 2}}")) }
    ?.chunked(2)?.map { it.toInt(16).toByte() }?.toByteArray()
}
