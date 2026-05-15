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

        try {
            CaptureRequest.Key<Integer> eisEnableKey = null;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                eisEnableKey = new CaptureRequest.Key<>(
                        "com.pixsmart.eisfeature.eisEnable", Integer.class);
                Log.d(TAG, "📹 EIS feature key created for API " + Build.VERSION.SDK_INT);
            } else {
                Log.w(TAG, "📹 EIS not supported on API " + Build.VERSION.SDK_INT + " (requires Q+)");
            }

            if (enabled) {
                Log.d(TAG, "📹 Enabling EIS - Setting SPORTS scene mode");
                builder.set(CaptureRequest.CONTROL_SCENE_MODE, CaptureRequest.CONTROL_SCENE_MODE_SPORTS);
                if (eisEnableKey != null) {
                    builder.set(eisEnableKey, 1);
                    Log.d(TAG, "📹 EIS hardware feature enabled");
                }
            } else {
                Log.d(TAG, "📹 Disabling EIS - Setting DISABLED scene mode");
                builder.set(CaptureRequest.CONTROL_SCENE_MODE, CaptureRequest.CONTROL_SCENE_MODE_DISABLED);
                if (eisEnableKey != null) {
                    builder.set(eisEnableKey, 0);
                    Log.d(TAG, "📹 EIS hardware feature disabled");
                }
            }

            Log.i(TAG, "📹 EIS configured successfully: " + (enabled ? "ENABLED" : "DISABLED"));
        } catch (Exception e) {
            Log.e(TAG, "💥 Error configuring EIS", e);
        }
    }
}
