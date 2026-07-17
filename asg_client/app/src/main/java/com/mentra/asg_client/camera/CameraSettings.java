package com.mentra.asg_client.camera;

import android.content.Context;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.util.Log;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.settings.AsgSettings;

import java.util.List;

/**
 * Camera settings helper for MediaTek vendor-specific features (independent ZSL + MFNR).
 * Handles vendor key detection and configuration for enhanced photo quality.
 */
public class CameraSettings {
  private static final String TAG = "CameraSettings";

  // MediaTek vendor key names
  private static final String AIS_REQUEST_MODE_KEY_NAME = "com.mediatek.mfnrfeature.mfbmode";
  private static final String ZSL_KEY_MODE_REQUEST = "com.mediatek.control.capture.zsl.mode";
  private static final String ISO_KEY_CONTROL_SPEED = "com.mediatek.3afeature.aeIsoSpeed";
  private static final String MTK_NR_FEATURE_3DNR_MODE = "com.mediatek.nrfeature.3dnrmode";
  private static final String EIS_KEY_CONTROL = "com.pixsmart.eisfeature.eisEnable";

  // Vendor keys (detected at runtime)
  private CaptureRequest.Key<int[]> mKeyAisRequestMode;  // MFNR/AIS mode
  private CaptureRequest.Key<byte[]> mKeyZslMode;  // ZSL mode
  private CaptureRequest.Key<int[]> mKeyIsoRequestValue;  // ISO control (detected but not used)
  private CaptureRequest.Key<int[]> mKey3DNRMode;  // 3DNR for video (optional)
  private CaptureRequest.Key<int[]> mKeyEisMode;  // EIS for video (optional)

  private final Context mContext;
  public final AsgSettings mAsgSettings;  // Public for access in CameraNeoService
  private CameraCharacteristics mCharacteristics;

  public CameraSettings(Context context) {
    mContext = context;
    mAsgSettings = new AsgSettings(context);
  }

  /**
   * Initialize MediaTek vendor keys (call once after camera is opened)
   * @param characteristics Camera characteristics from opened camera
   */
  public void init(CameraCharacteristics characteristics) {
    mCharacteristics = characteristics;
    if (mCharacteristics == null) {
      Log.w(TAG, "Camera characteristics is null, cannot initialize vendor keys");
      return;
    }

    List<CaptureRequest.Key<?>> requestKeyList = mCharacteristics.getAvailableCaptureRequestKeys();
    if (requestKeyList == null) {
      Log.w(TAG, "No available capture request keys found");
      return;
    }

    for (CaptureRequest.Key<?> requestKey : requestKeyList) {
      String keyName = requestKey.getName();
      if (keyName.equals(AIS_REQUEST_MODE_KEY_NAME)) {
        mKeyAisRequestMode = (CaptureRequest.Key<int[]>) requestKey;
        Log.d(TAG, "Found MFNR/AIS key: " + keyName);
      } else if (keyName.equals(ZSL_KEY_MODE_REQUEST)) {
        mKeyZslMode = (CaptureRequest.Key<byte[]>) requestKey;
        Log.d(TAG, "Found ZSL key: " + keyName);
      } else if (keyName.equals(ISO_KEY_CONTROL_SPEED)) {
        mKeyIsoRequestValue = (CaptureRequest.Key<int[]>) requestKey;
        Log.d(TAG, "Found ISO control key: " + keyName + " (detected but not used - let system auto-adjust)");
      } else if (keyName.equals(MTK_NR_FEATURE_3DNR_MODE)) {
        mKey3DNRMode = (CaptureRequest.Key<int[]>) requestKey;
        Log.d(TAG, "Found 3DNR key: " + keyName);
      } else if (keyName.equals(EIS_KEY_CONTROL)) {
        mKeyEisMode = (CaptureRequest.Key<int[]>) requestKey;
        Log.d(TAG, "Found EIS key: " + keyName);
      }
    }

    boolean zslSupported = isZslSupported();
    boolean mfnrSupported = isMfnrSupported();
    Log.d(TAG, "Vendor key detection complete - ZSL: " + zslSupported + ", MFNR: " + mfnrSupported);
  }

  /** @return true if ZSL vendor keys are available */
  public boolean isZslSupported() {
    return mKeyZslMode != null;
  }

  /** @return true if MFNR vendor keys are available */
  public boolean isMfnrSupported() {
    return mKeyAisRequestMode != null;
  }

  /**
   * Configure preview builder using the global ZSL device default.
   * Prefer {@link #configurePreviewBuilder(CaptureRequest.Builder, boolean)} with the
   * per-request resolved value so preview buffering matches the pending capture.
   */
  public void configurePreviewBuilder(CaptureRequest.Builder builder) {
    configurePreviewBuilder(builder, mAsgSettings.isZslEnabled() || mAsgSettings.isMfnrEnabled());
  }

  /**
   * Configure preview builder with ZSL buffering when {@code zsl} is true.
   * MFNR/AIS is always off in preview; MFNR only applies on the still request.
   * Callers should pass {@code zsl || mfnr} because MFNR needs the ZSL circular buffer.
   */
  public void configurePreviewBuilder(CaptureRequest.Builder builder, boolean zsl) {
    if (builder == null) {
      Log.w(TAG, "Preview builder is null, cannot configure");
      return;
    }

    boolean enabled = AsgConstants.ENABLE_ZSL && zsl;
    if (!enabled) {
      builder.set(CaptureRequest.CONTROL_ENABLE_ZSL, false);
      if (mKeyZslMode != null) {
        builder.set(mKeyZslMode, new byte[]{0});
      }
      if (mKeyAisRequestMode != null) {
        builder.set(mKeyAisRequestMode, new int[]{0});
      }
      Log.d(TAG, "Preview ZSL disabled - cleared preview vendor key configuration");
      return;
    }

    if (!isZslSupported()) {
      Log.d(TAG, "ZSL vendor keys not available - using standard Camera2 API");
      return;
    }

    Log.d(TAG, "Configuring preview builder with ZSL buffering");

    builder.set(CaptureRequest.CONTROL_ENABLE_ZSL, true);
    Log.d(TAG, "Set CONTROL_ENABLE_ZSL = true in preview builder");

    if (mKeyZslMode != null) {
      byte[] zslMode = new byte[]{1};
      builder.set(mKeyZslMode, zslMode);
      Log.d(TAG, "Preview: ZSL_MODE vendor key set to ON (1)");
    }

    if (mKeyAisRequestMode != null) {
      int[] aisOff = new int[]{0};
      builder.set(mKeyAisRequestMode, aisOff);
      Log.d(TAG, "Preview: MFNR/AIS mode set to OFF (0) - Only capture needs it");
    }
  }

  /** @return true if 3DNR vendor key is available */
  public boolean is3DNRSupported() {
    return mKey3DNRMode != null;
  }

  /**
   * Configure 3DNR (temporal noise reduction) on a video capture request builder.
   */
  public void configure3DNR(CaptureRequest.Builder builder) {
    if (builder == null) {
      Log.w(TAG, "Builder is null, cannot configure 3DNR");
      return;
    }

    if (!is3DNRSupported()) {
      Log.d(TAG, "3DNR vendor key not available on this device");
      return;
    }

    try {
      builder.set(mKey3DNRMode, new int[]{1});
      Log.d(TAG, "3DNR enabled for video capture");
    } catch (Exception e) {
      Log.e(TAG, "Failed to enable 3DNR", e);
    }
  }

  /**
   * Configure capture builder using the global ZSL and MFNR device defaults.
   */
  public void configureCaptureBuilder(CaptureRequest.Builder builder) {
    configureCaptureBuilder(
        builder, mAsgSettings.isZslEnabled(), mAsgSettings.isMfnrEnabled());
  }

  /**
   * Configure capture builder with independent ZSL and MFNR vendor keys.
   */
  public void configureCaptureBuilder(
      CaptureRequest.Builder builder, boolean zsl, boolean mfnr) {
    if (builder == null) {
      Log.w(TAG, "Capture builder is null, cannot configure");
      return;
    }

    boolean zslEnabled = AsgConstants.ENABLE_ZSL && zsl;
    boolean mfnrEnabled = AsgConstants.ENABLE_MFNR && mfnr;

    Log.i(
        TAG,
        "Applied vendor config — ZSL="
            + (zslEnabled ? "on" : "off")
            + " MFNR="
            + (mfnrEnabled ? "on" : "off"));

    if (zslEnabled && isZslSupported()) {
      builder.set(CaptureRequest.CONTROL_ENABLE_ZSL, true);
      if (mKeyZslMode != null) {
        builder.set(mKeyZslMode, new byte[]{1});
        Log.d(TAG, "Capture: ZSL_MODE vendor key set to ON (1)");
      }
    } else {
      builder.set(CaptureRequest.CONTROL_ENABLE_ZSL, false);
      if (mKeyZslMode != null) {
        builder.set(mKeyZslMode, new byte[]{0});
        Log.d(TAG, "Capture: ZSL_MODE vendor key set to OFF (0)");
      }
    }

    if (mfnrEnabled && isMfnrSupported()) {
      if (mKeyAisRequestMode != null) {
        builder.set(mKeyAisRequestMode, new int[]{255});
        Log.d(TAG, "Capture: MFNR/AIS mode set to ON (255) - Full multi-frame noise reduction");
      }
    } else if (mKeyAisRequestMode != null) {
      builder.set(mKeyAisRequestMode, new int[]{0});
      Log.d(TAG, "Capture: MFNR/AIS mode set to OFF (0)");
    }

    // Do NOT set ISO vendor key — let system auto-adjust so MFNR can trigger (ISO>800).
    if (mfnrEnabled) {
      Log.d(TAG, "Capture: ISO vendor key NOT set - Let system auto-adjust (allows ISO>1000 for MFNR)");
    }

    builder.set(CaptureRequest.CONTROL_AWB_MODE, CaptureRequest.CONTROL_AWB_MODE_AUTO);
    builder.set(CaptureRequest.CONTROL_AE_ANTIBANDING_MODE, 3);
    builder.set(CaptureRequest.FLASH_MODE, CameraMetadata.FLASH_MODE_OFF);
  }
}
