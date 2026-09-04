package com.mentra.acsmeeting

import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.os.Build
import android.util.Log

/**
 * Selects ACS's hardware H.264 implementation when the phone exposes a real
 * hardware AVC encoder and the loaded ACS binary exactly matches our verified
 * ACS 2.16.0 arm64 instruction signature.
 *
 * If either gate fails, ACS is left untouched and retains its normal behavior.
 */
internal object AcsEncoderOverride {
  private const val TAG = "ACS-HW-OVERRIDE"

  private val nativeLoaded = runCatching {
    System.loadLibrary("mentra_acs_encoder_override")
  }.onFailure {
    Log.e(TAG, "failed to load override JNI library", it)
  }.isSuccess

  private val result: String by lazy {
    if (!nativeLoaded) {
      "override JNI library unavailable"
    } else {
      runCatching {
        val encoder = findHardwareAvcEncoder()
          ?: return@runCatching "no hardware AVC encoder found; ACS left untouched"
        System.loadLibrary("c++_shared")
        System.loadLibrary("skypert")
        System.loadLibrary("RtmMediaManagerDyn")
        val result = nativeApply()
        Class.forName("com.azure.android.communication.calling.CallClient", true, javaClass.classLoader)
        "$result; Android encoder=$encoder"
      }.onSuccess {
        Log.w(TAG, it)
      }.onFailure {
        Log.e(TAG, "hardware encoder override failed", it)
      }.getOrElse { error ->
        "hardware encoder override failed: ${error.message ?: error.javaClass.simpleName}"
      }
    }
  }

  fun apply(): String = result

  private fun findHardwareAvcEncoder(): String? = MediaCodecList(MediaCodecList.ALL_CODECS)
    .codecInfos
    .firstOrNull { codec ->
      codec.isEncoder &&
        codec.supportedTypes.any { it.equals("video/avc", ignoreCase = true) } &&
        isHardware(codec)
    }
    ?.name

  private fun isHardware(codec: MediaCodecInfo): Boolean {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      return codec.isHardwareAccelerated && !codec.isSoftwareOnly
    }
    val name = codec.name.lowercase()
    return !name.startsWith("omx.google.") &&
      !name.startsWith("c2.android.") &&
      !name.contains("software")
  }

  private external fun nativeApply(): String
}
