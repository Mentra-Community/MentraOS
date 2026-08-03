package com.mentra.core.tts

import android.content.Context
import android.content.SharedPreferences
import com.k2fsa.sherpa.onnx.GenerationConfig
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsSupertonicModelConfig
import com.mentra.bluetoothsdk.Bridge
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Utilities for offline Sherpa-ONNX Supertonic 3 TTS model management.
 *
 * Supertonic 3 is a single multilingual model bundle (31 languages) with 10
 * preset voice styles packed into a single voice.bin. Speaker IDs are indexed
 * alphabetically by JSON filename, so the order is F1, F2, F3, F4, F5, M1, M2,
 * M3, M4, M5 (sids 0..9). We default to F1 (sid 0) for a female voice.
 */
object TTSTools {
    private const val PREFS_NAME = "MentraPrefs"
    private const val KEY_TTS_MODEL_PATH = "TTSModelPath"
    private const val KEY_TTS_MODEL_LANGUAGE = "TTSModelLanguageCode"

    private const val FILE_DURATION_PREDICTOR = "duration_predictor.int8.onnx"
    private const val FILE_TEXT_ENCODER = "text_encoder.int8.onnx"
    private const val FILE_VECTOR_ESTIMATOR = "vector_estimator.int8.onnx"
    private const val FILE_VOCODER = "vocoder.int8.onnx"
    private const val FILE_TTS_JSON = "tts.json"
    private const val FILE_UNICODE_INDEXER = "unicode_indexer.bin"
    private const val FILE_VOICE_STYLE = "voice.bin"

    /**
     * Keep the native model warm briefly after use to reduce repeated TTS latency while
     * still reclaiming its memory when speech has been idle for a while.
     */
    private const val MODEL_IDLE_TIMEOUT_MINUTES = 3L
    private val modelLock = Any()
    private val teardownExecutor =
            Executors.newSingleThreadScheduledExecutor { runnable ->
                Thread(runnable, "MentraTtsIdleTeardown").apply { isDaemon = true }
            }
    private var cachedTts: OfflineTts? = null
    private var cachedModelPath: String? = null
    private var teardownFuture: ScheduledFuture<*>? = null
    private var teardownGeneration = 0L

    private val REQUIRED_FILES = listOf(
            FILE_DURATION_PREDICTOR,
            FILE_TEXT_ENCODER,
            FILE_VECTOR_ESTIMATOR,
            FILE_VOCODER,
            FILE_TTS_JSON,
            FILE_UNICODE_INDEXER,
            FILE_VOICE_STYLE,
    )

    fun setTtsModelDetails(context: Context, path: String, languageCode: String) {
        synchronized(modelLock) {
            if (cachedModelPath != null && cachedModelPath != path) {
                releaseCachedModelLocked("model path changed")
            }
        }
        val prefs = getPrefs(context)
        prefs.edit().apply {
            putString(KEY_TTS_MODEL_PATH, path)
            putString(KEY_TTS_MODEL_LANGUAGE, languageCode)
            apply()
        }
        Bridge.log("TTS model details saved: path=$path, language=$languageCode")
    }

    fun getTtsModelPath(context: Context): String {
        val prefs = getPrefs(context)
        return prefs.getString(KEY_TTS_MODEL_PATH, "") ?: ""
    }

    fun getTtsModelLanguage(context: Context): String {
        val prefs = getPrefs(context)
        return prefs.getString(KEY_TTS_MODEL_LANGUAGE, "en-US") ?: "en-US"
    }

    fun checkTTSModelAvailable(context: Context): Boolean {
        val modelPath = getTtsModelPath(context)
        if (modelPath.isEmpty()) {
            return false
        }
        return validateTTSModel(modelPath)
    }

    fun validateTTSModel(path: String): Boolean {
        val modelDir = File(path)
        if (!modelDir.exists() || !modelDir.isDirectory) {
            Bridge.log("TTS model path does not exist or is not a directory: $path")
            return false
        }

        for (name in REQUIRED_FILES) {
            val file = File(modelDir, name)
            if (!file.exists() || !file.canRead() || file.length() == 0L) {
                Bridge.log("TTS model missing required file '$name' at: $path")
                return false
            }
        }

        return true
    }

    private val SUPPORTED_LANGS = setOf(
            "en", "ko", "ja", "ar", "bg", "cs", "da", "de", "el", "es", "et",
            "fi", "fr", "hi", "hr", "hu", "id", "it", "lt", "lv", "nl", "pl",
            "pt", "ro", "ru", "sk", "sl", "sv", "tr", "uk", "vi",
    )

    /** Convert a BCP-47 tag like "en-US" or "fr-FR" to a Supertonic 2-letter code. */
    private fun languageTagToSupertonicLang(tag: String?): String {
        if (tag.isNullOrBlank()) return "en"
        val primary = tag.substringBefore('-').lowercase()
        return if (primary in SUPPORTED_LANGS) primary else "en"
    }

    fun generateTtsAudio(
            context: Context,
            text: String,
            modelPath: String,
            outputPath: String,
            speakerId: Int,
            speed: Float,
    ): Boolean {
        val languageTag = getTtsModelLanguage(context)
        if (text.isBlank()) {
            Bridge.log("TTS_ERROR: text is empty")
            return false
        }
        if (!validateTTSModel(modelPath)) {
            Bridge.log("TTS_ERROR: model is invalid: $modelPath")
            return false
        }

        val outputFile = File(outputPath)
        outputFile.parentFile?.mkdirs()

        return synchronized(modelLock) {
            try {
                val tts = getOrCreateModelLocked(modelPath)

                // sid out of range falls back to F1 (sid 0); clamp 0..9.
                val sid = speakerId.coerceIn(0, tts.numSpeakers() - 1)
                val clampedSpeed = speed.coerceIn(0.5f, 2.0f)
                val lang = languageTagToSupertonicLang(languageTag)
                val genConfig = GenerationConfig(
                        sid = sid,
                        speed = clampedSpeed,
                        numSteps = 5,
                        extra = mapOf("lang" to lang),
                )
                val audio = tts.generateWithConfig(text = text, config = genConfig)
                val saved = audio.save(outputFile.absolutePath)
                Bridge.log("TTS generated ${outputFile.absolutePath}: saved=$saved sid=$sid lang=$lang")
                saved
            } catch (e: Exception) {
                Bridge.log("TTS_ERROR: ${e.javaClass.simpleName}: ${e.message}")
                e.printStackTrace()
                false
            } finally {
                scheduleIdleTeardownLocked()
            }
        }
    }

    private fun getOrCreateModelLocked(modelPath: String): OfflineTts {
        cachedTts?.let { cached ->
            if (cachedModelPath == modelPath) {
                Bridge.log("TTS reusing cached model")
                return cached
            }
            releaseCachedModelLocked("model path changed")
        }

        val modelDir = File(modelPath)
        val supertonic = OfflineTtsSupertonicModelConfig(
                durationPredictor = File(modelDir, FILE_DURATION_PREDICTOR).absolutePath,
                textEncoder = File(modelDir, FILE_TEXT_ENCODER).absolutePath,
                vectorEstimator = File(modelDir, FILE_VECTOR_ESTIMATOR).absolutePath,
                vocoder = File(modelDir, FILE_VOCODER).absolutePath,
                ttsJson = File(modelDir, FILE_TTS_JSON).absolutePath,
                unicodeIndexer = File(modelDir, FILE_UNICODE_INDEXER).absolutePath,
                voiceStyle = File(modelDir, FILE_VOICE_STYLE).absolutePath,
        )
        val modelConfig = OfflineTtsModelConfig(
                supertonic = supertonic,
                numThreads = 8,
                provider = "cpu",
        )
        val config = OfflineTtsConfig(
                model = modelConfig,
                maxNumSentences = 1,
                silenceScale = 0.2f,
        )
        return OfflineTts(null, config).also {
            cachedTts = it
            cachedModelPath = modelPath
            Bridge.log("TTS loaded model; keeping it warm for $MODEL_IDLE_TIMEOUT_MINUTES minutes after use")
        }
    }

    private fun scheduleIdleTeardownLocked() {
        if (cachedTts == null) return
        teardownFuture?.cancel(false)
        val generation = ++teardownGeneration
        teardownFuture =
                teardownExecutor.schedule(
                        {
                            synchronized(modelLock) {
                                if (generation == teardownGeneration) {
                                    releaseCachedModelLocked("idle for $MODEL_IDLE_TIMEOUT_MINUTES minutes")
                                }
                            }
                        },
                        MODEL_IDLE_TIMEOUT_MINUTES,
                        TimeUnit.MINUTES,
                )
    }

    private fun releaseCachedModelLocked(reason: String) {
        teardownFuture?.cancel(false)
        teardownFuture = null
        teardownGeneration++
        val tts = cachedTts
        cachedTts = null
        cachedModelPath = null
        if (tts == null) return
        try {
            tts.release()
            Bridge.log("TTS released cached model: $reason")
        } catch (e: Exception) {
            Bridge.log("TTS release failed: ${e.message}")
        }
    }

    private fun getPrefs(context: Context): SharedPreferences {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }
}
