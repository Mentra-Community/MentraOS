package com.mentra.asg_client.camera.policy;

import android.content.Context;
import android.util.Log;
import android.util.SparseIntArray;
import android.view.Display;
import android.view.Surface;
import android.view.WindowManager;

import com.mentra.asg_client.service.utils.ServiceUtils;

/**
 * Phase 3 prep: resolves the display rotation and the JPEG EXIF orientation tag.
 *
 * <p>Split out of {@link CameraNeoService} because the rotation lookup table and the device-rotation
 * decision are reusable utilities — both photo and video paths consult them, and they have no
 * dependency on the camera service lifecycle.
 *
 * <p>Behavior is preserved bit-for-bit: K900 devices use {@link ServiceUtils#determineDefaultRotationForDevice}
 * unconditionally; other Android devices fall back to {@link WindowManager#getDefaultDisplay()}.
 */
public final class JpegOrientationResolver {

    private static final String TAG = "JpegOrientationResolver";

    /** Default value returned by {@link #getJpegOrientation(Context)} when no entry matches. */
    public static final int DEFAULT_JPEG_ORIENTATION = 90;

    /** EXIF orientation value used by video pipelines when no display rotation is supplied. */
    public static final int DEFAULT_VIDEO_ORIENTATION = 0;

    private static final SparseIntArray JPEG_ORIENTATION = new SparseIntArray();

    static {
        JPEG_ORIENTATION.append(0, 90);
        JPEG_ORIENTATION.append(90, 0);
        JPEG_ORIENTATION.append(180, 270);
        JPEG_ORIENTATION.append(270, 180);
    }

    private JpegOrientationResolver() {}

    /**
     * Get the display rotation in degrees (0, 90, 180, or 270).
     *
     * <p>K900 devices have a fixed, device-specific rotation. Standard Android devices use the
     * current system display rotation. If no {@link WindowManager} is available, falls back to the
     * device default.
     */
    public static int getDisplayRotation(Context context) {
        int deviceDefaultRotation = ServiceUtils.determineDefaultRotationForDevice(context);
        String deviceType = ServiceUtils.getDeviceTypeString(context);

        Log.d(TAG, "📱 Device type: " + deviceType + ", Default rotation: " + deviceDefaultRotation + "°");

        if (ServiceUtils.isK900Device(context)) {
            Log.d(TAG, "🔄 Using K900-specific rotation: " + deviceDefaultRotation + "°");
            return deviceDefaultRotation;
        }

        WindowManager windowManager = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        if (windowManager != null) {
            Display display = windowManager.getDefaultDisplay();
            switch (display.getRotation()) {
                case Surface.ROTATION_0:
                    Log.d(TAG, "🔄 System display rotation: 0°");
                    return 0;
                case Surface.ROTATION_90:
                    Log.d(TAG, "🔄 System display rotation: 90°");
                    return 90;
                case Surface.ROTATION_180:
                    Log.d(TAG, "🔄 System display rotation: 180°");
                    return 180;
                case Surface.ROTATION_270:
                    Log.d(TAG, "🔄 System display rotation: 270°");
                    return 270;
                default:
                    Log.d(TAG, "🔄 System display rotation: default 0°");
                    return 0;
            }
        }

        Log.w(TAG, "⚠️ WindowManager unavailable - using device default: " + deviceDefaultRotation + "°");
        return deviceDefaultRotation;
    }

    /**
     * Resolve the JPEG EXIF orientation tag for a current display rotation.
     *
     * @param context service or activity context.
     * @return EXIF orientation in degrees ({@value #DEFAULT_JPEG_ORIENTATION} when no entry matches).
     */
    public static int getJpegOrientation(Context context) {
        int displayOrientation = getDisplayRotation(context);
        return JPEG_ORIENTATION.get(displayOrientation, DEFAULT_JPEG_ORIENTATION);
    }

    /**
     * Resolve the orientation tag used by the video path (defaults to 0° when no entry matches,
     * matching the historical {@code JPEG_ORIENTATION.get(_, 0)} call in the video setup).
     */
    public static int getVideoOrientation(Context context) {
        int displayOrientation = getDisplayRotation(context);
        return JPEG_ORIENTATION.get(displayOrientation, DEFAULT_VIDEO_ORIENTATION);
    }

    /**
     * Direct lookup against the EXIF mapping table, exposed for callers that already have a
     * resolved display rotation (e.g. tests, or code paths that compute rotation differently).
     *
     * @param displayRotation rotation in degrees.
     * @param defaultIfMissing fallback when the rotation isn't in the table.
     */
    public static int lookupJpegOrientation(int displayRotation, int defaultIfMissing) {
        return JPEG_ORIENTATION.get(displayRotation, defaultIfMissing);
    }
}
