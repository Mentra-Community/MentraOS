package com.mentra.crust.utils;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/**
 * Image processor for gallery photos synced from Mentra glasses.
 * Applies lens distortion correction and color correction to improve
 * photo quality before saving to the user's camera roll.
 */
public class ImageProcessor {
  private static final String TAG = "ImageProcessor";

  // Brown-Conrady distortion coefficients for the Mentra Live camera
  // (Sony sensor, 118-degree FOV fisheye lens)
  // Calibrated from chessboard photos at 3264x2448 native sensor resolution.
  // Brown-Conrady lens distortion coefficients
  private static final double K1 = -0.10;   // Radial distortion (barrel)
  private static final double K2 = 0.02;    // Radial distortion (higher order)
  private static final double P1 = 0.0;     // Tangential distortion
  private static final double P2 = 0.0;     // Tangential distortion

  // --- Color pipeline tuning parameters ---

  // Tone curve anchor points (X values fixed at 0.0, 0.25, 0.50, 0.75, 1.0)
  // Y values control the S-curve shape in linear space.
  // Slight shadow lift (0.02) for low-light camera, full whites, punchy midtone contrast.
  private static final double[] TONE_CURVE_Y = {0.02, 0.20, 0.52, 0.82, 1.0};

  // Vibrance: selective saturation boost for desaturated colors (0.0 = off, 1.0 = max)
  private static final float VIBRANCE_AMOUNT = 0.45f;

  // Color correction matrix (3x4: RGB coefficients + bias per channel)
  // Adjusts warmth/white balance to compensate for the glasses camera's color cast.
  private static final float CM_RR = 1.06f, CM_RG = 0.02f, CM_RB = -0.01f, CM_R_BIAS = 5.0f / 255.0f;
  private static final float CM_GR = 0.01f, CM_GG = 1.04f, CM_GB = -0.01f, CM_G_BIAS = 3.0f / 255.0f;
  private static final float CM_BR = -0.02f, CM_BG = 0.01f, CM_BB = 1.02f, CM_B_BIAS = 0.0f;

  // sRGB gamma decode LUT: sRGB byte (0-255) -> linear float (0.0-1.0)
  // iOS CIFilters operate in linear space internally; this matches that behavior.
  private static final float[] LINEARIZE_LUT = buildLinearizeLut();

  // sRGB gamma encode LUT: linear value (0-4095, Q12 fixed-point) -> sRGB byte (0-255)
  private static final int[] DELINEARIZE_LUT = buildDelinearizeLut();
  private static final int DELIN_LUT_SIZE = 4096;

  private static float[] buildLinearizeLut() {
    float[] lut = new float[256];
    for (int i = 0; i < 256; i++) {
      double v = i / 255.0;
      if (v <= 0.04045) {
        lut[i] = (float) (v / 12.92);
      } else {
        lut[i] = (float) Math.pow((v + 0.055) / 1.055, 2.4);
      }
    }
    return lut;
  }

  private static int[] buildDelinearizeLut() {
    int[] lut = new int[DELIN_LUT_SIZE];
    for (int i = 0; i < DELIN_LUT_SIZE; i++) {
      double v = (double) i / (DELIN_LUT_SIZE - 1);
      double s;
      if (v <= 0.0031308) {
        s = v * 12.92;
      } else {
        s = 1.055 * Math.pow(v, 1.0 / 2.4) - 0.055;
      }
      lut[i] = Math.max(0, Math.min(255, (int) (s * 255 + 0.5)));
    }
    return lut;
  }

  // Tone-curve LUT operating in linear space [0.0-1.0] -> [0.0-1.0]
  // Piecewise-linear matching iOS CIToneCurve anchor points.
  // Input/output are linear-light values, not gamma-encoded.
  private static final float[] TONE_LUT_LINEAR = buildToneLutLinear();

  private static float[] buildToneLutLinear() {
    float[] lut = new float[DELIN_LUT_SIZE];
    double[] ax = {0.0, 0.25, 0.50, 0.75, 1.0};
    double[] ay = TONE_CURVE_Y;
    for (int i = 0; i < DELIN_LUT_SIZE; i++) {
      double x = (double) i / (DELIN_LUT_SIZE - 1);
      double y;
      if (x <= ax[1]) {
        y = ay[0] + (ay[1] - ay[0]) * (x - ax[0]) / (ax[1] - ax[0]);
      } else if (x <= ax[2]) {
        y = ay[1] + (ay[2] - ay[1]) * (x - ax[1]) / (ax[2] - ax[1]);
      } else if (x <= ax[3]) {
        y = ay[2] + (ay[3] - ay[2]) * (x - ax[2]) / (ax[3] - ax[2]);
      } else {
        y = ay[3] + (ay[4] - ay[3]) * (x - ax[3]) / (ax[4] - ax[3]);
      }
      lut[i] = (float) Math.max(0.0, Math.min(1.0, y));
    }
    return lut;
  }

  /** Look up a tone-curve value for a linear float input. */
  private static float toneCurveLookup(float linearVal) {
    int idx = Math.max(0, Math.min(DELIN_LUT_SIZE - 1, (int) (linearVal * (DELIN_LUT_SIZE - 1) + 0.5f)));
    return TONE_LUT_LINEAR[idx];
  }

  /** Convert a linear [0,1] float back to sRGB byte via LUT. */
  private static int toSrgbByte(float linear) {
    int idx = Math.max(0, Math.min(DELIN_LUT_SIZE - 1, (int) (linear * (DELIN_LUT_SIZE - 1) + 0.5f)));
    return DELINEARIZE_LUT[idx];
  }

  // Precomputed LUT for lens correction (lazily initialized).
  // Stored as fixed-point Q8 (multiply by 256) for sub-pixel bilinear interpolation.
  private static int[] sRemapXQ8;
  private static int[] sRemapYQ8;
  private static int sLutWidth;
  private static int sLutHeight;

  /**
   * Process a gallery image with the specified corrections.
   *
   * @param inputPath       Path to the input JPEG file
   * @param outputPath      Path to write the processed JPEG
   * @param lensCorrection  Whether to apply barrel distortion correction
   * @param colorCorrection Whether to apply color/white balance correction
   * @param jpegQuality     JPEG output quality (1-100)
   * @return processing time in milliseconds, or -1 on failure
   */
  public static long process(String inputPath, String outputPath,
                             boolean lensCorrection, boolean colorCorrection,
                             int jpegQuality) {
    long startTime = System.currentTimeMillis();

    try {
      // Decode the input image
      BitmapFactory.Options opts = new BitmapFactory.Options();
      opts.inMutable = !lensCorrection; // Need mutable only for color correction without lens
      Bitmap src = BitmapFactory.decodeFile(inputPath, opts);
      if (src == null) {
        Log.e(TAG, "Failed to decode image: " + inputPath);
        return -1;
      }

      int w = src.getWidth();
      int h = src.getHeight();
      Log.d(TAG, "Processing image: " + w + "x" + h
              + " lens=" + lensCorrection + " color=" + colorCorrection);

      Bitmap result = src;

      // Step 1: Lens distortion correction
      if (lensCorrection) {
        result = applyLensCorrection(src, w, h);
        if (result != src) {
          src.recycle();
        }
      }

      // Step 2: Tone mapping + vibrance + color correction in linear space
      if (colorCorrection) {
        Bitmap colorCorrected = applyColorPipeline(result);
        if (colorCorrected != result) {
          result.recycle();
          result = colorCorrected;
        }
      }

      // Write output JPEG
      File outFile = new File(outputPath);
      try (FileOutputStream fos = new FileOutputStream(outFile)) {
        result.compress(Bitmap.CompressFormat.JPEG, jpegQuality, fos);
      }

      result.recycle();

      long elapsed = System.currentTimeMillis() - startTime;
      Log.d(TAG, "Image processing complete in " + elapsed + "ms -> " + outputPath);
      return elapsed;

    } catch (Exception e) {
      Log.e(TAG, "Image processing failed", e);
      return -1;
    }
  }

  /**
   * Apply Brown-Conrady lens distortion correction using a precomputed LUT
   * with bilinear interpolation for sub-pixel accuracy.
   */
  private static Bitmap applyLensCorrection(Bitmap src, int w, int h) {
    // Build or reuse the remapping LUT
    if (sRemapXQ8 == null || sLutWidth != w || sLutHeight != h) {
      buildRemapLut(w, h);
    }

    // Read source pixels
    int[] srcPixels = new int[w * h];
    src.getPixels(srcPixels, 0, w, 0, 0, w, h);

    // Apply remapping with bilinear interpolation
    int[] dstPixels = new int[w * h];
    int maxX = w - 1;
    int maxY = h - 1;

    for (int i = 0; i < w * h; i++) {
      int sxQ8 = sRemapXQ8[i];
      int syQ8 = sRemapYQ8[i];

      // Integer part (floor)
      int x0 = sxQ8 >> 8;
      int y0 = syQ8 >> 8;

      if (x0 < 0 || x0 >= maxX || y0 < 0 || y0 >= maxY) {
        // Out of bounds — black pixel
        dstPixels[i] = 0xFF000000;
        continue;
      }

      // Fractional part (0-255)
      int fx = sxQ8 & 0xFF;
      int fy = syQ8 & 0xFF;
      int ifx = 256 - fx;
      int ify = 256 - fy;

      // Four source pixels
      int idx00 = y0 * w + x0;
      int p00 = srcPixels[idx00];
      int p10 = srcPixels[idx00 + 1];
      int p01 = srcPixels[idx00 + w];
      int p11 = srcPixels[idx00 + w + 1];

      // Bilinear blend per channel
      int r = (ifx * ify * ((p00 >> 16) & 0xFF) + fx * ify * ((p10 >> 16) & 0xFF)
             + ifx * fy * ((p01 >> 16) & 0xFF) + fx * fy * ((p11 >> 16) & 0xFF)) >> 16;
      int g = (ifx * ify * ((p00 >> 8) & 0xFF) + fx * ify * ((p10 >> 8) & 0xFF)
             + ifx * fy * ((p01 >> 8) & 0xFF) + fx * fy * ((p11 >> 8) & 0xFF)) >> 16;
      int b = (ifx * ify * (p00 & 0xFF) + fx * ify * (p10 & 0xFF)
             + ifx * fy * (p01 & 0xFF) + fx * fy * (p11 & 0xFF)) >> 16;

      dstPixels[i] = 0xFF000000 | (r << 16) | (g << 8) | b;
    }

    Bitmap dst = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
    dst.setPixels(dstPixels, 0, w, 0, 0, w, h);
    return dst;
  }

  /**
   * Build the remapping LUT for lens distortion correction.
   * Coordinates are stored as Q8 fixed-point (value * 256) to support
   * sub-pixel bilinear interpolation without floating point per-pixel.
   */
  private static synchronized void buildRemapLut(int w, int h) {
    Log.d(TAG, "Building lens correction LUT for " + w + "x" + h);
    long t0 = System.currentTimeMillis();

    int[] remapXQ8 = new int[w * h];
    int[] remapYQ8 = new int[w * h];

    double cx = w / 2.0;
    double cy = h / 2.0;
    double norm = Math.sqrt(cx * cx + cy * cy);

    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        double xn = (x - cx) / norm;
        double yn = (y - cy) / norm;
        double r2 = xn * xn + yn * yn;
        double r4 = r2 * r2;

        double radial = 1.0 + K1 * r2 + K2 * r4;
        double xd = xn * radial + 2 * P1 * xn * yn + P2 * (r2 + 2 * xn * xn);
        double yd = yn * radial + P1 * (r2 + 2 * yn * yn) + 2 * P2 * xn * yn;

        // Store as Q8 fixed-point for bilinear interpolation
        int idx = y * w + x;
        remapXQ8[idx] = (int) ((xd * norm + cx) * 256);
        remapYQ8[idx] = (int) ((yd * norm + cy) * 256);
      }
    }

    sRemapXQ8 = remapXQ8;
    sRemapYQ8 = remapYQ8;
    sLutWidth = w;
    sLutHeight = h;

    Log.d(TAG, "LUT built in " + (System.currentTimeMillis() - t0) + "ms");
  }

  /**
   * Apply tone mapping + vibrance + color correction in a single pass,
   * all in linear light space to match iOS CIFilter behavior.
   *
   * Pipeline per pixel:
   *   1. sRGB gamma decode (byte → linear float via LUT)
   *   2. Tone curve (piecewise-linear S-curve in linear space)
   *   3. Vibrance (luminance-based selective saturation boost)
   *   4. Color correction matrix (warmth/white balance)
   *   5. sRGB gamma encode (linear float → byte via LUT)
   */
  private static Bitmap applyColorPipeline(Bitmap src) {
    int w = src.getWidth(), h = src.getHeight();
    int[] pixels = new int[w * h];
    src.getPixels(pixels, 0, w, 0, 0, w, h);

    for (int i = 0; i < pixels.length; i++) {
      // 1. Linearize sRGB → linear
      float lr = LINEARIZE_LUT[(pixels[i] >> 16) & 0xFF];
      float lg = LINEARIZE_LUT[(pixels[i] >> 8) & 0xFF];
      float lb = LINEARIZE_LUT[pixels[i] & 0xFF];

      // 2a. Tone curve in linear space
      lr = toneCurveLookup(lr);
      lg = toneCurveLookup(lg);
      lb = toneCurveLookup(lb);

      // 2b. Vibrance — luminance-based, stays in linear space (no HSV round-trip)
      // Matches CIVibrance behavior: selectively boosts desaturated colors
      float lum = 0.2126f * lr + 0.7152f * lg + 0.0722f * lb;
      float maxC = Math.max(lr, Math.max(lg, lb));
      float minC = Math.min(lr, Math.min(lg, lb));
      float sat = (maxC > 0.0001f) ? (maxC - minC) / maxC : 0f;
      float amount = VIBRANCE_AMOUNT * (1.0f - sat); // boost desaturated more
      lr = lr + (lr - lum) * amount;
      lg = lg + (lg - lum) * amount;
      lb = lb + (lb - lum) * amount;

      // 2c. Color correction matrix in linear space
      float cr = CM_RR * lr + CM_RG * lg + CM_RB * lb + CM_R_BIAS;
      float cg = CM_GR * lr + CM_GG * lg + CM_GB * lb + CM_G_BIAS;
      float cb = CM_BR * lr + CM_BG * lg + CM_BB * lb + CM_B_BIAS;

      // Clamp to [0, 1]
      cr = Math.max(0f, Math.min(1f, cr));
      cg = Math.max(0f, Math.min(1f, cg));
      cb = Math.max(0f, Math.min(1f, cb));

      // 5. Encode linear → sRGB
      int outR = toSrgbByte(cr);
      int outG = toSrgbByte(cg);
      int outB = toSrgbByte(cb);

      pixels[i] = 0xFF000000 | (outR << 16) | (outG << 8) | outB;
    }

    Bitmap dst = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
    dst.setPixels(pixels, 0, w, 0, 0, w, h);
    return dst;
  }

  /**
   * Merge 3 exposure-bracketed images into a single HDR result using
   * simple exposure fusion (Mertens' method approximation).
   *
   * @param underPath Path to the underexposed image (EV-2)
   * @param normalPath Path to the normally exposed image (EV0)
   * @param overPath Path to the overexposed image (EV+2)
   * @param outputPath Path to write the merged HDR result
   * @param jpegQuality JPEG output quality
   * @return processing time in ms, or -1 on failure
   */
  public static long mergeHdr(String underPath, String normalPath, String overPath,
                               String outputPath, int jpegQuality) {
    long startTime = System.currentTimeMillis();

    try {
      Bitmap under = BitmapFactory.decodeFile(underPath);
      Bitmap normal = BitmapFactory.decodeFile(normalPath);
      Bitmap over = BitmapFactory.decodeFile(overPath);

      if (under == null || normal == null || over == null) {
        Log.e(TAG, "Failed to decode one or more HDR bracket images");
        return -1;
      }

      int w = normal.getWidth();
      int h = normal.getHeight();

      // Ensure all images are the same size
      if (under.getWidth() != w || under.getHeight() != h
          || over.getWidth() != w || over.getHeight() != h) {
        Log.w(TAG, "HDR bracket images have different sizes, resizing");
        under = Bitmap.createScaledBitmap(under, w, h, true);
        over = Bitmap.createScaledBitmap(over, w, h, true);
      }

      int[] underPixels = new int[w * h];
      int[] normalPixels = new int[w * h];
      int[] overPixels = new int[w * h];
      under.getPixels(underPixels, 0, w, 0, 0, w, h);
      normal.getPixels(normalPixels, 0, w, 0, 0, w, h);
      over.getPixels(overPixels, 0, w, 0, 0, w, h);

      int[] resultPixels = new int[w * h];

      // Simple exposure fusion: weight each pixel by how well-exposed it is
      // Well-exposed = closer to mid-gray (128). Clip recovery from under/over.
      for (int i = 0; i < w * h; i++) {
        int uR = (underPixels[i] >> 16) & 0xFF;
        int uG = (underPixels[i] >> 8) & 0xFF;
        int uB = underPixels[i] & 0xFF;
        float uLum = (uR + uG + uB) / 3.0f / 255.0f;
        float uWeight = 4.0f * uLum * (1.0f - uLum) + 0.01f; // Gaussian-ish around 0.5

        int nR = (normalPixels[i] >> 16) & 0xFF;
        int nG = (normalPixels[i] >> 8) & 0xFF;
        int nB = normalPixels[i] & 0xFF;
        float nLum = (nR + nG + nB) / 3.0f / 255.0f;
        float nWeight = 4.0f * nLum * (1.0f - nLum) + 0.01f;

        int oR = (overPixels[i] >> 16) & 0xFF;
        int oG = (overPixels[i] >> 8) & 0xFF;
        int oB = overPixels[i] & 0xFF;
        float oLum = (oR + oG + oB) / 3.0f / 255.0f;
        float oWeight = 4.0f * oLum * (1.0f - oLum) + 0.01f;

        float total = uWeight + nWeight + oWeight;
        int rOut = Math.min(255, Math.round((uR * uWeight + nR * nWeight + oR * oWeight) / total));
        int gOut = Math.min(255, Math.round((uG * uWeight + nG * nWeight + oG * oWeight) / total));
        int bOut = Math.min(255, Math.round((uB * uWeight + nB * nWeight + oB * oWeight) / total));

        resultPixels[i] = 0xFF000000 | (rOut << 16) | (gOut << 8) | bOut;
      }

      under.recycle();
      normal.recycle();
      over.recycle();

      Bitmap result = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
      result.setPixels(resultPixels, 0, w, 0, 0, w, h);

      try (FileOutputStream fos = new FileOutputStream(new File(outputPath))) {
        result.compress(Bitmap.CompressFormat.JPEG, jpegQuality, fos);
      }
      result.recycle();

      long elapsed = System.currentTimeMillis() - startTime;
      Log.d(TAG, "HDR merge complete in " + elapsed + "ms -> " + outputPath);
      return elapsed;

    } catch (Exception e) {
      Log.e(TAG, "HDR merge failed", e);
      return -1;
    }
  }
}
