package com.mentra.crust.utils

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.media.Image
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * Gyroscope-based video stabilizer.
 * Uses IMU sidecar data (from ImuRecorder) to apply motion-compensated
 * frame warping, correcting rotation jitter in videos.
 *
 * Algorithm: integrate gyro → cumulative rotation per axis →
 * bidirectional EMA smooth → correction = smooth - actual →
 * per-frame affine transform (rotation + translation).
 */
object VideoStabilizer {
  private const val TAG = "VideoStabilizer"

  // EMA smoothing factor: higher = smoother path = more aggressive stabilization.
  // 0.98 aggressively removes head/hand jitter while preserving slow intentional pans.
  private const val SMOOTH_FACTOR = 0.98

  // Number of bidirectional EMA passes for stronger smoothing.
  private const val SMOOTH_PASSES = 3

  // Crop margin: fraction of frame to crop on each edge to hide black borders
  // from stabilization shifts. 0.08 = 8% crop per side (16% total zoom).
  private const val CROP_MARGIN = 0.08

  private const val CODEC_TIMEOUT_US = 10_000L

  // --- Color pipeline tuning parameters ---

  // Tone curve anchor Y values (X fixed at 0.0, 0.25, 0.50, 0.75, 1.0)
  // Slight shadow lift (0.02) for low-light camera, full whites, punchy midtone contrast.
  private val TONE_CURVE_Y = doubleArrayOf(0.02, 0.20, 0.52, 0.82, 1.0)

  // Vibrance: selective saturation boost for desaturated colors (0.0 = off, 1.0 = max)
  private const val VIBRANCE_AMOUNT = 0.45f

  // Color correction matrix (3x4: RGB coefficients + bias per channel)
  private const val CM_RR = 1.06f; private const val CM_RG = 0.02f; private const val CM_RB = -0.01f; private const val CM_R_BIAS = 5f / 255f
  private const val CM_GR = 0.01f; private const val CM_GG = 1.04f; private const val CM_GB = -0.01f; private const val CM_G_BIAS = 3f / 255f
  private const val CM_BR = -0.02f; private const val CM_BG = 0.01f; private const val CM_BB = 1.02f; private const val CM_B_BIAS = 0f

  // --- Precomputed LUTs (depend on tuning parameters above) ---

  // sRGB linearize LUT: sRGB byte (0-255) -> linear float (0.0-1.0)
  private val LINEARIZE_LUT = FloatArray(256) { i ->
    val v = i / 255.0
    if (v <= 0.04045) (v / 12.92).toFloat()
    else Math.pow((v + 0.055) / 1.055, 2.4).toFloat()
  }

  // sRGB delinearize LUT: linear Q12 (0-4095) -> sRGB byte (0-255)
  private const val DELIN_LUT_SIZE = 4096
  private val DELINEARIZE_LUT = IntArray(DELIN_LUT_SIZE) { i ->
    val v = i.toDouble() / (DELIN_LUT_SIZE - 1)
    val s = if (v <= 0.0031308) v * 12.92
            else 1.055 * Math.pow(v, 1.0 / 2.4) - 0.055
    (s * 255 + 0.5).toInt().coerceIn(0, 255)
  }

  // Tone curve LUT in linear space: linear Q12 (0-4095) -> linear float (0.0-1.0)
  private val TONE_LUT_LINEAR = FloatArray(DELIN_LUT_SIZE) { i ->
    val x = i.toDouble() / (DELIN_LUT_SIZE - 1)
    val ax = doubleArrayOf(0.0, 0.25, 0.50, 0.75, 1.0)
    val ay = TONE_CURVE_Y
    val y = when {
      x <= ax[1] -> ay[0] + (ay[1] - ay[0]) * (x - ax[0]) / (ax[1] - ax[0])
      x <= ax[2] -> ay[1] + (ay[2] - ay[1]) * (x - ax[1]) / (ax[2] - ax[1])
      x <= ax[3] -> ay[2] + (ay[3] - ay[2]) * (x - ax[2]) / (ax[3] - ax[2])
      else       -> ay[3] + (ay[4] - ay[3]) * (x - ax[3]) / (ax[4] - ax[3])
    }
    y.coerceIn(0.0, 1.0).toFloat()
  }

  private fun toneCurve(linear: Float): Float {
    val idx = (linear * (DELIN_LUT_SIZE - 1) + 0.5f).toInt().coerceIn(0, DELIN_LUT_SIZE - 1)
    return TONE_LUT_LINEAR[idx]
  }

  private fun toSrgbByte(linear: Float): Int {
    val idx = (linear * (DELIN_LUT_SIZE - 1) + 0.5f).toInt().coerceIn(0, DELIN_LUT_SIZE - 1)
    return DELINEARIZE_LUT[idx]
  }

  /**
   * Stabilize a video using gyroscope data from an IMU sidecar file.
   *
   * @param inputPath  Path to the input MP4 video
   * @param imuPath    Path to the IMU sidecar JSON file
   * @param outputPath Path to write the stabilized MP4
   * @return Processing time in milliseconds, or -1 on failure
   */
  @JvmStatic
  fun stabilize(inputPath: String, imuPath: String, outputPath: String): Long {
    val startTime = System.currentTimeMillis()

    try {
      // Parse IMU data
      val imuSamples = parseImuData(imuPath)
      if (imuSamples.isEmpty()) {
        Log.w(TAG, "No IMU data available")
        return -1
      }
      Log.d(TAG, "Loaded ${imuSamples.size} IMU samples")

      val n = imuSamples.size

      // Integrate gyro to get cumulative rotation (3 axes)
      val cumRoll = DoubleArray(n)   // gx
      val cumPitch = DoubleArray(n)  // gy
      val cumYaw = DoubleArray(n)    // gz

      for (i in 1 until n) {
        var dt = (imuSamples[i][0] - imuSamples[i - 1][0]) / 1000.0
        if (dt <= 0 || dt > 0.1) dt = 0.01

        cumRoll[i] = cumRoll[i - 1] + imuSamples[i][4] * dt   // gx
        cumPitch[i] = cumPitch[i - 1] + imuSamples[i][5] * dt  // gy
        cumYaw[i] = cumYaw[i - 1] + imuSamples[i][6] * dt      // gz
      }

      // Smooth with multi-pass bidirectional EMA for aggressive stabilization
      val smoothRoll = smoothEmaMultiPass(cumRoll)
      val smoothPitch = smoothEmaMultiPass(cumPitch)
      val smoothYaw = smoothEmaMultiPass(cumYaw)

      // Correction = smooth - actual
      val corrRoll = DoubleArray(n) { smoothRoll[it] - cumRoll[it] }
      val corrPitch = DoubleArray(n) { smoothPitch[it] - cumPitch[it] }
      val corrYaw = DoubleArray(n) { smoothYaw[it] - cumYaw[it] }

      val imuDurationMs = imuSamples.last()[0]

      // Setup video extractor
      val videoExtractor = MediaExtractor().apply { setDataSource(inputPath) }
      val videoTrackIdx = findTrack(videoExtractor, "video/")
      if (videoTrackIdx < 0) {
        Log.e(TAG, "No video track found")
        videoExtractor.release()
        return -1
      }

      videoExtractor.selectTrack(videoTrackIdx)
      val videoFormat = videoExtractor.getTrackFormat(videoTrackIdx)
      val width = videoFormat.getInteger(MediaFormat.KEY_WIDTH)
      val height = videoFormat.getInteger(MediaFormat.KEY_HEIGHT)
      val bitRate = if (videoFormat.containsKey(MediaFormat.KEY_BIT_RATE))
        videoFormat.getInteger(MediaFormat.KEY_BIT_RATE)
      else (width * height * 4.0).toInt()
      val frameRate = if (videoFormat.containsKey(MediaFormat.KEY_FRAME_RATE))
        videoFormat.getInteger(MediaFormat.KEY_FRAME_RATE)
      else 30
      val durationUs = if (videoFormat.containsKey(MediaFormat.KEY_DURATION))
        videoFormat.getLong(MediaFormat.KEY_DURATION)
      else 0L

      Log.d(TAG, "Video ${width}x${height} fps=$frameRate duration=${durationUs / 1_000_000.0}s")

      // Setup audio extractor
      val audioExtractor = MediaExtractor().apply { setDataSource(inputPath) }
      val audioTrackIdx = findTrack(audioExtractor, "audio/")

      // Remove output if exists
      File(outputPath).let { if (it.exists()) it.delete() }

      // Setup muxer
      val muxer = MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)

      // Setup decoder
      val videoMime = videoFormat.getString(MediaFormat.KEY_MIME)!!
      val decoder = MediaCodec.createDecoderByType(videoMime).apply {
        videoFormat.setInteger(
          MediaFormat.KEY_COLOR_FORMAT,
          MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible
        )
        configure(videoFormat, null, null, 0)
        start()
      }

      // Setup encoder
      val encFormat = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
        setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
        setInteger(MediaFormat.KEY_BIT_RATE, bitRate)
        setInteger(MediaFormat.KEY_FRAME_RATE, frameRate)
        setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
      }
      val encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC).apply {
        configure(encFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        start()
      }

      var muxVideoTrack = -1
      var muxAudioTrack = -1
      var muxerStarted = false
      var decoderDone = false
      var encoderDone = false
      var inputDone = false
      var frameCount = 0

      val decInfo = MediaCodec.BufferInfo()
      val encInfo = MediaCodec.BufferInfo()
      val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)

      while (!encoderDone) {
        // Feed decoder
        if (!inputDone) {
          val inIdx = decoder.dequeueInputBuffer(CODEC_TIMEOUT_US)
          if (inIdx >= 0) {
            val inBuf = decoder.getInputBuffer(inIdx)!!
            val sampleSize = videoExtractor.readSampleData(inBuf, 0)
            if (sampleSize < 0) {
              decoder.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              val pts = videoExtractor.sampleTime
              decoder.queueInputBuffer(inIdx, 0, sampleSize, pts, 0)
              videoExtractor.advance()
            }
          }
        }

        // Drain decoder → transform → feed encoder
        if (!decoderDone) {
          val outIdx = decoder.dequeueOutputBuffer(decInfo, CODEC_TIMEOUT_US)
          if (outIdx >= 0) {
            if (decInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
              decoderDone = true
              decoder.releaseOutputBuffer(outIdx, false)
              // Signal encoder EOS
              val encInIdx = encoder.dequeueInputBuffer(CODEC_TIMEOUT_US)
              if (encInIdx >= 0) {
                encoder.queueInputBuffer(encInIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              }
            } else {
              val image = decoder.getOutputImage(outIdx)
              if (image != null) {
                val srcBitmap = yuvImageToBitmap(image, width, height)
                image.close()
                decoder.releaseOutputBuffer(outIdx, false)

                // Find IMU correction for this frame
                val frameTimeMs = decInfo.presentationTimeUs / 1000.0
                val ratio = if (imuDurationMs > 0) frameTimeMs / imuDurationMs else 0.0
                val imuIdx = max(0, min((ratio * (n - 1)).toInt(), n - 1))

                val roll = corrRoll[imuIdx]
                val pitch = corrPitch[imuIdx]
                val yaw = corrYaw[imuIdx]

                // Always apply crop+scale for consistent framing, plus stabilization correction
                val dst = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                val canvas = Canvas(dst)
                val cx = width / 2f
                val cy = height / 2f

                // Scale factor to zoom in and hide black edges from stabilization
                val scale = 1.0f / (1.0f - 2.0f * CROP_MARGIN.toFloat())

                // Clamp corrections to the crop margin so we never show black edges
                val maxShiftX = CROP_MARGIN * width
                val maxShiftY = CROP_MARGIN * height
                val maxRollRad = CROP_MARGIN * 0.5 // conservative limit for rotation

                val clampedRoll = roll.coerceIn(-maxRollRad, maxRollRad)
                val clampedPitchShift = (-pitch * cx).toFloat().coerceIn(-maxShiftX.toFloat(), maxShiftX.toFloat())
                val clampedYawShift = (yaw * cy).toFloat().coerceIn(-maxShiftY.toFloat(), maxShiftY.toFloat())

                val matrix = Matrix().apply {
                  postTranslate(-cx, -cy)
                  // Crop zoom
                  postScale(scale, scale)
                  // Roll: Z-axis rotation
                  postRotate(Math.toDegrees(-clampedRoll).toFloat())
                  // Pitch: horizontal shift
                  postTranslate(clampedPitchShift, 0f)
                  // Yaw: vertical shift
                  postTranslate(0f, clampedYawShift)
                  postTranslate(cx, cy)
                }

                canvas.drawBitmap(srcBitmap, matrix, paint)
                srcBitmap.recycle()
                val outBitmap = dst

                feedBitmapToEncoder(encoder, outBitmap, decInfo.presentationTimeUs, width, height)
                outBitmap.recycle()
                frameCount++
              } else {
                decoder.releaseOutputBuffer(outIdx, false)
              }
            }
          }
        }

        // Drain encoder output
        val encOutIdx = encoder.dequeueOutputBuffer(encInfo, CODEC_TIMEOUT_US)
        when {
          encOutIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            if (!muxerStarted) {
              muxVideoTrack = muxer.addTrack(encoder.outputFormat)
              if (audioTrackIdx >= 0) {
                audioExtractor.selectTrack(audioTrackIdx)
                muxAudioTrack = muxer.addTrack(audioExtractor.getTrackFormat(audioTrackIdx))
              }
              muxer.start()
              muxerStarted = true
            }
          }
          encOutIdx >= 0 -> {
            val encBuf = encoder.getOutputBuffer(encOutIdx)!!
            if (encInfo.size > 0 && muxerStarted) {
              encBuf.position(encInfo.offset)
              encBuf.limit(encInfo.offset + encInfo.size)
              muxer.writeSampleData(muxVideoTrack, encBuf, encInfo)
            }
            encoder.releaseOutputBuffer(encOutIdx, false)
            if (encInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
              encoderDone = true
            }
          }
        }
      }

      // Copy audio track
      if (muxerStarted && muxAudioTrack >= 0) {
        val audioBuf = ByteBuffer.allocate(1024 * 1024)
        val audioInfo = MediaCodec.BufferInfo()
        while (true) {
          val size = audioExtractor.readSampleData(audioBuf, 0)
          if (size < 0) break
          audioInfo.offset = 0
          audioInfo.size = size
          audioInfo.presentationTimeUs = audioExtractor.sampleTime
          audioInfo.flags = audioExtractor.sampleFlags
          muxer.writeSampleData(muxAudioTrack, audioBuf, audioInfo)
          audioExtractor.advance()
        }
      }

      // Cleanup
      decoder.stop(); decoder.release()
      encoder.stop(); encoder.release()
      videoExtractor.release()
      audioExtractor.release()
      if (muxerStarted) muxer.stop()
      muxer.release()

      val elapsed = System.currentTimeMillis() - startTime
      Log.d(TAG, "Stabilization complete: $frameCount frames in ${elapsed}ms")
      return elapsed

    } catch (e: Exception) {
      Log.e(TAG, "Video stabilization failed", e)
      try { File(outputPath).delete() } catch (_: Exception) {}
      return -1
    }
  }

  // -- Private helpers --

  /** Feed a Bitmap to the encoder by converting ARGB → YUV420. */
  private fun feedBitmapToEncoder(
    encoder: MediaCodec, bitmap: Bitmap, presentationTimeUs: Long, width: Int, height: Int
  ) {
    var inIdx = -1
    while (inIdx < 0) {
      inIdx = encoder.dequeueInputBuffer(CODEC_TIMEOUT_US)
      if (inIdx < 0) drainEncoderSilently(encoder)
    }

    encoder.getInputImage(inIdx)?.let { image ->
      bitmapToYuv420(bitmap, image)
      image.close()
    }

    encoder.queueInputBuffer(inIdx, 0, width * height * 3 / 2, presentationTimeUs, 0)
  }

  /** Convert ARGB_8888 Bitmap to YUV420 Image planes. */
  private fun bitmapToYuv420(bitmap: Bitmap, image: Image) {
    val w = bitmap.width
    val h = bitmap.height
    val pixels = IntArray(w * h)
    bitmap.getPixels(pixels, 0, w, 0, 0, w, h)

    val yPlane = image.planes[0]
    val uPlane = image.planes[1]
    val vPlane = image.planes[2]
    val yBuf = yPlane.buffer
    val uBuf = uPlane.buffer
    val vBuf = vPlane.buffer
    val yRowStride = yPlane.rowStride
    val uvRowStride = uPlane.rowStride
    val uvPixelStride = uPlane.pixelStride

    for (y in 0 until h) {
      for (x in 0 until w) {
        val argb = pixels[y * w + x]

        // 1. Linearize sRGB → linear
        var lr = LINEARIZE_LUT[(argb shr 16) and 0xFF]
        var lg = LINEARIZE_LUT[(argb shr 8) and 0xFF]
        var lb = LINEARIZE_LUT[argb and 0xFF]

        // 2. Tone curve in linear space
        lr = toneCurve(lr)
        lg = toneCurve(lg)
        lb = toneCurve(lb)

        // 3. Vibrance — luminance-based, stays in linear space (no HSV round-trip)
        val lum = 0.2126f * lr + 0.7152f * lg + 0.0722f * lb
        val maxC = maxOf(lr, lg, lb)
        val minC = minOf(lr, lg, lb)
        val sat = if (maxC > 0.0001f) (maxC - minC) / maxC else 0f
        val boost = VIBRANCE_AMOUNT * (1.0f - sat)
        lr += (lr - lum) * boost
        lg += (lg - lum) * boost
        lb += (lb - lum) * boost

        // 4. Color correction matrix in linear space
        val clr = (CM_RR * lr + CM_RG * lg + CM_RB * lb + CM_R_BIAS).coerceIn(0f, 1f)
        val clg = (CM_GR * lr + CM_GG * lg + CM_GB * lb + CM_G_BIAS).coerceIn(0f, 1f)
        val clb = (CM_BR * lr + CM_BG * lg + CM_BB * lb + CM_B_BIAS).coerceIn(0f, 1f)

        // 5. Encode linear → sRGB
        val cr = toSrgbByte(clr)
        val cg = toSrgbByte(clg)
        val cb = toSrgbByte(clb)

        // BT.601 RGB → YUV
        val yVal = ((66 * cr + 129 * cg + 25 * cb + 128) shr 8) + 16
        yBuf.put(y * yRowStride + x, yVal.coerceIn(0, 255).toByte())

        if (y % 2 == 0 && x % 2 == 0) {
          val uVal = ((-38 * cr - 74 * cg + 112 * cb + 128) shr 8) + 128
          val vVal = ((112 * cr - 94 * cg - 18 * cb + 128) shr 8) + 128
          val uvIdx = (y / 2) * uvRowStride + (x / 2) * uvPixelStride
          uBuf.put(uvIdx, uVal.coerceIn(0, 255).toByte())
          vBuf.put(uvIdx, vVal.coerceIn(0, 255).toByte())
        }
      }
    }
  }

  /** Drain encoder output without writing (used when waiting for input buffer). */
  private fun drainEncoderSilently(encoder: MediaCodec) {
    val info = MediaCodec.BufferInfo()
    val idx = encoder.dequeueOutputBuffer(info, CODEC_TIMEOUT_US)
    if (idx >= 0) encoder.releaseOutputBuffer(idx, false)
  }

  /** Convert a decoded YUV420 Image to ARGB_8888 Bitmap. */
  private fun yuvImageToBitmap(image: Image, width: Int, height: Int): Bitmap {
    val yPlane = image.planes[0]
    val uPlane = image.planes[1]
    val vPlane = image.planes[2]
    val yBuf = yPlane.buffer
    val uBuf = uPlane.buffer
    val vBuf = vPlane.buffer
    val yRowStride = yPlane.rowStride
    val uvRowStride = uPlane.rowStride
    val uvPixelStride = uPlane.pixelStride

    val pixels = IntArray(width * height)

    for (y in 0 until height) {
      for (x in 0 until width) {
        val yy = (yBuf.get(y * yRowStride + x).toInt() and 0xFF) - 16
        val uvIdx = (y / 2) * uvRowStride + (x / 2) * uvPixelStride
        val uu = (uBuf.get(uvIdx).toInt() and 0xFF) - 128
        val vv = (vBuf.get(uvIdx).toInt() and 0xFF) - 128

        // BT.601 YUV → RGB
        val r = ((298 * yy + 409 * vv + 128) shr 8).coerceIn(0, 255)
        val g = ((298 * yy - 100 * uu - 208 * vv + 128) shr 8).coerceIn(0, 255)
        val b = ((298 * yy + 516 * uu + 128) shr 8).coerceIn(0, 255)

        pixels[y * width + x] = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
      }
    }

    return Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).apply {
      setPixels(pixels, 0, width, 0, 0, width, height)
    }
  }

  /** Find a track in a MediaExtractor by MIME type prefix. */
  private fun findTrack(extractor: MediaExtractor, mimePrefix: String): Int {
    for (i in 0 until extractor.trackCount) {
      val mime = extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME)
      if (mime?.startsWith(mimePrefix) == true) return i
    }
    return -1
  }

  /** Parse IMU sidecar JSON into list of [timeMs, ax, ay, az, gx, gy, gz]. */
  private fun parseImuData(path: String): List<DoubleArray> {
    return try {
      val json = JSONObject(File(path).readText())
      val samples = json.getJSONArray("samples")
      (0 until samples.length()).mapNotNull { i ->
        val s = samples.getJSONArray(i)
        if (s.length() < 7) return@mapNotNull null
        doubleArrayOf(
          s.getDouble(0), // timeMs
          s.getDouble(1), // ax
          s.getDouble(2), // ay
          s.getDouble(3), // az
          s.getDouble(4), // gx
          s.getDouble(5), // gy
          s.getDouble(6), // gz
        )
      }
    } catch (e: Exception) {
      Log.e(TAG, "Failed to parse IMU data", e)
      emptyList()
    }
  }

  /** Multi-pass bidirectional EMA smoothing for aggressive stabilization. */
  private fun smoothEmaMultiPass(data: DoubleArray): DoubleArray {
    if (data.isEmpty()) return data
    var result = data.copyOf()
    repeat(SMOOTH_PASSES) {
      val smooth = DoubleArray(result.size)
      smooth[0] = result[0]
      // Forward pass
      for (i in 1 until result.size) {
        smooth[i] = SMOOTH_FACTOR * smooth[i - 1] + (1 - SMOOTH_FACTOR) * result[i]
      }
      // Backward pass
      for (i in result.size - 2 downTo 0) {
        smooth[i] = SMOOTH_FACTOR * smooth[i + 1] + (1 - SMOOTH_FACTOR) * smooth[i]
      }
      result = smooth
    }
    return result
  }
}
