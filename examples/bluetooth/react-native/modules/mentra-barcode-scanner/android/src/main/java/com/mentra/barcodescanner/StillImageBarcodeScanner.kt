package com.mentra.barcodescanner

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Point
import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import androidx.exifinterface.media.ExifInterface
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.io.ByteArrayInputStream
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt
import zxingcpp.BarcodeReader as ZxingCppBarcodeReader

internal class StillImageBarcodeScanner(
  private val imageBytes: ByteArray,
) {
  private val rotationDegrees = rotationDegrees(imageBytes)
  private var scanStartedAtMs = 0L
  private var scanBudgetLogged = false

  fun scan(scanner: BarcodeScanner): List<Map<String, Any?>> {
    scanStartedAtMs = SystemClock.elapsedRealtime()
    val bitmap = BitmapFactory.decodeByteArray(imageBytes, 0, imageBytes.size)
      ?: throw IllegalStateException("Could not decode image")

    return try {
      val fullImageResults = process(scanner, bitmap, ScanTransform())
      if (fullImageResults.isNotEmpty()) {
        return fullImageResults
      }

      val mlKitFallbackResults = scanFallbackVariants(scanner, bitmap)
      if (mlKitFallbackResults.isNotEmpty()) {
        return mlKitFallbackResults
      }

      scanZxingFallbackVariants(bitmap)
    } finally {
      bitmap.recycle()
    }
  }

  private fun scanFallbackVariants(scanner: BarcodeScanner, bitmap: Bitmap): List<Map<String, Any?>> {
    for (variant in FALLBACK_VARIANTS) {
      if (scanBudgetExceeded("ML Kit fallback")) {
        return emptyList()
      }
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

  private fun scanZxingFallbackVariants(bitmap: Bitmap): List<Map<String, Any?>> {
    val reader = createZxingReader() ?: return emptyList()
    if (scanBudgetExceeded("ZXing-C++ full-image fallback")) {
      return emptyList()
    }
    val fullImageResults = readZxing(reader, bitmap, ScanTransform(), "full-image")
    if (fullImageResults.isNotEmpty()) {
      return fullImageResults
    }

    if (scanBudgetExceeded("ZXing-C++ crop ranking")) {
      return emptyList()
    }
    val fallbackVariants = zxingFallbackVariants(bitmap)
    Log.d(TAG, "ZXing-C++ fallback trying ${fallbackVariants.size} ranked crops")

    for (variant in fallbackVariants) {
      if (scanBudgetExceeded("ZXing-C++ crop fallback")) {
        return emptyList()
      }
      val cropRect = variant.cropRect(bitmap.width, bitmap.height)
      if (cropRect.width() < MIN_CROP_SIZE_PX || cropRect.height() < MIN_CROP_SIZE_PX) {
        continue
      }

      val crop = Bitmap.createBitmap(bitmap, cropRect.left, cropRect.top, cropRect.width(), cropRect.height())
      val scale = boundedScale(crop, variant.scale)
      val image = if (scale > 1) {
        Bitmap.createScaledBitmap(crop, crop.width * scale, crop.height * scale, true)
      } else {
        crop
      }

      try {
        val transform = ScanTransform(cropRect.left, cropRect.top, scale.toFloat())
        val results = readZxing(reader, image, transform, variant.name, tryContrast = true)
        if (results.isNotEmpty()) {
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

  private fun createZxingReader(): ZxingCppBarcodeReader? {
    return try {
      ZxingCppBarcodeReader(
        ZxingCppBarcodeReader.Options(
          formats = ZXING_LINEAR_FORMATS,
          tryHarder = true,
          tryRotate = true,
          tryInvert = true,
          tryDenoise = true,
          maxNumberOfSymbols = MAX_ZXING_SYMBOLS,
        ),
      )
    } catch (error: UnsatisfiedLinkError) {
      Log.w(TAG, "ZXing-C++ native library unavailable", error)
      null
    }
  }

  private fun readZxing(
    reader: ZxingCppBarcodeReader,
    bitmap: Bitmap,
    transform: ScanTransform,
    variantName: String,
    tryContrast: Boolean = false,
  ): List<Map<String, Any?>> {
    val mapped = readZxingOnce(reader, bitmap, transform, variantName)
    if (mapped.isNotEmpty() || !tryContrast || scanBudgetExceeded("ZXing-C++ contrast fallback")) {
      return mapped
    }

    val contrastBitmap = runCatching { createContrastBitmap(bitmap) }.getOrElse { error ->
      Log.w(TAG, "ZXing-C++ contrast preprocessing failed for $variantName", error)
      return emptyList()
    }

    return try {
      readZxingOnce(reader, contrastBitmap, transform, "$variantName contrast")
    } finally {
      contrastBitmap.recycle()
    }
  }

  private fun readZxingOnce(
    reader: ZxingCppBarcodeReader,
    bitmap: Bitmap,
    transform: ScanTransform,
    variantName: String,
  ): List<Map<String, Any?>> {
    val cropRect = Rect(0, 0, bitmap.width, bitmap.height)
    val results = try {
      reader.read(bitmap, cropRect, rotationDegrees)
    } catch (error: RuntimeException) {
      Log.w(TAG, "ZXing-C++ scan failed for $variantName", error)
      return emptyList()
    }

    val mapped = results
      .asSequence()
      .filter { result -> result.error == null && !result.text.isNullOrBlank() }
      .map { result -> zxingResultToMap(result, transform) }
      .toList()

    if (mapped.isNotEmpty()) {
      Log.d(TAG, "Barcode decoded from ZXing-C++ crop $variantName")
    }

    return mapped
  }

  private fun zxingFallbackVariants(bitmap: Bitmap): List<CropVariant> {
    val rankedCandidates = ZXING_CANDIDATE_VARIANTS
      .asSequence()
      .mapNotNull { variant ->
        val cropRect = variant.cropRect(bitmap.width, bitmap.height)
        if (cropRect.width() < MIN_CROP_SIZE_PX || cropRect.height() < MIN_CROP_SIZE_PX) {
          null
        } else {
          variant to barcodeTextureScore(bitmap, cropRect)
        }
      }
      .filter { (_, score) -> score > 0f }
      .sortedByDescending { (_, score) -> score }
      .take(MAX_DYNAMIC_ZXING_CROPS)
      .map { (variant, _) -> variant }
      .toList()

    return (ZXING_SEED_VARIANTS + rankedCandidates).distinctBy {
      "${it.left}:${it.top}:${it.width}:${it.height}:${it.scale}"
    }
  }

  private fun barcodeTextureScore(bitmap: Bitmap, rect: Rect): Float {
    val stepX = max(1, rect.width() / TEXTURE_SAMPLE_COLUMNS)
    val stepY = max(1, rect.height() / TEXTURE_SAMPLE_ROWS)
    var xEdges = 0
    var xComparisons = 0
    var yEdges = 0
    var yComparisons = 0

    var y = rect.top
    while (y < rect.bottom) {
      var previous = gray(bitmap.getPixel(rect.left, y))
      var x = rect.left + stepX
      while (x < rect.right) {
        val current = gray(bitmap.getPixel(x, y))
        if (abs(current - previous) >= TEXTURE_EDGE_THRESHOLD) {
          xEdges += 1
        }
        xComparisons += 1
        previous = current
        x += stepX
      }
      y += stepY
    }

    var x = rect.left
    while (x < rect.right) {
      var previous = gray(bitmap.getPixel(x, rect.top))
      y = rect.top + stepY
      while (y < rect.bottom) {
        val current = gray(bitmap.getPixel(x, y))
        if (abs(current - previous) >= TEXTURE_EDGE_THRESHOLD) {
          yEdges += 1
        }
        yComparisons += 1
        previous = current
        y += stepY
      }
      x += stepX
    }

    val horizontalBarScore = xEdges.toFloat() / max(1, xComparisons).toFloat()
    val verticalBarScore = yEdges.toFloat() / max(1, yComparisons).toFloat()
    return max(horizontalBarScore, verticalBarScore)
  }

  private fun gray(color: Int): Int {
    return (
      (Color.red(color) * 0.299f) +
        (Color.green(color) * 0.587f) +
        (Color.blue(color) * 0.114f)
      ).roundToInt()
  }

  private fun createContrastBitmap(bitmap: Bitmap): Bitmap {
    val width = bitmap.width
    val height = bitmap.height
    val pixels = IntArray(width * height)
    bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
    for (index in pixels.indices) {
      val color = pixels[index]
      val gray = (
        (Color.red(color) * 0.299f) +
          (Color.green(color) * 0.587f) +
          (Color.blue(color) * 0.114f)
        ).roundToInt()
      val adjusted = (((gray - 128) * ZXING_CONTRAST) + 128).roundToInt().coerceIn(0, 255)
      pixels[index] = Color.rgb(adjusted, adjusted, adjusted)
    }
    return Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).apply {
      setPixels(pixels, 0, width, 0, 0, width, height)
    }
  }

  private fun scanBudgetExceeded(stage: String): Boolean {
    if (scanStartedAtMs <= 0) {
      return false
    }
    val elapsedMs = SystemClock.elapsedRealtime() - scanStartedAtMs
    val exceeded = elapsedMs >= MAX_SCAN_ELAPSED_MS
    if (exceeded && !scanBudgetLogged) {
      scanBudgetLogged = true
      Log.d(TAG, "Barcode scan miss budget reached after ${elapsedMs}ms; skipping $stage")
    }
    return exceeded
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
      put("scanner", "mlkit")
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

  private fun zxingResultToMap(result: ZxingCppBarcodeReader.Result, transform: ScanTransform): Map<String, Any?> {
    val value = result.text
    return buildMap {
      put("rawValue", value)
      put("displayValue", value)
      put("format", zxingFormatName(result.format))
      put("scanner", "zxing-cpp")
      put("valueType", "TEXT")
      put("orientation", result.orientation)
      put("lineCount", result.lineCount)
      put("bounds", zxingBounds(result.position, transform))
      put(
        "cornerPoints",
        zxingPoints(result.position).map { point ->
          mapOf(
            "x" to transform.x(point.x),
            "y" to transform.y(point.y),
          )
        },
      )
    }
  }

  private fun zxingBounds(position: ZxingCppBarcodeReader.Position, transform: ScanTransform): Map<String, Int> {
    val points = zxingPoints(position)
    val left = points.minOf { point -> transform.x(point.x) }
    val top = points.minOf { point -> transform.y(point.y) }
    val right = points.maxOf { point -> transform.x(point.x) }
    val bottom = points.maxOf { point -> transform.y(point.y) }
    return mapOf(
      "x" to left,
      "y" to top,
      "width" to max(1, right - left),
      "height" to max(1, bottom - top),
    )
  }

  private fun zxingPoints(position: ZxingCppBarcodeReader.Position): List<Point> {
    return listOf(position.topLeft, position.topRight, position.bottomRight, position.bottomLeft)
  }

  private fun zxingFormatName(format: ZxingCppBarcodeReader.Format): String {
    return when (format) {
      ZxingCppBarcodeReader.Format.CODE_128 -> "CODE_128"
      ZxingCppBarcodeReader.Format.CODE_39 -> "CODE_39"
      ZxingCppBarcodeReader.Format.CODE_93 -> "CODE_93"
      ZxingCppBarcodeReader.Format.CODABAR -> "CODABAR"
      ZxingCppBarcodeReader.Format.EAN_13 -> "EAN_13"
      ZxingCppBarcodeReader.Format.EAN_8 -> "EAN_8"
      ZxingCppBarcodeReader.Format.ITF -> "ITF"
      ZxingCppBarcodeReader.Format.UPC_A -> "UPC_A"
      ZxingCppBarcodeReader.Format.UPC_E -> "UPC_E"
      else -> format.name
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

  private fun boundedScale(bitmap: Bitmap, requestedScale: Int): Int {
    val pixels = bitmap.width.toLong() * bitmap.height.toLong()
    if (pixels <= 0) {
      return 1
    }
    val maxScale = sqrt(MAX_ZXING_SCALED_PIXELS.toDouble() / pixels.toDouble())
      .toInt()
      .coerceAtLeast(1)
    return min(requestedScale, maxScale)
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
    const val MAX_ZXING_SCALED_PIXELS = 12_000_000
    const val MAX_ZXING_SYMBOLS = 4
    const val MAX_SCAN_ELAPSED_MS = 2_500L
    const val MAX_DYNAMIC_ZXING_CROPS = 16
    const val TEXTURE_SAMPLE_COLUMNS = 32
    const val TEXTURE_SAMPLE_ROWS = 18
    const val TEXTURE_EDGE_THRESHOLD = 28
    const val ZXING_CONTRAST = 1.8f

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

    val ZXING_LINEAR_FORMATS = setOf(
      ZxingCppBarcodeReader.Format.CODABAR,
      ZxingCppBarcodeReader.Format.CODE_39,
      ZxingCppBarcodeReader.Format.CODE_93,
      ZxingCppBarcodeReader.Format.CODE_128,
      ZxingCppBarcodeReader.Format.EAN_13,
      ZxingCppBarcodeReader.Format.EAN_8,
      ZxingCppBarcodeReader.Format.ITF,
      ZxingCppBarcodeReader.Format.UPC_A,
      ZxingCppBarcodeReader.Format.UPC_E,
    )

    val ZXING_SEED_VARIANTS = listOf(
      CropVariant("tight-center-label-strip-10x", 0.36f, 0.38f, 0.12f, 0.05f, 10),
      CropVariant("lower-left-label-strip-8x", 0.25f, 0.56f, 0.24f, 0.08f, 8),
      CropVariant("lower-center-product-label-8x", 0.22f, 0.54f, 0.32f, 0.11f, 8),
    )

    val ZXING_CANDIDATE_VARIANTS = mutableListOf<CropVariant>().apply {
      val tightHorizontalLefts = listOf(0.24f, 0.30f, 0.36f, 0.42f, 0.48f)
      val tightHorizontalTops = listOf(0.34f, 0.38f, 0.42f, 0.46f, 0.50f, 0.54f, 0.58f)
      for (top in tightHorizontalTops) {
        for (left in tightHorizontalLefts) {
          add(CropVariant("tight-horizontal-strip-${left}-${top}-10x", left, top, 0.14f, 0.06f, 10))
        }
      }

      val horizontalLefts = listOf(0.02f, 0.20f, 0.38f, 0.56f, 0.70f)
      val horizontalTops = listOf(0.18f, 0.32f, 0.46f, 0.56f, 0.68f, 0.82f)
      for (top in horizontalTops) {
        for (left in horizontalLefts) {
          add(CropVariant("horizontal-strip-${left}-${top}-8x", left, top, 0.28f, 0.10f, 8))
        }
      }

      val verticalLefts = listOf(0.08f, 0.24f, 0.40f, 0.56f, 0.72f, 0.86f)
      val verticalTops = listOf(0.08f, 0.32f, 0.56f)
      for (top in verticalTops) {
        for (left in verticalLefts) {
          add(CropVariant("vertical-strip-${left}-${top}-7x", left, top, 0.12f, 0.32f, 7))
        }
      }
    }

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
