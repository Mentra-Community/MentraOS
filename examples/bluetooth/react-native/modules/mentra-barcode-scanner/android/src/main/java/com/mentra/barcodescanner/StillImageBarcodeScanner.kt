package com.mentra.barcodescanner

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Rect
import android.util.Log
import androidx.exifinterface.media.ExifInterface
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.io.ByteArrayInputStream
import kotlin.math.roundToInt

internal class StillImageBarcodeScanner(
  private val imageBytes: ByteArray,
) {
  private val rotationDegrees = rotationDegrees(imageBytes)

  fun scan(scanner: BarcodeScanner): List<Map<String, Any?>> {
    val bitmap = BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.size)
      ?: throw IllegalStateException("Could not decode image")

    return try {
      val fullImageResults = process(scanner, bitmap, ScanTransform())
      if (fullImageResults.isNotEmpty()) {
        return fullImageResults
      }

      scanFallbackVariants(scanner, bitmap)
    } finally {
      bitmap.recycle()
    }
  }

  private fun scanFallbackVariants(scanner: BarcodeScanner, bitmap: Bitmap): List<Map<String, Any?>> {
    for (variant in FALLBACK_VARIANTS) {
      val cropRect = variant.cropRect(bitmap.width, bitmap.height)
      if (cropRect.width() < MIN_CROP_SIZE_PX || cropRect.height() < MIN_CROP_SIZE_PX) {
        continue
      }

      val crop = Bitmap.createBitmap(bitmap, cropRect.left, cropRect.top, cropRect.width(), cropRect.height())
      val image = if (variant.scale > 1) {
        Bitmap.createScaledBitmap(crop, crop.width * variant.scale, crop.height * variant.scale, false)
      } else {
        crop
      }

      try {
        val transform = ScanTransform(cropRect.left, cropRect.top, variant.scale.toFloat())
        val results = process(scanner, image, transform)
        if (results.isNotEmpty()) {
          Log.d(TAG, "Barcode decoded from fallback crop ${variant.name}")
          return results
        }
      } finally {
        if (image !== crop) {
          image.recycle()
        }
        crop.recycle()
      }
    }
    return emptyList()
  }

  private fun process(
    scanner: BarcodeScanner,
    bitmap: Bitmap,
    transform: ScanTransform,
  ): List<Map<String, Any?>> {
    val image = InputImage.fromBitmap(bitmap, rotationDegrees)
    return Tasks.await(scanner.process(image)).map { barcodeToMap(it, transform) }
  }

  private fun barcodeToMap(barcode: Barcode, transform: ScanTransform): Map<String, Any?> {
    return buildMap {
      put("rawValue", barcode.rawValue)
      put("displayValue", barcode.displayValue)
      put("format", formatName(barcode.format))
      put("valueType", valueTypeName(barcode.valueType))
      barcode.boundingBox?.let { rect ->
        put(
          "bounds",
          mapOf(
            "x" to transform.x(rect.left),
            "y" to transform.y(rect.top),
            "width" to transform.size(rect.width()),
            "height" to transform.size(rect.height()),
          ),
        )
      }
      barcode.cornerPoints?.let { points ->
        put(
          "cornerPoints",
          points.map { point ->
            mapOf(
              "x" to transform.x(point.x),
              "y" to transform.y(point.y),
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

  private data class ScanTransform(
    val left: Int = 0,
    val top: Int = 0,
    val scale: Float = 1f,
  ) {
    fun x(value: Int): Int = (left + (value / scale)).roundToInt()

    fun y(value: Int): Int = (top + (value / scale)).roundToInt()

    fun size(value: Int): Int = (value / scale).roundToInt()
  }

  private data class CropVariant(
    val name: String,
    val left: Float,
    val top: Float,
    val width: Float,
    val height: Float,
    val scale: Int,
  ) {
    fun cropRect(imageWidth: Int, imageHeight: Int): Rect {
      val x = (left * imageWidth).roundToInt().coerceIn(0, imageWidth - 1)
      val y = (top * imageHeight).roundToInt().coerceIn(0, imageHeight - 1)
      val right = ((left + width) * imageWidth).roundToInt().coerceIn(x + 1, imageWidth)
      val bottom = ((top + height) * imageHeight).roundToInt().coerceIn(y + 1, imageHeight)
      return Rect(x, y, right, bottom)
    }
  }

  private companion object {
    const val TAG = "MentraBarcodeScanner"
    const val MIN_CROP_SIZE_PX = 160

    // Keep this fallback plan isolated: the normal API stays scanImage(uri), and these
    // crops can be removed if ML Kit becomes reliable enough on distant 1D barcodes.
    val FALLBACK_VARIANTS = listOf(
      CropVariant("center-wide-2x", 0.12f, 0.18f, 0.76f, 0.58f, 2),
      CropVariant("upper-band-2x", 0.06f, 0.10f, 0.88f, 0.42f, 2),
      CropVariant("middle-band-2x", 0.06f, 0.28f, 0.88f, 0.42f, 2),
      CropVariant("lower-band-2x", 0.06f, 0.46f, 0.88f, 0.42f, 2),
      CropVariant("left-center-2x", 0.00f, 0.20f, 0.58f, 0.60f, 2),
      CropVariant("right-center-2x", 0.42f, 0.20f, 0.58f, 0.60f, 2),
      CropVariant("top-left-2x", 0.00f, 0.00f, 0.50f, 0.50f, 2),
      CropVariant("top-middle-2x", 0.25f, 0.00f, 0.50f, 0.50f, 2),
      CropVariant("top-right-2x", 0.50f, 0.00f, 0.50f, 0.50f, 2),
      CropVariant("middle-left-2x", 0.00f, 0.25f, 0.50f, 0.50f, 2),
      CropVariant("middle-2x", 0.25f, 0.25f, 0.50f, 0.50f, 2),
      CropVariant("middle-right-2x", 0.50f, 0.25f, 0.50f, 0.50f, 2),
      CropVariant("bottom-left-2x", 0.00f, 0.50f, 0.50f, 0.50f, 2),
      CropVariant("bottom-middle-2x", 0.25f, 0.50f, 0.50f, 0.50f, 2),
      CropVariant("bottom-right-2x", 0.50f, 0.50f, 0.50f, 0.50f, 2),
    )

    fun rotationDegrees(imageBytes: ByteArray): Int {
      val exif = runCatching { ExifInterface(ByteArrayInputStream(imageBytes)) }.getOrNull()
      return when (exif?.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
        ExifInterface.ORIENTATION_ROTATE_90 -> 90
        ExifInterface.ORIENTATION_ROTATE_180 -> 180
        ExifInterface.ORIENTATION_ROTATE_270 -> 270
        else -> 0
      }
    }
  }
}
