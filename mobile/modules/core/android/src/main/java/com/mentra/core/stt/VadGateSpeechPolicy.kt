package com.mentra.core.stt

import android.content.Context
import android.util.Log
import com.konovalov.vad.silero.Vad
import com.konovalov.vad.silero.VadSilero
import com.konovalov.vad.silero.config.FrameSize
import com.konovalov.vad.silero.config.Mode
import com.konovalov.vad.silero.config.SampleRate
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * VadGateSpeechPolicy handles Voice Activity Detection using Silero VAD.
 *
 * Features:
 * - Dynamic VAD check throttling (adjusts frequency based on silence duration)
 * - 8-second silence timeout before declaring "not speaking"
 * - Bypass modes for debugging and PCM streaming
 * - 512-sample frame size (matches Sherpa-ONNX requirements)
 *
 * Ported from android_core VadGateSpeechPolicy.java
 */
class VadGateSpeechPolicy(private val context: Context) {
    companion object {
        private const val TAG = "VadGateSpeechPolicy"

        // Total required silence duration
        private const val REQUIRED_SILENCE_DURATION_MS = 8000L

        // Dynamic VAD check intervals
        private const val INITIAL_SILENCE_VAD_INTERVAL_MS = 50L // Check frequently at first
        private const val MEDIUM_SILENCE_VAD_INTERVAL_MS = 100L // Medium frequency after some time
        private const val LONG_SILENCE_VAD_INTERVAL_MS =
                200L // Less frequent after extended silence

        // Thresholds for switching intervals
        private const val MEDIUM_SILENCE_THRESHOLD_MS =
                20000L // Switch to medium interval after 20s
        private const val LONG_SILENCE_THRESHOLD_MS = 60000L // Switch to long interval after 60s

        private const val FRAME_SIZE = 512
    }

    private var vad: VadSilero? = null
    private var isCurrentlySpeech = false
    private var bypassVadForDebugging = false
    private var bypassVadForPCM = false

    // Timestamp of the last detected speech
    private var lastSpeechDetectedTime = 0L
    // Throttle timer for silence VAD checks
    private var lastVadCheckTime = 0L

    /** Initialize the Silero VAD model */
    fun init(blockSizeSamples: Int) {
        startVad()
    }

    private fun startVad() {
        try {
            // Set internal silence duration very low; external logic manages the full required
            // silence duration
            vad =
                    Vad.builder()
                            .setContext(context)
                            .setSampleRate(SampleRate.SAMPLE_RATE_16K)
                            .setFrameSize(FrameSize.FRAME_SIZE_512)
                            .setMode(Mode.NORMAL)
                            .setSilenceDurationMs(50)
                            .setSpeechDurationMs(50)
                            .build()

            Log.d(TAG, "VAD initialized successfully")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to initialize VAD", e)
            vad = null
        }
    }

    /** Check if audio should be passed to the recognizer based on VAD state */
    fun shouldPassAudioToRecognizer(): Boolean {
        // CRITICAL: Handle VAD null case
        if (vad == null) {
            return bypassVadForDebugging || bypassVadForPCM || true
        }

        return bypassVadForDebugging || bypassVadForPCM || isCurrentlySpeech
    }

    /** Process audio bytes through VAD to detect speech */
    fun processAudioBytes(bytes: ByteArray, offset: Int, length: Int) {
        val now = System.currentTimeMillis()

        // If in speech state and it hasn't been 8 seconds since the last speech was detected, skip
        // processing
        if (isCurrentlySpeech && (now - lastSpeechDetectedTime < REQUIRED_SILENCE_DURATION_MS)) {
            return
        }

        // Calculate silence duration
        val silenceDuration = now - lastSpeechDetectedTime

        // Determine which VAD interval to use based on silence duration
        val currentVadInterval =
                when {
                    silenceDuration < MEDIUM_SILENCE_THRESHOLD_MS -> INITIAL_SILENCE_VAD_INTERVAL_MS
                    silenceDuration < LONG_SILENCE_THRESHOLD_MS -> MEDIUM_SILENCE_VAD_INTERVAL_MS
                    else -> LONG_SILENCE_VAD_INTERVAL_MS
                }

        // During silence, throttle VAD checks based on the dynamic interval
        if (!isCurrentlySpeech && (now - lastVadCheckTime < currentVadInterval)) {
            return
        }
        lastVadCheckTime = now

        val audioBytesFull = bytesToShort(bytes)
        val totalSamples = audioBytesFull.size

        if (totalSamples % FRAME_SIZE != 0) {
            Log.e(
                    TAG,
                    "Invalid audio frame size: $totalSamples samples. Needs to be multiple of $FRAME_SIZE."
            )
            return
        }

        val currentVad =
                vad
                        ?: run {
                            Log.w(TAG, "VAD not initialized, skipping audio processing")
                            return
                        }

        var previousSpeechState = isCurrentlySpeech

        // Process each 512-sample frame
        val numFrames = totalSamples / FRAME_SIZE
        for (i in 0 until numFrames) {
            val currentTime = System.currentTimeMillis()
            val startIdx = i * FRAME_SIZE
            val audioFrame = audioBytesFull.copyOfRange(startIdx, startIdx + FRAME_SIZE)
            val detectedSpeech = currentVad.isSpeech(audioFrame)

            if (detectedSpeech) {
                isCurrentlySpeech = true
                // Update the last speech detection timestamp
                lastSpeechDetectedTime = currentTime
            } else {
                // If no speech detected, and 8 seconds have elapsed since the last speech, mark as
                // silence
                if (currentTime - lastSpeechDetectedTime >= REQUIRED_SILENCE_DURATION_MS) {
                    isCurrentlySpeech = false
                }
            }

            if (isCurrentlySpeech != previousSpeechState) {
                Log.d(
                        TAG,
                        "Speech detection changed to: ${if (isCurrentlySpeech) "SPEECH" else "SILENCE"}"
                )
                previousSpeechState = isCurrentlySpeech
            }
        }
    }

    /** Convert byte array (PCM16LE) to short array */
    private fun bytesToShort(bytes: ByteArray): ShortArray {
        val shorts = ShortArray(bytes.size / 2)
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(shorts)
        return shorts
    }

    /** Stop VAD and release resources */
    fun stop() {
        try {
            vad?.close()
            vad = null
            Log.d(TAG, "VAD stopped and resources released")
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping VAD", e)
        }
    }

    /** Reset VAD state */
    fun reset() {
        isCurrentlySpeech = false
        lastSpeechDetectedTime = 0
        lastVadCheckTime = 0
    }

    /** Change bypass VAD for debugging state */
    fun changeBypassVadForDebugging(bypass: Boolean) {
        bypassVadForDebugging = bypass
        Log.d(TAG, "Bypass VAD for debugging: $bypass")
    }

    /** Change bypass VAD for PCM streaming state */
    fun changeBypassVadForPCM(bypass: Boolean) {
        Log.d(TAG, "VAD PCM Bypass State Change: $bypassVadForPCM -> $bypass")
        bypassVadForPCM = bypass
    }

    /** Handle microphone state changes */
    fun microphoneStateChanged(state: Boolean) {
        if (!state) {
            // Microphone turned off: force immediate silence
            isCurrentlySpeech = false
            lastSpeechDetectedTime = 0
            lastVadCheckTime = 0

            // Optionally flush the VAD's internal state by processing a silent frame
            vad?.let { vadInstance ->
                val silentFrame = ShortArray(FRAME_SIZE)
                vadInstance.isSpeech(silentFrame)
            }
            Log.d(TAG, "Microphone turned off; forced state to SILENCE.")
        }
    }
}
