package com.mentra.core.tts

import android.content.Context
import com.mentra.bluetoothsdk.Bridge

/**
 * Compatibility shell for the optional local TTS integration.
 *
 * Sherpa-ONNX is not bundled in the public Android SDK, so local synthesis is
 * unavailable. The methods remain available to preserve the native API shape.
 */
object TTSTools {
    fun setTtsModelDetails(
            @Suppress("UNUSED_PARAMETER") context: Context,
            @Suppress("UNUSED_PARAMETER") path: String,
            @Suppress("UNUSED_PARAMETER") languageCode: String,
    ) {
        Bridge.log("Local Sherpa-ONNX TTS is unavailable in this SDK build")
    }

    fun getTtsModelPath(@Suppress("UNUSED_PARAMETER") context: Context): String = ""

    fun getTtsModelLanguage(@Suppress("UNUSED_PARAMETER") context: Context): String = "en-US"

    fun checkTTSModelAvailable(@Suppress("UNUSED_PARAMETER") context: Context): Boolean = false

    fun validateTTSModel(@Suppress("UNUSED_PARAMETER") path: String): Boolean = false

    fun generateTtsAudio(
            @Suppress("UNUSED_PARAMETER") context: Context,
            @Suppress("UNUSED_PARAMETER") text: String,
            @Suppress("UNUSED_PARAMETER") modelPath: String,
            @Suppress("UNUSED_PARAMETER") outputPath: String,
            @Suppress("UNUSED_PARAMETER") speakerId: Int,
            @Suppress("UNUSED_PARAMETER") speed: Float,
    ): Boolean = false
}
