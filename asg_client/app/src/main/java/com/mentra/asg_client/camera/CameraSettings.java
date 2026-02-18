package com.mentra.asg_client.camera;

import android.content.Context;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.util.Log;

import com.mentra.asg_client.settings.AsgSettings;

import java.util.List;

/**
 * Camera settings helper for MediaTek vendor-specific features (ZSL, MFNR)
 * Handles vendor key detection and configuration for enhanced photo quality
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
  public final AsgSettings mAsgSettings;  // Public for access in CameraNeo
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

    // Log summary of detected features
    boolean zslSupported = isZslSupported();
    boolean mfnrSupported = isMfnrSupported();
    Log.d(TAG, "Vendor key detection complete - ZSL: " + zslSupported + ", MFNR: " + mfnrSupported);
  }

  /**
   * Check if ZSL is supported (vendor keys available)
   * @return true if ZSL vendor keys are available
   */
  public boolean isZslSupported() {
    return mKeyZslMode != null;
  }

  /**
   * Check if MFNR is supported (vendor keys available)
   * @return true if MFNR vendor keys are available
   */
  public boolean isMfnrSupported() {
    return mKeyAisRequestMode != null;
  }

  /**
   * Configure preview builder with ZSL enabled (for photo preview)
   * ZSL must be enabled during preview to fill the circular buffer for MFNR
   * @param builder Capture request builder for preview
   */
  public void configurePreviewBuilder(CaptureRequest.Builder builder) {
    if (builder == null) {
      Log.w(TAG, "Preview builder is null, cannot configure");
      return;
    }

    // Check if ZSL is enabled in settings
    boolean zslEnabled = mAsgSettings.isZslEnabled();
    if (!zslEnabled) {
      Log.d(TAG, "ZSL disabled by settings - skipping vendor key configuration");
      return;
    }

    // Check if vendor keys are available
    if (!isZslSupported()) {
      Log.d(TAG, "ZSL vendor keys not available - using standard Camera2 API");
      return;
    }

    Log.d(TAG, "🔍 DIAGNOSTIC: Configuring preview builder with ZSL");
    
    // Enable ZSL during preview to fill circular buffer
    // ZSL works by: preview accumulates full-resolution frames -> capture reads from buffer -> MFNR gets 6 frames for merging
    // If ZSL is disabled during preview, buffer will be empty and MFNR cannot get enough frames!
    builder.set(CaptureRequest.CONTROL_ENABLE_ZSL, true);
    Log.d(TAG, "🔍 Set CONTROL_ENABLE_ZSL = true in preview builder");
    
    if (mKeyZslMode != null) {
      byte[] zslMode = new byte[]{1};
      builder.set(mKeyZslMode, zslMode);
      Log.d(TAG, "Preview: ZSL_MODE vendor key set to ON (1) - Required for MFNR buffer");
    }

    // Disable MFNR/AIS during preview (multi-frame processing only needed for capture)
    // But keep ZSL enabled to fill the buffer
    if (mKeyAisRequestMode != null) {
      int[] aisOff = new int[]{0};
      builder.set(mKeyAisRequestMode, aisOff);
      Log.d(TAG, "Preview: MFNR/AIS mode set to OFF (0) - Only capture needs it");
    }
  }

  /**
   * Configure capture builder with ZSL + MFNR enabled (for photo capture)
   * @param builder Capture request builder for still capture
   */
  public void configureCaptureBuilder(CaptureRequest.Builder builder) {
    if (builder == null) {
      Log.w(TAG, "Capture builder is null, cannot configure");
      return;
    }

    // Check if ZSL is enabled in settings
    boolean zslEnabled = mAsgSettings.isZslEnabled();
    boolean mfnrEnabled = mAsgSettings.isMfnrEnabled();

    if (!zslEnabled && !mfnrEnabled) {
      Log.d(TAG, "ZSL and MFNR disabled by settings - skipping vendor key configuration");
      return;
    }

    Log.d(TAG, "🔍 DIAGNOSTIC: Configuring capture builder with ZSL/MFNR");
    
    // Enable ZSL for capture
    if (zslEnabled && isZslSupported()) {
      builder.set(CaptureRequest.CONTROL_ENABLE_ZSL, true);
      Log.d(TAG, "🔍 Set CONTROL_ENABLE_ZSL = true in capture builder");
      
      if (mKeyZslMode != null) {
        byte[] zslMode = new byte[]{1};
        builder.set(mKeyZslMode, zslMode);
        Log.d(TAG, "Capture: ZSL_MODE vendor key set to ON (1)");
      }
    } else if (zslEnabled) {
      Log.d(TAG, "ZSL enabled in settings but vendor keys not available");
    }

    // Enable MFNR for capture (mode 255 = full MFNR)
    if (mfnrEnabled && isMfnrSupported()) {
      if (mKeyAisRequestMode != null) {
        int[] mfnrMode = new int[]{255};
        builder.set(mKeyAisRequestMode, mfnrMode);
        Log.d(TAG, "Capture: MFNR/AIS mode set to ON (255) - Full multi-frame noise reduction");
      }
    } else if (mfnrEnabled) {
      Log.d(TAG, "MFNR enabled in settings but vendor keys not available");
    }

    // Critical: Do NOT set ISO vendor key - let system auto-adjust
    // Setting ISO to 0 would limit ISO upper bound, causing ISO to only reach 400-500 in low light
    // This prevents MFNR from triggering (requires ISO>800)
    // By not setting it, system can auto-adjust ISO to 1000+ based on AE algorithm
    Log.d(TAG, "Capture: ISO vendor key NOT set - Let system auto-adjust (allows ISO>1000 for MFNR)");

    // Set standard capture settings
    builder.set(CaptureRequest.CONTROL_AWB_MODE, CaptureRequest.CONTROL_AWB_MODE_AUTO);
    builder.set(CaptureRequest.CONTROL_AE_ANTIBANDING_MODE, 3);
    builder.set(CaptureRequest.FLASH_MODE, CameraMetadata.FLASH_MODE_OFF);
  }
}

