package com.mentra.bluetoothsdk.sgcs.ar99.ota

import com.mentra.bluetoothsdk.sgcs.firmware.*
import java.io.File
import java.security.MessageDigest
import java.util.UUID

/** Device/session ownership around the established wire manager; no guessed reset or resume offset. */
class Ar99FirmwareUpdater(deviceId: String, connectionGeneration: Int, private val ports: Ports, directory: File) : FirmwareUpdater {
  interface Ports {
    fun connected(): Boolean
    fun start(bytes: ByteArray, callback: Ar99OtaManager.OTACallback): Boolean
    fun queryInventory()
    fun reconnect() {}
  }
  private val state = FirmwareSessionState(FirmwareUpdateSnapshot("ar99", deviceId, connectionGeneration))
  private var journal: FirmwareJournal? = null
  private var request: FirmwareStartRequest? = null
  private var operation = 0
  private var entered = false
  @Volatile var legacyActive = false
    private set
  val ownsDevice: Boolean get() = legacyActive || !snapshot.safeToRelease
  override val snapshot: FirmwareUpdateSnapshot get() = state.snapshot

  init {
    try {
      val file = FirmwareJournal(deviceId, directory)
      journal = file
      file.read()?.let { record ->
        require(record.snapshot.integrationId == "ar99" && record.request.kind == "file") { "Invalid AR99 recovery identity" }
        request = record.request
        state.update { current ->
          record.snapshot.copy(updaterId = current.updaterId, connectionGeneration = connectionGeneration,
            phase = if (record.snapshot.safeToRelease) record.snapshot.phase else "interrupted",
            canReconcile = !record.snapshot.safeToRelease, canCancel = false,
            error = if (record.snapshot.safeToRelease) record.snapshot.error else
              "The previous AR99 transfer requires inspection; in-memory resume is unavailable after process restart")
        }
      }
    } catch (_: Exception) {
      state.update { it.copy(phase = "interrupted", safeToRelease = false, error = "AR99 recovery information is unavailable") }
    }
  }

  override fun observe(listener: (FirmwareUpdateSnapshot) -> Unit): () -> Unit = state.observe(listener)

  override fun start(request: FirmwareStartRequest): FirmwareUpdateSnapshot {
    if (request.deviceId != snapshot.deviceId) throw FirmwareUpdaterException("wrong_device", "AR99 target changed")
    if (ownsDevice || snapshot.sessionId != null) {
      if (!legacyActive && request.offerId == snapshot.offerId && !snapshot.safeToRelease) return snapshot
      throw FirmwareUpdaterException("busy", "An AR99 update already owns this device or awaits acknowledgement")
    }
    if (!ports.connected() || request.connectionGeneration != snapshot.connectionGeneration)
      throw FirmwareUpdaterException("stale_offer", "AR99 connection changed; check again")
    val artifact = request.artifact
    val size = artifact?.size
    val hash = artifact?.sha256
    val journal = journal ?: throw FirmwareUpdaterException("invalid_journal", "AR99 recovery storage is unavailable")
    if (request.kind != "file" || request.offerId.isEmpty() || artifact == null || artifact.targetVersion.isEmpty() ||
        size == null || size !in 1..64 * 1024 * 1024 || hash == null || !hash.matches(Regex("[a-fA-F0-9]{64}")))
      throw FirmwareUpdaterException("invalid_artifact", "AR99 requires a prepared firmware file and its byte identity")
    this.request = request
    entered = false
    val admitted = ++operation
    state.update { it.copy(sessionId = UUID.randomUUID().toString(), offerId = request.offerId, phase = "preparing",
      targetFirmware = artifact.targetVersion, safeToRelease = false, error = null, canReconcile = false) }
    try {
      val file = File(artifact.path.removePrefix("file://"))
      require(file.isAbsolute) { "AR99 firmware must be a local file" }
      val bytes = file.inputStream().use { input ->
        val output = java.io.ByteArrayOutputStream(size)
        val buffer = ByteArray(65536)
        while (output.size() < size) {
          val count = input.read(buffer, 0, minOf(buffer.size, size - output.size()))
          require(count > 0) { "AR99 firmware file was truncated" }
          output.write(buffer, 0, count)
        }
        require(input.read() == -1) { "AR99 firmware file grew after approval" }
        output.toByteArray()
      }
      val actual = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
      require(actual == hash.lowercase()) { "AR99 firmware bytes changed after approval" }
      this.request = request.copy(manifestUrl = null, metadata = emptyMap())
      journal.write(FirmwareRecoveryRecord(snapshot, this.request!!))
      entered = true
      val accepted = ports.start(bytes, object : Ar99OtaManager.OTACallback {
        override fun onProgress(offset: Int, total: Int, progress: Int) = transition(admitted, "transferring", progress, offset, total)
        override fun onCompleted(needReboot: Boolean) {
          if (operation != admitted) return
          state.update { it.copy(inventory = it.inventory + mapOf("activation" to "unverified", "needsReboot" to needReboot.toString())) }
          transition(admitted, "complete", 100, safe = true)
          ports.queryInventory()
        }
        override fun onError(errorCode: Int, message: String) = transition(admitted, "interrupted", error = message)
        override fun onCancelled() = transition(admitted, "interrupted", error = "The local AR99 transfer stopped; device recovery has not been verified")
        override fun onPausedWaitingReconnect() = transition(admitted, "paused")
      })
      if (!accepted && snapshot.phase != "complete") {
        entered = false
        transition(admitted, "failed", safe = true, error = "AR99 could not prepare its OTA channel")
      }
    } catch (error: Exception) {
      transition(admitted, if (entered) "interrupted" else "failed", safe = !entered, error = error.message)
    }
    return snapshot
  }

  override fun reconcile(): FirmwareUpdateSnapshot {
    if (!ports.connected()) { ports.reconnect(); return snapshot }
    ports.queryInventory()
    return snapshot
  }
  override fun cancel(): FirmwareUpdateSnapshot = throw FirmwareUpdaterException("action_unavailable", "AR99 has no verified remote abort for a managed transfer")
  override fun acknowledge(): FirmwareUpdateSnapshot {
    if (ownsDevice) throw FirmwareUpdaterException("busy", "AR99 still requires update recovery")
    journal?.remove(); request = null; operation++
    state.update { it.copy(sessionId = null, offerId = null, phase = "idle", progress = null, targetFirmware = null, error = null, canReconcile = false) }
    return snapshot
  }
  fun connectionChanged(generation: Int) { state.update { it.copy(connectionGeneration = generation) } }
  fun inventoryChanged(version: String, serial: String, projectName: String, generation: Int) {
    if (generation != snapshot.connectionGeneration) return
    state.update {
      val inventory = it.inventory + mapOf("serialNumber" to serial, "projectName" to projectName,
        "revision" to ((it.inventory["revision"]?.toIntOrNull() ?: 0) + 1).toString())
      val verified = version.isNotEmpty() && version == it.targetFirmware && it.phase in listOf("interrupted", "complete")
      it.copy(observedFirmware = version, inventory = if (verified) inventory + ("activation" to "verified") else inventory,
        phase = if (verified) "complete" else it.phase, safeToRelease = verified || it.safeToRelease,
        canReconcile = if (verified) false else it.canReconcile, error = if (verified) null else it.error)
    }
    persist()
  }

  /** Legacy SDK callers retain explicit restart/cancel, but cannot preempt a managed transfer. */
  fun beginLegacy() { assertLegacyControlAllowed(); legacyActive = true }
  fun endLegacy() { legacyActive = false }
  fun assertLegacyControlAllowed() {
    if (!snapshot.safeToRelease || snapshot.sessionId != null)
      throw FirmwareUpdaterException("busy", "The managed AR99 update owns this device")
  }
  private fun transition(admitted: Int, phase: String, progress: Int? = null, offset: Int? = null, total: Int? = null,
    safe: Boolean = false, error: String? = null) {
    if (operation != admitted) return
    state.update {
      val inventory = it.inventory.toMutableMap()
      if (offset != null) inventory["offset"] = offset.toString()
      if (total != null) inventory["total"] = total.toString()
      it.copy(phase = phase, safeToRelease = safe, error = error, canReconcile = phase == "interrupted",
        progress = progress?.coerceIn(0, 100)?.div(100.0) ?: it.progress, inventory = inventory)
    }
    persist()
  }
  private fun persist() {
    val request = request ?: return
    try { journal?.write(FirmwareRecoveryRecord(snapshot, request, recoveryStage = snapshot.inventory["activation"])) }
    catch (_: Exception) { state.update { it.copy(error = "AR99 recovery record could not be saved") } }
  }
}
