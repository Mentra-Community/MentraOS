package com.mentra.core.tts

import android.content.Context
import android.content.SharedPreferences
import com.k2fsa.sherpa.onnx.OfflineTts
import com.k2fsa.sherpa.onnx.OfflineTtsConfig
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig
import com.mentra.core.Bridge
import java.io.File

/** Utilities for offline Sherpa-ONNX TTS model management and synthesis. */
object TTSTools {
    private const val PREFS_NAME = "MentraPrefs"
    private const val KEY_TTS_MODEL_PATH = "TTSModelPath"
    private const val KEY_TTS_MODEL_LANGUAGE = "TTSModelLanguageCode"

    fun setTtsModelDetails(context: Context, path: String, languageCode: String) {
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

        val modelFile = findVitsModelFile(modelDir)
        if (modelFile == null) {
            Bridge.log("TTS model missing VITS .onnx file at: $path")
            return false
        }

        val tokensFile = File(modelDir, "tokens.txt")
        if (!tokensFile.exists() || !tokensFile.canRead() || tokensFile.length() == 0L) {
            Bridge.log("TTS model missing tokens.txt at: $path")
            return false
        }

        val dataDir = File(modelDir, "espeak-ng-data")
        if (!dataDir.exists() || !dataDir.isDirectory) {
            Bridge.log("TTS model missing espeak-ng-data at: $path")
            return false
        }

        return true
    }

    fun generateTtsAudio(
            text: String,
            modelPath: String,
            outputPath: String,
            speakerId: Int,
            speed: Float
    ): Boolean {
        if (text.isBlank()) {
            Bridge.log("TTS_ERROR: text is empty")
            return false
        }
        if (!validateTTSModel(modelPath)) {
            Bridge.log("TTS_ERROR: model is invalid: $modelPath")
            return false
        }

        val modelDir = File(modelPath)
        val modelFile = findVitsModelFile(modelDir) ?: return false
        val outputFile = File(outputPath)
        outputFile.parentFile?.mkdirs()

        var tts: OfflineTts? = null
        return try {
            val vits = OfflineTtsVitsModelConfig()
            vits.model = modelFile.absolutePath
            vits.tokens = File(modelDir, "tokens.txt").absolutePath
            vits.dataDir = File(modelDir, "espeak-ng-data").absolutePath

            val modelConfig = OfflineTtsModelConfig()
            modelConfig.vits = vits
            modelConfig.numThreads = 1
            modelConfig.provider = "cpu"

            val config = OfflineTtsConfig()
            config.model = modelConfig
            config.maxNumSentences = 1
            config.silenceScale = 0.2f

            tts = OfflineTts(null, config)
            val audio = tts.generate(text, speakerId.coerceAtLeast(0), speed.coerceIn(0.5f, 2.0f))
            val saved = audio.save(outputFile.absolutePath)
            Bridge.log("TTS generated ${outputFile.absolutePath}: saved=$saved")
            saved
        } catch (e: Exception) {
            Bridge.log("TTS_ERROR: ${e.javaClass.simpleName}: ${e.message}")
            e.printStackTrace()
            false
        } finally {
            try {
                tts?.release()
            } catch (e: Exception) {
                Bridge.log("TTS release failed: ${e.message}")
            }
        }
    }

    private fun getPrefs(context: Context): SharedPreferences {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    private fun findVitsModelFile(modelDir: File): File? {
        return modelDir.listFiles()?.firstOrNull { file ->
            file.isFile && file.name.endsWith(".onnx") && file.canRead() && file.length() > 0
        }
    }
}
