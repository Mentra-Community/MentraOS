package com.mentra.crust

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.URL

class CrustModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("Crust")

    Constant("PI") {
      Math.PI
    }

    Events("onChange")

    Function("hello") {
      "Hello world! 👋"
    }

    AsyncFunction("setValueAsync") { value: String ->
      sendEvent("onChange", mapOf(
        "value" to value
      ))
    }

    View(CrustView::class) {
      Prop("url") { view: CrustView, url: URL ->
        view.webView.loadUrl(url.toString())
      }
      Events("onLoad")
    }

    // MARK: - Image Processing Commands

    AsyncFunction("processGalleryImage") { inputPath: String, outputPath: String, options: Map<String, Any?> ->
      try {
        val inputFile = java.io.File(inputPath)
        if (!inputFile.exists()) {
          throw IllegalArgumentException("Input file does not exist: $inputPath")
        }

        val lensCorrection = options["lensCorrection"] as? Boolean ?: true
        val colorCorrection = options["colorCorrection"] as? Boolean ?: true

        val processingTimeMs = com.mentra.crust.utils.ImageProcessor.process(
          inputPath, outputPath, lensCorrection, colorCorrection, 95
        )

        if (processingTimeMs >= 0) {
          mapOf(
            "success" to true,
            "outputPath" to outputPath,
            "processingTimeMs" to processingTimeMs
          )
        } else {
          mapOf("success" to false, "error" to "Processing failed")
        }
      } catch (e: Exception) {
        android.util.Log.e("CrustModule", "processGalleryImage error: ${e.message}", e)
        mapOf("success" to false, "error" to (e.message ?: "Unknown error"))
      }
    }

    // MARK: - HDR Merge Commands

    AsyncFunction("mergeHdrBrackets") { underPath: String, normalPath: String, overPath: String, outputPath: String ->
      try {
        val processingTimeMs = com.mentra.crust.utils.ImageProcessor.mergeHdr(
          underPath, normalPath, overPath, outputPath, 95
        )
        if (processingTimeMs >= 0) {
          mapOf(
            "success" to true,
            "outputPath" to outputPath,
            "processingTimeMs" to processingTimeMs
          )
        } else {
          mapOf("success" to false, "error" to "HDR merge failed")
        }
      } catch (e: Exception) {
        android.util.Log.e("CrustModule", "mergeHdrBrackets error: ${e.message}", e)
        mapOf("success" to false, "error" to (e.message ?: "Unknown error"))
      }
    }

    // MARK: - Video Stabilization Commands

    AsyncFunction("stabilizeVideo") { inputPath: String, imuPath: String, outputPath: String ->
      try {
        val inputFile = java.io.File(inputPath)
        val imuFile = java.io.File(imuPath)
        if (!inputFile.exists()) {
          throw IllegalArgumentException("Input video does not exist: $inputPath")
        }
        if (!imuFile.exists()) {
          throw IllegalArgumentException("IMU sidecar does not exist: $imuPath")
        }

        val processingTimeMs = com.mentra.crust.utils.VideoStabilizer.stabilize(
          inputPath, imuPath, outputPath
        )

        if (processingTimeMs >= 0) {
          mapOf(
            "success" to true,
            "outputPath" to outputPath,
            "processingTimeMs" to processingTimeMs
          )
        } else {
          mapOf("success" to false, "error" to "Stabilization failed")
        }
      } catch (e: Exception) {
        android.util.Log.e("CrustModule", "stabilizeVideo error: ${e.message}", e)
        mapOf("success" to false, "error" to (e.message ?: "Unknown error"))
      }
    }

    // MARK: - Media Library Commands

    AsyncFunction("saveToGalleryWithDate") { filePath: String, captureTimeMillis: Long? ->
      val context =
        appContext.reactContext
          ?: appContext.currentActivity
            ?: throw IllegalStateException("No context available")

      try {
        val file = java.io.File(filePath)
        if (!file.exists()) {
          throw IllegalArgumentException("File does not exist: $filePath")
        }

        val mimeType =
          when (file.extension.lowercase()) {
            "jpg", "jpeg" -> "image/jpeg"
            "png" -> "image/png"
            "mp4" -> "video/mp4"
            "mov" -> "video/quicktime"
            else -> "application/octet-stream"
          }

        val isVideo = mimeType.startsWith("video/")
        val collection =
          if (isVideo) {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
              android.provider.MediaStore.Video.Media.getContentUri(
                android.provider.MediaStore.VOLUME_EXTERNAL_PRIMARY
              )
            } else {
              android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI
            }
          } else {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
              android.provider.MediaStore.Images.Media.getContentUri(
                android.provider.MediaStore.VOLUME_EXTERNAL_PRIMARY
              )
            } else {
              android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            }
          }

        val values =
          android.content.ContentValues().apply {
            put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, file.name)
            put(android.provider.MediaStore.MediaColumns.MIME_TYPE, mimeType)
            put(android.provider.MediaStore.MediaColumns.SIZE, file.length())

            if (captureTimeMillis != null) {
              if (isVideo) {
                put(android.provider.MediaStore.Video.Media.DATE_TAKEN, captureTimeMillis)
              } else {
                put(android.provider.MediaStore.Images.Media.DATE_TAKEN, captureTimeMillis)
              }
              android.util.Log.d(
                "CrustModule",
                "Setting DATE_TAKEN to: $captureTimeMillis (${java.util.Date(captureTimeMillis)})"
              )
            }

            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
              put(
                android.provider.MediaStore.MediaColumns.RELATIVE_PATH,
                "DCIM/Camera"
              )
              put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1)
            }
          }

        val resolver = context.contentResolver
        val uri =
          resolver.insert(collection, values)
            ?: throw IllegalStateException("Failed to create MediaStore entry")

        try {
          resolver.openOutputStream(uri)?.use { outputStream ->
            file.inputStream().use { inputStream -> inputStream.copyTo(outputStream) }
          } ?: throw IllegalStateException("Failed to open output stream")

          if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            values.clear()
            values.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
          }

          android.util.Log.d(
            "CrustModule",
            "Successfully saved to gallery with proper DATE_TAKEN: ${file.name}"
          )
          mapOf("success" to true, "uri" to uri.toString())
        } catch (e: Exception) {
          resolver.delete(uri, null, null)
          throw e
        }
      } catch (e: Exception) {
        android.util.Log.e("CrustModule", "Error saving to gallery: ${e.message}", e)
        mapOf("success" to false, "error" to e.message)
      }
    }
  }
}
