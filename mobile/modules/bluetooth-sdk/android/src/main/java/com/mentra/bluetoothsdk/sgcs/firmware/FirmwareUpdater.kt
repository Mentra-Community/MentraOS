package com.mentra.bluetoothsdk.sgcs.firmware

import com.mentra.bluetoothsdk.Bridge

internal object FirmwareConnectionGeneration {
  private val value = java.util.concurrent.atomic.AtomicInteger()
  fun next(): Int = value.incrementAndGet()
}

/** Device-bound preparation. Device policy owns metadata; the common service doesn't interpret it. */
data class FirmwareStartRequest(
  val deviceId: String,
  val connectionGeneration: Int,
  val offerId: String,
  val kind: String,
  val artifact: FirmwareArtifact? = null,
  val manifestUrl: String? = null,
  val metadata: Map<String, String> = emptyMap(),
)

data class FirmwareArtifact(val path: String, val targetVersion: String, val size: Int? = null,
  val sha256: String? = null, val md5: String? = null)

data class FirmwareUpdateSnapshot(
  val integrationId: String,
  val deviceId: String,
  val connectionGeneration: Int,
  val schemaVersion: Int = 1,
  val updaterId: String = java.util.UUID.randomUUID().toString(),
  val revision: Int = 0,
  val sessionId: String? = null,
  val offerId: String? = null,
  val phase: String = "idle",
  val safeToRelease: Boolean = true,
  val canCancel: Boolean = false,
  val canReconcile: Boolean = false,
  val progress: Double? = null,
  val observedFirmware: String? = null,
  val targetFirmware: String? = null,
  val inventory: Map<String, String> = emptyMap(),
  val error: String? = null,
) {
  fun toMap(): Map<String, Any> = mapOf(
    "schemaVersion" to schemaVersion, "updaterId" to updaterId, "integrationId" to integrationId, "deviceId" to deviceId,
    "connectionGeneration" to connectionGeneration, "revision" to revision, "sessionId" to sessionId,
    "offerId" to offerId, "phase" to phase, "safeToRelease" to safeToRelease, "canCancel" to canCancel,
    "canReconcile" to canReconcile, "progress" to progress, "observedFirmware" to observedFirmware,
    "targetFirmware" to targetFirmware, "inventory" to inventory, "error" to error,
  ).filterValues { it != null }.mapValues { it.value!! }
}

class FirmwareUpdaterException(val code: String, message: String) : IllegalStateException(message)

/** Methods and callbacks run on the SGC's serial executor. Observation never starts or cancels work. */
@androidx.annotation.MainThread
interface FirmwareUpdater {
  val snapshot: FirmwareUpdateSnapshot
  fun observe(listener: (FirmwareUpdateSnapshot) -> Unit): () -> Unit
  fun start(request: FirmwareStartRequest): FirmwareUpdateSnapshot
  fun reconcile(): FirmwareUpdateSnapshot
  fun cancel(): FirmwareUpdateSnapshot
  fun acknowledge(): FirmwareUpdateSnapshot
}

internal class FirmwareSessionState(initial: FirmwareUpdateSnapshot,
  private val publish: (FirmwareUpdateSnapshot) -> Unit = { Bridge.sendTypedMessage("firmware_update", it.toMap()) },
) {
  @Volatile var snapshot = initial
    private set
  private val listeners = linkedMapOf<Any, (FirmwareUpdateSnapshot) -> Unit>()
  private val queue = java.util.ArrayDeque<FirmwareUpdateSnapshot>()
  private var delivering = false

  fun observe(listener: (FirmwareUpdateSnapshot) -> Unit): () -> Unit {
    val id = Any()
    var lastRevision = -1
    val ordered: (FirmwareUpdateSnapshot) -> Unit = { state ->
      if (state.revision > lastRevision) { lastRevision = state.revision; listener(state) }
    }
    listeners[id] = ordered
    ordered(snapshot)
    return { listeners.remove(id); Unit }
  }

  fun update(mutate: (FirmwareUpdateSnapshot) -> FirmwareUpdateSnapshot) {
    snapshot = mutate(snapshot).copy(revision = snapshot.revision + 1)
    queue.addLast(snapshot)
    if (delivering) return
    delivering = true
    try {
      while (queue.isNotEmpty()) {
        val next = queue.removeFirst()
        publish(next)
        listeners.values.toList().forEach { listener ->
          try { listener(next) } catch (_: Exception) { /* Observers never own transport execution. */ }
        }
      }
    } finally { delivering = false }
  }
}
