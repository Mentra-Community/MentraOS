package com.mentra.bluetoothsdk.stt

import android.content.Context
import android.content.SharedPreferences
import com.mentra.bluetoothsdk.Bridge
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream

/**
 * Wraps an InputStream so we can observe how many compressed bytes have been
 * consumed from the source .tar.bz2. Used to report extraction progress to JS
 * — bz2 reads sequentially, so bytes-consumed/total is a reasonable proxy for
 * "% of work done".
 */
private class ProgressInputStream(
        private val wrapped: InputStream,
        private val totalBytes: Long,
        private val onProgress: (Long, Long) -> Unit,
) : InputStream() {
    private var bytesRead: Long = 0
    private var lastEmittedAt: Long = 0
    private val emitIntervalMs = 200L

    override fun read(): Int {
        val byte = wrapped.read()
        if (byte != -1) {
            bytesRead++
            maybeEmit()
        }
        return byte
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        val n = wrapped.read(b, off, len)
        if (n > 0) {
            bytesRead += n
            maybeEmit()
        }
        return n
    }

    override fun close() {
        wrapped.close()
    }

    private fun maybeEmit() {
        val now = System.currentTimeMillis()
        if (now - lastEmittedAt >= emitIntervalMs) {
            lastEmittedAt = now
            onProgress(bytesRead, totalBytes)
        }
    }
}

/**
 * STTTools provides utilities for STT model management.
 *
 * Features:
 * - Model path and language code storage
 * - Model validation (check for required files)
 * - tar.bz2 extraction for downloaded models
 *
 * Ported from iOS STTTools.swift to match iOS functionality 1:1
 */
object STTTools {
    private const val TAG = "STTTools"
    private const val PREFS_NAME = "MentraPrefs"
    private const val KEY_STT_MODEL_PATH = "STTModelPath"
    private const val KEY_STT_MODEL_LANGUAGE = "STTModelLanguageCode"

    /** Save STT model details to SharedPreferences */
    fun setSttModelDetails(context: Context, path: String, languageCode: String) {
        val prefs = getPrefs(context)
        prefs.edit().apply {
            putString(KEY_STT_MODEL_PATH, path)
            putString(KEY_STT_MODEL_LANGUAGE, languageCode)
            apply()
        }
        Bridge.log("STT model details saved: path=$path, language=$languageCode")
    }

    /** Get the STT model path from SharedPreferences */
    fun getSttModelPath(context: Context): String {
        val prefs = getPrefs(context)
        return prefs.getString(KEY_STT_MODEL_PATH, "") ?: ""
    }

    /** Get the STT model language code from SharedPreferences */
    fun getSttModelLanguage(context: Context): String {
        val prefs = getPrefs(context)
        return prefs.getString(KEY_STT_MODEL_LANGUAGE, "en-US") ?: "en-US"
    }

    /** Check if an STT model is available and valid */
    fun checkSTTModelAvailable(context: Context): Boolean {
        val modelPath = getSttModelPath(context)
        if (modelPath.isEmpty()) {
            return false
        }

        return validateSTTModel(modelPath)
    }

    /**
     * Validate that an STT model has all required files
     *
     * Required files:
     * - tokens.txt (required for all models)
     * - Either CTC model (model.int8.onnx)
     * - Or Transducer model (encoder.onnx, decoder.onnx, joiner.onnx)
     */
    fun validateSTTModel(path: String): Boolean {
        try {
            val modelDir = File(path)

            if (!modelDir.exists() || !modelDir.isDirectory) {
                Bridge.log("STT model path does not exist or is not a directory: $path")
                return false
            }

            // Check for tokens.txt (required for all models)
            val tokensFile = File(modelDir, "tokens.txt")
            if (!tokensFile.exists()) {
                Bridge.log("STT model missing tokens.txt at: $path")
                return false
            }

            // Check for CTC model
            val ctcModelFile = findReadableFile(modelDir, listOf("model.int8.onnx", "model.onnx"))
            if (ctcModelFile.exists() && ctcModelFile.canRead() && ctcModelFile.length() > 0) {
                Bridge.log("STT CTC model found at: $path (size: ${ctcModelFile.length()} bytes)")
                return true
            }

            // Check for transducer model
            val transducerFiles =
                    listOf(
                            "encoder" to listOf("encoder.onnx", "encoder.int8.onnx"),
                            "decoder" to listOf("decoder.onnx", "decoder.int8.onnx"),
                            "joiner" to listOf("joiner.onnx", "joiner.int8.onnx")
                    )
            val allTransducerFilesPresent =
                    transducerFiles.all { (label, candidates) ->
                        val file = findReadableFile(modelDir, candidates)
                        val exists = file.exists() && file.canRead() && file.length() > 0
                        if (!exists) {
                            Bridge.log(
                                    "STT model missing or invalid transducer file: $label at $path"
                            )
                        }
                        exists
                    }

            if (allTransducerFilesPresent) {
                Bridge.log("STT Transducer model found at: $path")
                return true
            }

            Bridge.log("No complete STT model found at: $path")
            return false
        } catch (e: Exception) {
            Bridge.log("STT_ERROR: ${e.message}")
            return false
        }
    }

    /**
     * Extract a tar.bz2 file to a destination directory
     *
     * @param sourcePath Path to the .tar.bz2 file
     * @param destinationPath Directory to extract to
     * @return true if extraction succeeded, false otherwise
     */
    fun extractTarBz2(sourcePath: String, destinationPath: String): Boolean {
        try {
            val sourceFile = File(sourcePath)
            if (!sourceFile.exists()) {
                Bridge.log("EXTRACTION_ERROR: Source file does not exist: $sourcePath")
                return false
            }

            val destDir = File(destinationPath)

            // Create destination directory if it doesn't exist
            if (!destDir.exists()) {
                Bridge.log("Creating destination directory: $destinationPath")
                if (!destDir.mkdirs()) {
                    Bridge.log(
                            "EXTRACTION_ERROR: Failed to create destination directory: $destinationPath"
                    )
                    return false
                }
            }

            Bridge.log("Extracting tar.bz2 from $sourcePath to $destinationPath")
            Bridge.log("Source file size: ${sourceFile.length() / 1024 / 1024}MB")

            val startTime = System.currentTimeMillis()
            var fileCount = 0
            var bytesExtracted = 0L

            val totalCompressedBytes = sourceFile.length()
            Bridge.sendExtractionProgress(0, 0, totalCompressedBytes)

            // Open the tar.bz2 file with buffered streams for better performance
            FileInputStream(sourceFile).use { fis ->
                ProgressInputStream(fis, totalCompressedBytes) { read, total ->
                    val pct =
                            if (total > 0) ((read * 99L) / total).coerceIn(0L, 99L).toInt() else 0
                    Bridge.sendExtractionProgress(pct, read, total)
                }.use { progress ->
                BufferedInputStream(progress, 65536).use { bis ->
                    Bridge.log("Opening bz2 decompression stream...")
                    BZip2CompressorInputStream(bis).use { bzIn ->
                        Bridge.log("Opening tar archive stream...")
                        TarArchiveInputStream(bzIn).use { tarIn ->
                            Bridge.log("Reading first tar entry...")
                            var entry = tarIn.nextEntry

                            while (entry != null) {
                                try {
                                    val outputFile = File(destDir, entry.name)

                                    if (entry.isDirectory) {
                                        if (!outputFile.exists()) {
                                            outputFile.mkdirs()
                                        }
                                    } else {
                                        outputFile.parentFile?.let { parent ->
                                            if (!parent.exists()) {
                                                parent.mkdirs()
                                            }
                                        }

                                        FileOutputStream(outputFile).use { fos ->
                                            BufferedOutputStream(fos, 65536).use { bos ->
                                                // 64KB buffer matches iOS path and cuts JNI/stream
                                                // overhead ~16x vs. the prior 4KB. The per-read
                                                // progress hook is already 200ms-throttled by
                                                // ProgressInputStream, so we don't log per-chunk.
                                                val buffer = ByteArray(65536)
                                                var len: Int
                                                var fileBytes = 0L
                                                val fileSizeMB = entry.size / 1024 / 1024
                                                var lastProgressMB = 0L

                                                while (tarIn.read(buffer).also { len = it } != -1) {
                                                    bos.write(buffer, 0, len)
                                                    fileBytes += len
                                                    bytesExtracted += len

                                                    if (fileSizeMB > 10) {
                                                        val currentMB = fileBytes / 1024 / 1024
                                                        if (currentMB >= lastProgressMB + 10) {
                                                            lastProgressMB = currentMB
                                                            val percent =
                                                                    if (entry.size > 0)
                                                                            (fileBytes * 100 / entry.size)
                                                                    else 0
                                                            Bridge.log(
                                                                    "  Extracting ${entry.name}: ${currentMB}MB / ${fileSizeMB}MB (${percent}%)"
                                                            )
                                                        }
                                                    }
                                                }

                                                fileCount++
                                            }
                                        }
                                    }

                                    entry = tarIn.nextEntry
                                } catch (e: Exception) {
                                    Bridge.log(
                                            "ERROR extracting entry ${entry?.name}: ${e.javaClass.simpleName}: ${e.message}"
                                    )
                                    e.printStackTrace()
                                    throw e
                                }
                            }

                            Bridge.log("Finished reading all tar entries")
                        }
                    }
                }
                }
            }

            Bridge.sendExtractionProgress(100, totalCompressedBytes, totalCompressedBytes)

            val duration = (System.currentTimeMillis() - startTime) / 1000
            val mbExtracted = bytesExtracted / 1024 / 1024
            Bridge.log(
                    "Extraction completed successfully: $fileCount files, ${mbExtracted}MB in ${duration}s"
            )

            // Rename epoch-numbered files to expected names for transducer models
            // Files are extracted to a subdirectory, find it
            val subdirs = destDir.listFiles { file -> file.isDirectory } ?: emptyArray()
            val actualModelDir = if (subdirs.isNotEmpty()) subdirs[0] else destDir
            Bridge.log("Model directory: ${actualModelDir.absolutePath}")

            // Rename encoder
            val oldEncoderFile = File(actualModelDir, "encoder-epoch-99-avg-1.onnx")
            val newEncoderFile = File(actualModelDir, "encoder.onnx")
            if (oldEncoderFile.exists()) {
                Bridge.log("Renaming encoder-epoch-99-avg-1.onnx to encoder.onnx")
                oldEncoderFile.renameTo(newEncoderFile)
            }

            // Rename decoder
            val oldDecoderFile = File(actualModelDir, "decoder-epoch-99-avg-1.onnx")
            val newDecoderFile = File(actualModelDir, "decoder.onnx")
            if (oldDecoderFile.exists()) {
                Bridge.log("Renaming decoder-epoch-99-avg-1.onnx to decoder.onnx")
                oldDecoderFile.renameTo(newDecoderFile)
            }

            // Rename joiner
            val oldJoinerFile = File(actualModelDir, "joiner-epoch-99-avg-1.int8.onnx")
            val newJoinerFile = File(actualModelDir, "joiner.onnx")
            if (oldJoinerFile.exists()) {
                Bridge.log("Renaming joiner-epoch-99-avg-1.int8.onnx to joiner.onnx")
                oldJoinerFile.renameTo(newJoinerFile)
            }

            // If files were extracted to subdirectory, move them to parent directory
            if (actualModelDir != destDir) {
                Bridge.log("Moving files from subdirectory to parent directory")
                actualModelDir.listFiles()?.forEach { file ->
                    val targetFile = File(destDir, file.name)
                    if (targetFile.exists()) {
                        targetFile.deleteRecursively()
                    }
                    Bridge.log("Moving ${file.name}")
                    file.renameTo(targetFile)
                }
                // Delete the now-empty subdirectory
                actualModelDir.delete()
            }

            return true
        } catch (e: Exception) {
            Bridge.log("EXTRACTION_ERROR: ${e.javaClass.simpleName}: ${e.message}")
            e.printStackTrace()
            return false
        }
    }

    /** Get SharedPreferences instance */
    private fun getPrefs(context: Context): SharedPreferences {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    private fun findReadableFile(modelDir: File, candidates: List<String>): File {
        return candidates.map { File(modelDir, it) }.firstOrNull { file ->
            file.exists() && file.canRead() && file.length() > 0
        } ?: File(modelDir, candidates.first())
    }

    /** Clear all STT model settings */
    fun clearSttModelSettings(context: Context) {
        val prefs = getPrefs(context)
        prefs.edit().apply {
            remove(KEY_STT_MODEL_PATH)
            remove(KEY_STT_MODEL_LANGUAGE)
            apply()
        }
        Bridge.log("STT model settings cleared")
    }

    /** Get a summary of the current STT model configuration */
    fun getModelConfigSummary(context: Context): String {
        val path = getSttModelPath(context)
        val language = getSttModelLanguage(context)
        val isValid = checkSTTModelAvailable(context)

        return """
            STT Model Configuration:
            - Path: ${if (path.isEmpty()) "(not set)" else path}
            - Language: $language
            - Valid: $isValid
        """.trimIndent()
    }
}
