package com.mentra.bluetoothsdk.stt

import android.content.Context
import com.mentra.bluetoothsdk.Bridge

/**
 * Compatibility shell for the optional local STT integration.
 *
 * Local Sherpa-ONNX transcription is not bundled in the public Android SDK.
 * Cloud transcription remains available, and these methods intentionally no-op
 * so existing callers can continue to compile without the native dependency.
 */
class SherpaOnnxTranscriber(@Suppress("UNUSED_PARAMETER") context: Context) {
    interface TranscriptListener {
        fun onPartialResult(text: String, language: String)
        fun onFinalResult(text: String, language: String)
    }

    private var listener: TranscriptListener? = null

    fun initialize() {
        Bridge.log("Local Sherpa-ONNX transcription is unavailable in this SDK build")
    }

    fun acceptAudio(@Suppress("UNUSED_PARAMETER") pcm16le: ByteArray) = Unit

    fun shutdown() = Unit

    fun restart() = initialize()

    fun setTranscriptListener(listener: TranscriptListener?) {
        this.listener = listener
    }

    fun isInitialized(): Boolean = false

    fun microphoneStateChanged(@Suppress("UNUSED_PARAMETER") state: Boolean) = Unit
}
