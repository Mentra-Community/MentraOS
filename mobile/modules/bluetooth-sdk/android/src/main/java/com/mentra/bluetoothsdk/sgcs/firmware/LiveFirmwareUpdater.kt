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
  private var statusQuery: Pair<String, Int>? = null
  private var terminalRevision: Int? = null
  private var needsInspection = false
  // Dismissing a safe result must not re-admit a delayed result from an unrelated SID.
  private var hasTransactionHistory = false
  var launch: ((FirmwareStartRequest) -> Unit)? = null
  override val snapshot get() = state.snapshot
  val ownsDevice get() = commandToken != null || !snapshot.safeToRelease

  init {
    try {
      val storage = journal ?: error("Firmware recovery storage is unavailable")
      storage.read()?.let { saved ->
        require(saved.snapshot.integrationId == "mentra-live" && saved.request.kind == "live-observation")
        record = saved.request
        hasTransactionHistory = true
        state.update { saved.snapshot.copy(updaterId = it.updaterId, revision = 0, connectionGeneration = generation,
          phase = if (saved.snapshot.safeToRelease) saved.snapshot.phase else "interrupted",
          canReconcile = !saved.snapshot.safeToRelease) }
      }
    } catch (_: Exception) {
      hasTransactionHistory = true
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

  override fun reconcileCompletion(evidence: FirmwareCompletionEvidence): FirmwareUpdateSnapshot {
    if (evidence.kind !in setOf("live-bes-reboot", "live-apk-build-increase", "live-apk-target-convergence") ||
      evidence.deviceId != snapshot.deviceId || evidence.updaterId != snapshot.updaterId ||
      evidence.sessionId.isEmpty() || evidence.sessionId != snapshot.sessionId ||
      evidence.connectionGeneration != snapshot.connectionGeneration || evidence.revision != snapshot.revision)
      throw FirmwareUpdaterException("stale_evidence", "The Live completion belongs to another transaction or observation")
    if (!connected() || commandToken != null) throw FirmwareUpdaterException("busy", "Wait for the current Live command and connection")
    if (snapshot.safeToRelease) return snapshot
    val storage = journal ?: throw FirmwareUpdaterException("invalid_journal", "The Live recovery record is unavailable")
    val saved = record ?: throw FirmwareUpdaterException("invalid_journal", "The Live recovery record is unavailable")
    val next = snapshot.copy(phase = "complete", safeToRelease = true, canReconcile = false, progress = 1.0, error = null)
    // Commit the terminal recovery record before releasing native ownership.
    storage.write(FirmwareRecoveryRecord(next, saved))
    state.update { next }
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
      metadata = mapOf("manifestSha256" to digest, "startedFromSafe" to snapshot.safeToRelease.toString()))
    val next = snapshot.copy(sessionId = UUID.randomUUID().toString(), offerId = offerId, phase = "preparing",
      safeToRelease = false, canReconcile = true, error = null, progress = null,
      inventory = snapshot.inventory - "activeGlassesSessionId")
    // Never persist URLs, credentials or multi-pass approval. Reading this only authorizes inspection.
    storage.write(FirmwareRecoveryRecord(next, evidence))
    record = evidence
    hasTransactionHistory = true
    statusQuery = null
    terminalRevision = null
    needsInspection = false
    val token = UUID.randomUUID().toString(); commandToken = token
    state.update { next }; commandRevision = snapshot.revision
    return token
  }

  fun commandSettled(token: String, error: Throwable?) {
    if (commandToken != token) return
    commandToken = null
    if (terminalRevision == snapshot.revision) state.update { it.copy(safeToRelease = true, canReconcile = false) }
    else if (snapshot.revision == commandRevision) state.update {
      it.copy(phase = if (error == null) "installing" else "interrupted",
        error = if (error == null) null else "The OTA start outcome requires a glasses status query")
    }
    terminalRevision = null
    persist()
    if (needsInspection) query()
  }

  /** Correlate ASG's existing read-only activity diagnostics with this exact observation. */
  fun beginStatusQuery(): String = UUID.randomUUID().toString().also {
    statusQuery = it to snapshot.revision
  }

  private fun confirmsQuiescence(activity: Map<String, Any>?): Boolean {
    val query = statusQuery ?: return false
    if (activity?.get("request_id") != query.first) return false
    statusQuery = null
    if (commandToken != null || query.second != snapshot.revision) return false
    val session = activity["session"] as? Map<*, *> ?: return false
    return activity["schema"] == 1 && activity["consistent"] == true &&
      activity["admission_held"] == false && activity["updating"] == false &&
      activity["mtk_in_progress"] == false && activity["bes_in_progress"] == false &&
      session["restart_pending"] == false && session["status"] in setOf("idle", "complete", "failed")
  }

  fun activity(activity: Map<String, Any>, generation: Int): Boolean =
    ownsDevice && status("", "download", "idle", 0, generation, activity)

  fun status(sessionId: String, phase: String, status: String, progress: Int, generation: Int,
    activity: Map<String, Any>? = null, legacyEvent: Boolean = false): Boolean {
    // Idle only means ASG has no session to report. It can still be fetching an
    // acknowledged Start's manifest, including after this phone restarts. Owned
    // work needs terminal/completion proof or a correlated, consistent quiet-worker snapshot.
    if (generation != snapshot.connectionGeneration) return false
    if (status == "idle" && ownsDevice && !confirmsQuiescence(activity)) return false
    val terminal = status in setOf("idle", "complete", "failed")
    // Pre-session failures (battery rejection, manifest fetch) have no SID and are
    // delivered directly; ota_query_status returns idle rather than replaying them.
    // A rejected retry cannot prove that an earlier, unresolved attempt stopped.
    val preSessionFailure = !legacyEvent && ownsDevice && status == "failed" && sessionId.isEmpty() &&
      snapshot.inventory["activeGlassesSessionId"] == null
    val canRelease = terminal && (!preSessionFailure || record?.metadata?.get("startedFromSafe") == "true")
    if (terminal && status != "idle" && (ownsDevice || hasTransactionHistory) &&
      ((!legacyEvent && !preSessionFailure && snapshot.inventory["activeGlassesSessionId"] != sessionId) ||
        (activity != null && !confirmsQuiescence(activity)))) {
      // ASG can retain the PREVIOUS terminal session during this Start's manifest fetch.
      // A legacy progress event is transient; modern cached status needs attempt binding.
      needsInspection = ownsDevice
      if (needsInspection && commandToken == null && statusQuery == null) query()
      return false
    }
    needsInspection = preSessionFailure && !canRelease
    val safe = canRelease && commandToken == null
    if (!safe && record == null) {
      // The glasses-owned update may predate this phone process. Persist observation, never approval.
      record = FirmwareStartRequest(snapshot.deviceId, generation, "observed-" + UUID.randomUUID(), "live-observation")
      hasTransactionHistory = true
    }
    state.update {
      it.copy(sessionId = if (!safe && it.sessionId == null) UUID.randomUUID().toString() else it.sessionId,
        offerId = if (!safe && it.offerId == null) record?.offerId else it.offerId,
        inventory = (if (sessionId.isNotEmpty()) it.inventory + ("glassesSessionId" to sessionId) else it.inventory) +
          (if (!terminal) mapOf("activeGlassesSessionId" to sessionId) else emptyMap()),
        phase = when (status) { "idle", "complete", "failed" -> status; else -> if (phase == "download") "transferring" else "installing" },
        safeToRelease = safe, canReconcile = !safe, progress = progress.coerceIn(0, 100).toDouble() / 100,
        error = if (status == "failed") "The glasses reported an update failure" else null)
    }
    terminalRevision = if (canRelease && !safe) snapshot.revision else null
    persist()
    if (needsInspection && commandToken == null) query()
    return true
  }

  fun connectionChanged(generation: Int, disconnected: Boolean = false) {
    terminalRevision = null
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
