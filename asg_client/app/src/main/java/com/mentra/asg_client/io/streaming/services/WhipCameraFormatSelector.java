package com.mentra.asg_client.io.streaming.services;

import android.content.Context;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.util.Size;

/**
 * Shared capture-size selection logic for WHIP camera streaming.
 */
public final class WhipCameraFormatSelector {

  private WhipCameraFormatSelector() {
  }

  public static final class SelectionResult {
    private final Size mRawCaptureSize;
    private final Size mNormalizedCaptureSize;
    private final int mTransformPenalty;
    private final Size[] mAvailableOutputSizes;

    SelectionResult(Size rawCaptureSize, Size normalizedCaptureSize, int transformPenalty,
        Size[] availableOutputSizes) {
      mRawCaptureSize = rawCaptureSize;
      mNormalizedCaptureSize = normalizedCaptureSize;
      mTransformPenalty = transformPenalty;
      mAvailableOutputSizes = availableOutputSizes;
    }

    public Size getRawCaptureSize() {
      return mRawCaptureSize;
    }

    public Size getNormalizedCaptureSize() {
      return mNormalizedCaptureSize;
    }

    public int getTransformPenalty() {
      return mTransformPenalty;
    }

    public boolean requiresUpscale() {
      return mTransformPenalty == 2;
    }

    public boolean hasSupportedSizes() {
      return mAvailableOutputSizes != null && mAvailableOutputSizes.length > 0;
    }

    public Size[] getAvailableOutputSizes() {
      return mAvailableOutputSizes;
    }
  }

  public static SelectionResult selectCaptureSize(Context context, int requestedWidth,
      int requestedHeight) throws CameraAccessException {
    CameraManager cameraManager =
        (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
    if (cameraManager == null) {
      return null;
    }

    String cameraId = selectBackCamera(cameraManager);
    if (cameraId == null) {
      return null;
    }

    CameraCharacteristics characteristics = cameraManager.getCameraCharacteristics(cameraId);
    return selectCaptureSize(characteristics, requestedWidth, requestedHeight);
  }

  public static String selectBackCamera(CameraManager cameraManager) throws CameraAccessException {
    for (String id : cameraManager.getCameraIdList()) {
      CameraCharacteristics chars = cameraManager.getCameraCharacteristics(id);
      Integer facing = chars.get(CameraCharacteristics.LENS_FACING);
      if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK) {
        return id;
      }
    }

    String[] ids = cameraManager.getCameraIdList();
    return ids.length > 0 ? ids[0] : null;
  }

  public static SelectionResult selectCaptureSize(CameraCharacteristics characteristics,
      int requestedWidth, int requestedHeight) {
    StreamConfigurationMap configurationMap =
        characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
    if (configurationMap == null) {
      Size requestedSize = new Size(requestedWidth, requestedHeight);
      return new SelectionResult(requestedSize, normalizeLandscapeSize(requestedSize), 0,
          new Size[0]);
    }

    Size[] outputSizes = configurationMap.getOutputSizes(SurfaceTexture.class);
    if (outputSizes == null || outputSizes.length == 0) {
      Size requestedSize = new Size(requestedWidth, requestedHeight);
      return new SelectionResult(requestedSize, normalizeLandscapeSize(requestedSize), 0,
          new Size[0]);
    }

    Size requestedSize = normalizeLandscapeSize(new Size(requestedWidth, requestedHeight));
    Size bestRawSize = outputSizes[0];
    Size bestNormalizedSize = normalizeLandscapeSize(bestRawSize);
    int bestTransformPenalty = Integer.MAX_VALUE;
    long bestSourceArea = 0;
    long bestCropAreaDelta = Long.MAX_VALUE;

    for (Size rawSize : outputSizes) {
      Size candidate = normalizeLandscapeSize(rawSize);
      Size croppedSize = getCenterCropSize(candidate.getWidth(), candidate.getHeight(),
          requestedSize.getWidth(), requestedSize.getHeight());
      boolean meetsRequestedSize = croppedSize.getWidth() >= requestedSize.getWidth()
          && croppedSize.getHeight() >= requestedSize.getHeight();
      boolean exactOutput = croppedSize.getWidth() == requestedSize.getWidth()
          && croppedSize.getHeight() == requestedSize.getHeight();
      int transformPenalty = exactOutput ? 0 : meetsRequestedSize ? 1 : 2;
      long candidateArea = (long) candidate.getWidth() * candidate.getHeight();
      long cropArea = (long) croppedSize.getWidth() * croppedSize.getHeight();
      long cropAreaDelta = Math.abs(cropArea
          - ((long) requestedSize.getWidth() * requestedSize.getHeight()));

      boolean isBetter = transformPenalty < bestTransformPenalty
          || (transformPenalty == bestTransformPenalty
              && isPreferredSourceArea(transformPenalty, candidateArea, bestSourceArea))
          || (transformPenalty == bestTransformPenalty && candidateArea == bestSourceArea
              && cropAreaDelta < bestCropAreaDelta);

      if (isBetter) {
        bestRawSize = rawSize;
        bestNormalizedSize = candidate;
        bestTransformPenalty = transformPenalty;
        bestSourceArea = candidateArea;
        bestCropAreaDelta = cropAreaDelta;
      }
    }

    return new SelectionResult(bestRawSize, bestNormalizedSize, bestTransformPenalty, outputSizes);
  }

  private static boolean isPreferredSourceArea(int transformPenalty, long candidateArea,
      long bestSourceArea) {
    if (bestSourceArea == 0) {
      return true;
    }

    if (transformPenalty == 2) {
      return candidateArea > bestSourceArea;
    }

    return candidateArea < bestSourceArea;
  }

  static Size getCenterCropSize(int sourceWidth, int sourceHeight, int targetWidth,
      int targetHeight) {
    if (sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) {
      return new Size(sourceWidth, sourceHeight);
    }

    float sourceAspectRatio = sourceWidth / (float) sourceHeight;
    float targetAspectRatio = targetWidth / (float) targetHeight;
    int cropWidth = sourceWidth;
    int cropHeight = sourceHeight;

    if (Math.abs(sourceAspectRatio - targetAspectRatio) > 0.0001f) {
      if (sourceAspectRatio > targetAspectRatio) {
        cropWidth = Math.round(sourceHeight * targetAspectRatio);
      } else {
        cropHeight = Math.round(sourceWidth / targetAspectRatio);
      }
    }

    cropWidth = Math.max(1, Math.min(sourceWidth, cropWidth));
    cropHeight = Math.max(1, Math.min(sourceHeight, cropHeight));
    return new Size(cropWidth, cropHeight);
  }

  static Size normalizeLandscapeSize(Size size) {
    return new Size(Math.max(size.getWidth(), size.getHeight()),
        Math.min(size.getWidth(), size.getHeight()));
  }
}
