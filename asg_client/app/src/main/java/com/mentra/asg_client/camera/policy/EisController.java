package com.mentra.asg_client.camera.policy;

import android.hardware.camera2.CaptureRequest;
import android.os.Build;
import android.util.Log;

/** Pixsmart EIS request-key helper for video capture. */
public final class EisController {

    private static final String TAG = "CameraNeo";

    private EisController() {}

    public static void configure(CaptureRequest.Builder builder, boolean enabled) {
        Log.i(TAG, "📹 ========== enableEIS ========== Enable: " + enabled);

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // The Pixsmart vendor key is only available on Q+; without it we cannot toggle EIS,
            // so do not touch scene/control mode either — that would change capture tuning on
            // devices that never had EIS to begin with.
            Log.w(TAG, "📹 EIS not supported on API " + Build.VERSION.SDK_INT + " (requires Q+) — skipping");
            return;
        }

        try {
            // Vendor key is registered as int[] (see CameraSettings#mKeyEisMode); mismatched types
            // are silently rejected by the HAL, so we must match the registered shape.
            CaptureRequest.Key<int[]> eisEnableKey = new CaptureRequest.Key<>(
                    "com.pixsmart.eisfeature.eisEnable", int[].class);
            Log.d(TAG, "📹 EIS feature key created for API " + Build.VERSION.SDK_INT);

            if (enabled) {
                Log.d(TAG, "📹 Enabling EIS - Setting SPORTS scene mode");
                // Scene mode is honored only when CONTROL_MODE is USE_SCENE_MODE (not AUTO).
                builder.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_USE_SCENE_MODE);
                builder.set(CaptureRequest.CONTROL_SCENE_MODE, CaptureRequest.CONTROL_SCENE_MODE_SPORTS);
                builder.set(eisEnableKey, new int[]{1});
                Log.d(TAG, "📹 EIS hardware feature enabled");
            } else {
                Log.d(TAG, "📹 Disabling EIS - Setting DISABLED scene mode");
                builder.set(CaptureRequest.CONTROL_SCENE_MODE, CaptureRequest.CONTROL_SCENE_MODE_DISABLED);
                builder.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO);
                builder.set(eisEnableKey, new int[]{0});
                Log.d(TAG, "📹 EIS hardware feature disabled");
            }

            Log.i(TAG, "📹 EIS configured successfully: " + (enabled ? "ENABLED" : "DISABLED"));
        } catch (Exception e) {
            Log.e(TAG, "💥 Error configuring EIS", e);
        }
    }
}
