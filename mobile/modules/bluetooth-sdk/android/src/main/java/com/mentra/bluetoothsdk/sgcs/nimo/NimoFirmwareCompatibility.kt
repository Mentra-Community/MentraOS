package com.mentra.bluetoothsdk.sgcs.nimo

import android.content.SharedPreferences
import com.mentra.bluetoothsdk.GeneratedDeviceFirmware
import com.mentra.bluetoothsdk.sgcs.NimoProtocol
import com.mentra.bluetoothsdk.sgcs.firmware.FirmwareUpdaterException
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/** Device-local operational policy; it never authorizes an OTA image or replaces hardware preflight. */
internal class NimoFirmwareCompatibility(deviceId: String, private val preferences: SharedPreferences) {
  data class Identity(val fullVersion: String, val packedVersion: String)
  private val key = "nimo.compatibility." + MessageDigest.getInstance("SHA-256").digest(deviceId.toByteArray(Charsets.UTF_8))
    .joinToString("") { "%02x".format(it.toInt() and 255) }
  private var cached = emptyList<Identity>()

  init {
    try {
      val raw = preferences.getString(key, null)
      if (raw != null && raw.length <= 65536) {
        val policy = JSONObject(raw)
        if (policy.getInt("schemaVersion") == 1 && validHash(policy.getString("manifestSha256")))
          cached = decodeIdentities(policy.getJSONArray("compatible"))
      }
    } catch (_: Exception) { /* Unknown/corrupt metadata cannot enable device operations. */ }
  }

  fun allows(fullVersion: String, packedVersion: String): Boolean =
    Identity(fullVersion, packedVersion).let { it in bundled || it in cached }

  fun configure(metadata: Map<String, String>) {
    val json = metadata["compatibleFirmware"]
    val hash = metadata["manifestSha256"]
    if (json == null || json.length > 65536 || hash == null || !validHash(hash))
      throw FirmwareUpdaterException("invalid_policy", "NIMO requires verified compatibility metadata")
    val array = JSONArray(json)
    val identities = decodeIdentities(array)
    val policy = JSONObject().put("schemaVersion", 1).put("manifestSha256", hash).put("compatible", array).toString()
    if (!preferences.edit().putString(key, policy).commit())
      throw FirmwareUpdaterException("invalid_policy", "NIMO compatibility metadata could not be saved")
    cached = identities
  }

  companion object {
    private val bundled = try { decodeIdentities(JSONObject(GeneratedDeviceFirmware.JSON).getJSONObject("nimo").getJSONArray("compatible")) }
      catch (_: Exception) { emptyList() }
    private fun validHash(value: String) = value.matches(Regex("[0-9a-f]{64}"))
    private fun decodeIdentities(array: JSONArray): List<Identity> {
      if (array.length() > 64) throw FirmwareUpdaterException("invalid_policy", "NIMO compatibility policy is too large")
      return (0 until array.length()).map { index ->
        val item = array.getJSONObject(index)
        val full = item.getString("fullVersion")
        val packed = item.getString("packedVersion")
        val parts = packed.split('.')
        val bounds = listOf(15, 127, 511, 4095)
        val validPacked = parts.size == 4 && parts.withIndex().all { (i, part) ->
          val number = part.toIntOrNull()
          number != null && number in 0..bounds[i] && number.toString() == part
        }
        val prefix = "FW-VERSION-v$packed-"
        if (!validPacked || full.length > 512 || !full.startsWith(prefix) || !full.removePrefix(prefix).matches(Regex("[A-Za-z0-9][A-Za-z0-9._-]*")))
          throw FirmwareUpdaterException("invalid_policy", "NIMO firmware identities are invalid")
        Identity(full, packed)
      }
    }

    fun permitsBeforeCompatibility(command: Int, key: Int): Boolean = command == NimoProtocol.CMD_GET_PARAMETER ||
      (command == NimoProtocol.CMD_SET_PARAMETER && key in listOf(NimoProtocol.SET_TIME, NimoProtocol.SET_PHONE_TYPE))
  }
}
