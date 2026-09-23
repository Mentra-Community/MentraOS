package com.mentra.bluetoothsdk.sgcs.firmware

import android.util.AtomicFile
import java.io.File
import java.security.MessageDigest
import org.json.JSONObject

/** Recovery evidence only. Reading this record never authorizes a new flash or guessed-offset resume. */
internal data class FirmwareRecoveryRecord(val snapshot: FirmwareUpdateSnapshot, val request: FirmwareStartRequest, val formatVersion: Int = 1, val recoveryStage: String? = null)

internal class FirmwareJournal(private val deviceId: String, directory: File) {
  private val file: AtomicFile
  init {
    check(directory.isDirectory || directory.mkdirs()) { "Firmware recovery directory is unavailable" }
    val name = MessageDigest.getInstance("SHA-256").digest(deviceId.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
    file = AtomicFile(File(directory, "$name.json"))
  }

  fun read(): FirmwareRecoveryRecord? {
    val bytes = try {
      file.openRead().use { input ->
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (true) {
          val count = input.read(buffer)
          if (count < 0) break
          check(output.size() + count <= 65536) { "Firmware recovery record exceeds size limit" }
          output.write(buffer, 0, count)
        }
        output.toByteArray()
      }
    } catch (_: java.io.FileNotFoundException) {
      if (file.baseFile.exists()) throw FirmwareUpdaterException("invalid_journal", "Firmware recovery record cannot be read")
      return null
    }
    val json = JSONObject(String(bytes, Charsets.UTF_8))
    val snapshot = FirmwareWire.snapshot(FirmwareWire.map(json.getJSONObject("snapshot")))
    val request = FirmwareWire.request(FirmwareWire.map(json.getJSONObject("request")))
    require(json.getInt("formatVersion") == 1 && snapshot.schemaVersion == 1 && snapshot.deviceId == deviceId && request.deviceId == deviceId) { "Unsupported firmware recovery record" }
    return FirmwareRecoveryRecord(snapshot, request, recoveryStage = if (json.isNull("recoveryStage")) null else json.getString("recoveryStage"))
  }

  fun write(record: FirmwareRecoveryRecord) {
    require(record.snapshot.deviceId == deviceId && record.request.deviceId == deviceId && record.request.kind != "manifest") { "Recovery record does not match this file updater" }
    val json = JSONObject().put("formatVersion", 1).put("snapshot", JSONObject(record.snapshot.toMap()))
      .put("request", JSONObject(FirmwareWire.requestMap(record.request.copy(manifestUrl = null))))
      .put("recoveryStage", record.recoveryStage)
    val bytes = json.toString().toByteArray(Charsets.UTF_8)
    require(bytes.size <= 65536) { "Firmware recovery record exceeds size limit" }
    val stream = file.startWrite()
    try { stream.write(bytes); file.finishWrite(stream) }
    catch (error: Exception) { file.failWrite(stream); throw error }
  }

  fun remove() { file.delete(); check(!file.baseFile.exists()) { "Firmware recovery record could not be removed" } }
}

/** Strict parsing shared by the native bridge and versioned recovery records. */
internal object FirmwareWire {
  fun completion(values: Map<String, Any?>) = FirmwareCompletionEvidence(
    values.string("deviceId"), values.string("updaterId"), values.string("sessionId"),
    values.integer("connectionGeneration"), values.integer("revision"), values.string("kind"),
  )

  private fun Map<String, Any?>.string(key: String) = this[key] as? String ?: error("Missing firmware field $key")
  private fun Map<String, Any?>.integer(key: String): Int {
    val number = this[key] as? Number ?: error("Missing firmware field $key")
    require(number.toDouble().isFinite() && number.toDouble() == number.toInt().toDouble()) { "Invalid firmware integer $key" }
    return number.toInt()
  }
  private fun Map<String, Any?>.boolean(key: String) = this[key] as? Boolean ?: error("Missing firmware field $key")
  private fun strings(value: Any?): Map<String, String> {
    if (value == null) return emptyMap()
    require(value is Map<*, *> && value.all { it.key is String && it.value is String }) { "Invalid firmware metadata" }
    return value.entries.associate { it.key as String to it.value as String }
  }
  private fun objectMap(value: Any?): Map<String, Any?> {
    require(value is Map<*, *> && value.keys.all { it is String }) { "Invalid firmware object" }
    return value.entries.associate { it.key as String to it.value }
  }
  fun request(values: Map<String, Any?>): FirmwareStartRequest {
    val artifact = values["artifact"]?.let { value ->
      val a = objectMap(value)
      FirmwareArtifact(a.string("path"), a.string("targetVersion"), if (a["size"] == null) null else a.integer("size"),
        a["sha256"] as? String, a["md5"] as? String)
    }
    return FirmwareStartRequest(values.string("deviceId"), values.integer("connectionGeneration"), values.string("offerId"),
      values.string("kind"), artifact, values["manifestUrl"] as? String, strings(values["metadata"]))
  }
  fun requestMap(request: FirmwareStartRequest): Map<String, Any> = mapOf(
    "deviceId" to request.deviceId, "connectionGeneration" to request.connectionGeneration, "offerId" to request.offerId,
    "kind" to request.kind, "manifestUrl" to request.manifestUrl, "metadata" to request.metadata,
    "artifact" to request.artifact?.let { mapOf("path" to it.path, "targetVersion" to it.targetVersion, "size" to it.size,
      "sha256" to it.sha256, "md5" to it.md5).filterValues { value -> value != null } },
  ).filterValues { it != null }.mapValues { it.value!! }

  fun snapshot(v: Map<String, Any?>) = FirmwareUpdateSnapshot(
    integrationId = v.string("integrationId"), deviceId = v.string("deviceId"), connectionGeneration = v.integer("connectionGeneration"),
    schemaVersion = v.integer("schemaVersion"), updaterId = v.string("updaterId"), revision = v.integer("revision"),
    sessionId = v["sessionId"] as? String, offerId = v["offerId"] as? String, phase = v.string("phase"),
    safeToRelease = v.boolean("safeToRelease"), canCancel = v.boolean("canCancel"), canReconcile = v.boolean("canReconcile"),
    progress = (v["progress"] as? Number)?.toDouble(), observedFirmware = v["observedFirmware"] as? String,
    targetFirmware = v["targetFirmware"] as? String, inventory = strings(v["inventory"]), error = v["error"] as? String,
  )

  fun map(json: JSONObject): Map<String, Any?> = json.keys().asSequence().associateWith { key ->
    when (val value = json.get(key)) { JSONObject.NULL -> null; is JSONObject -> map(value); else -> value }
  }
}
