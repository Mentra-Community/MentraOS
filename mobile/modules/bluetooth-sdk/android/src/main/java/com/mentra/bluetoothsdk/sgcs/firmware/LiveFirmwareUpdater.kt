package com.mentra.bluetoothsdk.sgcs.firmware

import com.mentra.bluetoothsdk.Bridge
import java.io.File
import java.security.MessageDigest
import java.util.UUID

/** Observes the glasses-owned transaction. Engine retains Live's retry, reboot and chaining policy. */
internal class LiveFirmwareUpdater(
  deviceId: String,
  generation: Int,
  private val connected: () -> Boolean,
  private val query: () -> Unit,
  directory: File,
) : FirmwareUpdater {
  private val state = FirmwareSessionState(FirmwareUpdateSnapshot("mentra-live", deviceId, generation))
  private val journal = runCatching { FirmwareJournal(deviceId, directory) }.getOrNull()
  private var record: FirmwareStartRequest? = null
  private var commandToken: String? = null
  private var commandRevision = 0
  var launch: ((FirmwareStartRequest) -> Unit)? = null
  override val snapshot get() = state.snapshot
  val ownsDevice get() = commandToken != null || !snapshot.safeToRelease

  init {
    try {
      val storage = journal ?: error("Firmware recovery storage is unavailable")
      storage.read()?.let { saved ->
        require(saved.snapshot.integrationId == "mentra-live" && saved.request.kind == "live-observation")
        record = saved.request
        state.update { saved.snapshot.copy(updaterId = it.updaterId, revision = 0, connectionGeneration = generation,
          phase = if (saved.snapshot.safeToRelease) saved.snapshot.phase else "interrupted",
          canReconcile = !saved.snapshot.safeToRelease) }
      }
    } catch (_: Exception) {
      state.update { it.copy(phase = "interrupted", safeToRelease = false, canReconcile = true,
        error = "Firmware recovery information requires a fresh glasses status") }
    }
  }

  override fun observe(listener: (FirmwareUpdateSnapshot) -> Unit) = state.observe(listener)

  override fun start(request: FirmwareStartRequest): FirmwareUpdateSnapshot {
    validate(request)
    if (request.offerId == snapshot.offerId && !snapshot.safeToRelease) return snapshot
    if (!snapshot.safeToRelease || commandToken != null) throw FirmwareUpdaterException("busy", "A Live update is awaiting reconciliation")
    val send = launch ?: throw FirmwareUpdaterException("unavailable", "Open the updater through the Bluetooth SDK")
    // SDK reserves its existing PendingResponse synchronously before the BLE handoff.
    send(request)
    return snapshot
  }

  override fun reconcile(): FirmwareUpdateSnapshot {
    if (!connected()) throw FirmwareUpdaterException("disconnected", "Reconnect the same glasses to inspect the update")
    query()
    return snapshot
  }

  override fun cancel(): FirmwareUpdateSnapshot =
    throw FirmwareUpdaterException("action_unavailable", "Live's active transaction must be reconciled with the glasses")

  override fun acknowledge(): FirmwareUpdateSnapshot {
    if (!snapshot.safeToRelease || commandToken != null) throw FirmwareUpdaterException("busy", "The Live update still owns the glasses")
    journal?.remove(); record = null
    state.update { it.copy(sessionId = null, offerId = null, phase = "idle", progress = null, error = null, canReconcile = false) }
    return snapshot
  }

  /** Existing low-level retries remain explicit. Managed Start uses start() for offer admission. */
  fun commandStarted(manifestUrl: String, request: FirmwareStartRequest? = null): String {
    if (commandToken != null) throw FirmwareUpdaterException("request_in_flight", "An OTA start command is already pending")
    if (!connected()) throw FirmwareUpdaterException("disconnected", "The intended Live glasses are not connected")
    request?.let { validate(it) }
    val storage = journal ?: throw FirmwareUpdaterException("invalid_journal", "Firmware recovery storage is unavailable")
    val digest = MessageDigest.getInstance("SHA-256").digest(manifestUrl.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
    val offerId = request?.offerId ?: digest
    val evidence = FirmwareStartRequest(snapshot.deviceId, snapshot.connectionGeneration, offerId, "live-observation",
      metadata = mapOf("manifestSha256" to digest))
    val next = snapshot.copy(sessionId = UUID.randomUUID().toString(), offerId = offerId, phase = "preparing",
      safeToRelease = false, canReconcile = true, error = null, progress = null)
    // Never persist URLs, credentials or multi-pass approval. Reading this only authorizes inspection.
    storage.write(FirmwareRecoveryRecord(next, evidence))
    record = evidence
    val token = UUID.randomUUID().toString(); commandToken = token
    state.update { next }; commandRevision = snapshot.revision
    return token
  }

  fun commandSettled(token: String, error: Throwable?) {
    if (commandToken != token) return
    commandToken = null
    if (snapshot.revision == commandRevision) state.update {
      it.copy(phase = if (error == null) "installing" else "interrupted",
        error = if (error == null) null else "The OTA start outcome requires a glasses status query")
    }
    persist()
  }

  fun status(sessionId: String, phase: String, status: String, progress: Int, generation: Int) {
    if (generation != snapshot.connectionGeneration || (status == "idle" && commandToken != null)) return
    val safe = status in setOf("idle", "complete", "failed")
    if (!safe && record == null) {
      // The glasses-owned update may predate this phone process. Persist observation, never approval.
      record = FirmwareStartRequest(snapshot.deviceId, generation, "observed-" + UUID.randomUUID(), "live-observation")
    }
    state.update {
      it.copy(sessionId = if (!safe && it.sessionId == null) UUID.randomUUID().toString() else it.sessionId,
        offerId = if (!safe && it.offerId == null) record?.offerId else it.offerId,
        inventory = if (sessionId.isNotEmpty()) it.inventory + ("glassesSessionId" to sessionId) else it.inventory,
        phase = when (status) { "idle", "complete", "failed" -> status; else -> if (phase == "download") "transferring" else "installing" },
        safeToRelease = safe, canReconcile = !safe, progress = progress.coerceIn(0, 100).toDouble() / 100,
        error = if (status == "failed") "The glasses reported an update failure" else null)
    }
    persist()
  }

  fun connectionChanged(generation: Int, disconnected: Boolean = false) {
    state.update { it.copy(connectionGeneration = generation,
      phase = if (disconnected && !it.safeToRelease) "interrupted" else it.phase,
      canReconcile = if (disconnected && !it.safeToRelease) true else it.canReconcile) }
    persist()
  }

  private fun validate(request: FirmwareStartRequest) {
    if (request.deviceId != snapshot.deviceId || request.connectionGeneration != snapshot.connectionGeneration)
      throw FirmwareUpdaterException("stale_offer", "The Live device or connection changed")
    if (request.kind != "manifest" || request.manifestUrl.isNullOrEmpty() || request.offerId.isEmpty())
      throw FirmwareUpdaterException("invalid_request", "Live requires an approved manifest request")
  }

  private fun persist() {
    val saved = record ?: return
    try { journal?.write(FirmwareRecoveryRecord(snapshot, saved)) }
    catch (_: Exception) { Bridge.log("Live firmware recovery record could not be saved") }
  }
}
