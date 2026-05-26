package com.mentra.barcodescanner

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.net.Uri
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import androidx.exifinterface.media.ExifInterface
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import com.google.zxing.BarcodeFormat as ZxingBarcodeFormat
import com.google.zxing.oned.Code128Writer
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayInputStream
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.atan
import kotlin.math.sqrt

class MentraBarcodeScannerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MentraBarcodeScanner")

    AsyncFunction("isSupported") {
      true
    }

    AsyncFunction("scanImage") { imageUri: String ->
      scanImage(imageUri)
    }

    AsyncFunction("createTestBarcodeImage") { value: String ->
      createTestBarcodeImage(value)
    }

    AsyncFunction("getImageMetadata") { imageUri: String ->
      getImageMetadata(imageUri)
    }

    AsyncFunction("openImage") { imageUri: String ->
      openImage(imageUri)
    }
  }

  private fun scanImage(imageUri: String): List<Map<String, Any?>> {
    val context = reactContext()
    val image = inputImageFromUri(context, imageUri)
    val scanner = BarcodeScanning.getClient()
    return try {
      Tasks.await(scanner.process(image)).map(::barcodeToMap)
    } finally {
      scanner.close()
    }
  }

  private fun createTestBarcodeImage(value: String): Map<String, Any> {
    val safeValue = value.ifBlank { TEST_BARCODE_VALUE }
    val writer = Code128Writer()
    val matrix = writer.encode(safeValue, ZxingBarcodeFormat.CODE_128, TEST_BARCODE_WIDTH, TEST_BARCODE_HEIGHT)
    val bitmap = Bitmap.createBitmap(matrix.width, matrix.height, Bitmap.Config.ARGB_8888)
    for (y in 0 until matrix.height) {
      for (x in 0 until matrix.width) {
        bitmap.setPixel(x, y, if (matrix[x, y]) Color.BLACK else Color.WHITE)
      }
    }

    val file = File(reactContext().cacheDir, "mentra-barcode-test-${System.currentTimeMillis()}.png")
    FileOutputStream(file).use { output ->
      bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
    }
    return mapOf(
      "fileUri" to Uri.fromFile(file).toString(),
      "value" to safeValue,
      "byteCount" to file.length(),
    )
  }

  private fun getImageMetadata(imageUri: String): Map<String, Any?> {
    val context = reactContext()
    val bytes = readImageBytes(context, imageUri)
    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)

    val exif = runCatching {
      ExifInterface(ByteArrayInputStream(bytes))
    }.getOrNull()
    val width = positiveInt(options.outWidth)
      ?: positiveInt(exif?.getAttributeInt(ExifInterface.TAG_PIXEL_X_DIMENSION, 0))
      ?: positiveInt(exif?.getAttributeInt(ExifInterface.TAG_IMAGE_WIDTH, 0))
    val height = positiveInt(options.outHeight)
      ?: positiveInt(exif?.getAttributeInt(ExifInterface.TAG_PIXEL_Y_DIMENSION, 0))
      ?: positiveInt(exif?.getAttributeInt(ExifInterface.TAG_IMAGE_LENGTH, 0))
    val focalLength35mm = positiveInt(exif?.getAttributeInt(ExifInterface.TAG_FOCAL_LENGTH_IN_35MM_FILM, 0))
    return buildMap {
      put("width", width)
      put("height", height)
      put("focalLength35mm", focalLength35mm)
      put("estimatedFov", estimatedFov(width, height, focalLength35mm))
    }
  }

  private fun inputImageFromUri(context: Context, imageUri: String): InputImage {
    val uri = Uri.parse(imageUri)
    val scheme = uri.scheme.orEmpty().lowercase()
    if (scheme == "http" || scheme == "https") {
      return InputImage.fromBitmap(downloadBitmap(imageUri), 0)
    }
    return InputImage.fromFilePath(context, uri)
  }

  private fun openImage(imageUri: String) {
    val context = reactContext()
    val parsed = Uri.parse(imageUri)
    val uri = viewerUri(context, parsed)
    val intent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, mimeTypeFor(parsed))
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    val viewerIntent = preferredImageViewerIntent(context, intent)
    val activity = appContext.currentActivity
    if (activity != null) {
      activity.startActivity(viewerIntent)
    } else {
      viewerIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(viewerIntent)
    }
  }

  private fun preferredImageViewerIntent(context: Context, baseIntent: Intent): Intent {
    for (packageName in PREFERRED_IMAGE_VIEWER_PACKAGES) {
      val candidate = Intent(baseIntent).setPackage(packageName)
      if (candidate.resolveActivity(context.packageManager) != null) {
        return candidate
      }
    }
    return baseIntent
  }

  private fun viewerUri(context: Context, uri: Uri): Uri {
    if (uri.scheme.orEmpty().lowercase() != "file") {
      return uri
    }
    val file = File(uri.path ?: throw IllegalStateException("Invalid file URI"))
    return FileProvider.getUriForFile(
      context,
      "${context.packageName}.mentra.barcodescanner.fileprovider",
      file,
    )
  }

  private fun mimeTypeFor(uri: Uri): String {
    val extension = MimeTypeMap.getFileExtensionFromUrl(uri.toString()).lowercase()
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "image/*"
  }

  private fun readImageBytes(context: Context, imageUri: String): ByteArray {
    val uri = Uri.parse(imageUri)
    val scheme = uri.scheme.orEmpty().lowercase()
    if (scheme == "http" || scheme == "https") {
      return downloadBytes(imageUri)
    }
    if (scheme == "content") {
      return context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
        ?: throw IllegalStateException("Could not read image URI")
    }
    return File(uri.path ?: throw IllegalStateException("Invalid file URI")).readBytes()
  }

  private fun downloadBytes(imageUri: String): ByteArray {
    val connection = URL(imageUri).openConnection() as HttpURLConnection
    connection.connectTimeout = HTTP_TIMEOUT_MS
    connection.readTimeout = HTTP_TIMEOUT_MS
    connection.requestMethod = "GET"
    connection.doInput = true
    connection.connect()
    try {
      if (connection.responseCode !in 200..299) {
        throw IllegalStateException("Image request returned HTTP ${connection.responseCode}")
      }
      return connection.inputStream.use { it.readBytes() }
    } finally {
      connection.disconnect()
    }
  }

  private fun downloadBitmap(imageUri: String): Bitmap {
    val connection = URL(imageUri).openConnection() as HttpURLConnection
    connection.connectTimeout = HTTP_TIMEOUT_MS
    connection.readTimeout = HTTP_TIMEOUT_MS
    connection.requestMethod = "GET"
    connection.doInput = true
    connection.connect()
    try {
      if (connection.responseCode !in 200..299) {
        throw IllegalStateException("Image request returned HTTP ${connection.responseCode}")
      }
      return connection.inputStream.use { input ->
        BitmapFactory.decodeStream(input)
          ?: throw IllegalStateException("Could not decode image")
      }
    } finally {
      connection.disconnect()
    }
  }

  private fun positiveInt(value: Int?): Int? = value?.takeIf { it > 0 }

  private fun estimatedFov(width: Int?, height: Int?, focalLength35mm: Int?): Map<String, Any>? {
    val focalLength = focalLength35mm?.takeIf { it > 0 } ?: return null
    val aspect = if (width != null && height != null && height > 0) {
      width.toDouble() / height.toDouble()
    } else {
      4.0 / 3.0
    }
    val sensorHeight = FULL_FRAME_DIAGONAL_MM / sqrt((aspect * aspect) + 1.0)
    val sensorWidth = sensorHeight * aspect
    return mapOf(
      "basis" to "35mm_equivalent",
      "focalLength35mm" to focalLength,
      "diagonalDegrees" to fovDegrees(FULL_FRAME_DIAGONAL_MM, focalLength.toDouble()),
      "horizontalDegrees" to fovDegrees(sensorWidth, focalLength.toDouble()),
      "verticalDegrees" to fovDegrees(sensorHeight, focalLength.toDouble()),
    )
  }

  private fun fovDegrees(sensorMm: Double, focalLengthMm: Double): Double {
    return 2.0 * atan(sensorMm / (2.0 * focalLengthMm)) * 180.0 / Math.PI
  }

  private fun barcodeToMap(barcode: Barcode): Map<String, Any?> {
    return buildMap {
      put("rawValue", barcode.rawValue)
      put("displayValue", barcode.displayValue)
      put("format", formatName(barcode.format))
      put("valueType", valueTypeName(barcode.valueType))
      barcode.boundingBox?.let { rect ->
        put(
          "bounds",
          mapOf(
            "x" to rect.left,
            "y" to rect.top,
            "width" to rect.width(),
            "height" to rect.height(),
          ),
        )
      }
      barcode.cornerPoints?.let { points ->
        put(
          "cornerPoints",
          points.map { point ->
            mapOf(
              "x" to point.x,
              "y" to point.y,
            )
          },
        )
      }
    }
  }

  private fun formatName(format: Int): String {
    return when (format) {
      Barcode.FORMAT_CODE_128 -> "CODE_128"
      Barcode.FORMAT_CODE_39 -> "CODE_39"
      Barcode.FORMAT_CODE_93 -> "CODE_93"
      Barcode.FORMAT_CODABAR -> "CODABAR"
      Barcode.FORMAT_DATA_MATRIX -> "DATA_MATRIX"
      Barcode.FORMAT_EAN_13 -> "EAN_13"
      Barcode.FORMAT_EAN_8 -> "EAN_8"
      Barcode.FORMAT_ITF -> "ITF"
      Barcode.FORMAT_QR_CODE -> "QR_CODE"
      Barcode.FORMAT_UPC_A -> "UPC_A"
      Barcode.FORMAT_UPC_E -> "UPC_E"
      Barcode.FORMAT_PDF417 -> "PDF417"
      Barcode.FORMAT_AZTEC -> "AZTEC"
      else -> "UNKNOWN"
    }
  }

  private fun valueTypeName(valueType: Int): String {
    return when (valueType) {
      Barcode.TYPE_CALENDAR_EVENT -> "CALENDAR_EVENT"
      Barcode.TYPE_CONTACT_INFO -> "CONTACT_INFO"
      Barcode.TYPE_DRIVER_LICENSE -> "DRIVER_LICENSE"
      Barcode.TYPE_EMAIL -> "EMAIL"
      Barcode.TYPE_GEO -> "GEO"
      Barcode.TYPE_ISBN -> "ISBN"
      Barcode.TYPE_PHONE -> "PHONE"
      Barcode.TYPE_PRODUCT -> "PRODUCT"
      Barcode.TYPE_SMS -> "SMS"
      Barcode.TYPE_TEXT -> "TEXT"
      Barcode.TYPE_URL -> "URL"
      Barcode.TYPE_WIFI -> "WIFI"
      else -> "UNKNOWN"
    }
  }

  private fun reactContext(): Context {
    return appContext.reactContext
      ?: appContext.currentActivity
      ?: throw Exceptions.ReactContextLost()
  }

  private companion object {
    const val HTTP_TIMEOUT_MS = 12_000
    const val TEST_BARCODE_VALUE = "MENTRA-BARCODE-12345"
    const val TEST_BARCODE_WIDTH = 1024
    const val TEST_BARCODE_HEIGHT = 320
    const val FULL_FRAME_DIAGONAL_MM = 43.266615305567875
    val PREFERRED_IMAGE_VIEWER_PACKAGES = listOf(
      "com.sec.android.gallery3d",
      "com.google.android.apps.photos",
    )
  }
}
