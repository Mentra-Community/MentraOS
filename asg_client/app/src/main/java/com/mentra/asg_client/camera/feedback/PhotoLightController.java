package com.mentra.asg_client.camera.feedback;

import android.os.Handler;
import android.util.Log;

import androidx.annotation.Nullable;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.hardware.interfaces.RgbLedConstants;

import java.util.concurrent.atomic.AtomicBoolean;

/** Synchronizes the user-visible photo LED with the first reliable capture boundary. */
public final class PhotoLightController {
    private static final String TAG = "PhotoLight";

    /** Request-scoped state that guarantees fallback callbacks cannot flash the LED twice. */
    public static final class Token {
        private final boolean mEnabled;
        private final AtomicBoolean mTriggered = new AtomicBoolean();

        private Token(boolean enabled) {
            mEnabled = enabled;
        }
    }

    @Nullable private final IHardwareManager mHardwareManager;
    private final Handler mHandler;

    public PhotoLightController(@Nullable IHardwareManager hardwareManager, Handler handler) {
        mHardwareManager = hardwareManager;
        mHandler = handler;
    }

    /** Prepares one capture. Disabled tokens preserve the camera-restart cooldown behavior. */
    public Token prepare(boolean enabled) {
        return new Token(enabled);
    }

    /** Flashes once at exposure start, or at the first later boundary when exposure is unavailable. */
    public void onCaptureBoundary(Token token, String timingSource) {
        onCaptureBoundary(token, timingSource, 0L);
    }

    /**
     * Flashes once without blocking Camera2's capture callback. A known exposure duration keeps
     * the indicator lit through long low-light captures.
     */
    public void onCaptureBoundary(
            Token token, String timingSource, long estimatedExposureDurationNs) {
        if (!token.mEnabled || !token.mTriggered.compareAndSet(false, true)) {
            return;
        }
        int durationMs = lightDurationMs(estimatedExposureDurationNs);
        mHandler.post(
                () -> {
                    if (mHardwareManager == null || !mHardwareManager.supportsRgbLed()) {
                        Log.w(TAG, "RGB photo LED is not supported");
                        return;
                    }
                    Log.i(
                            TAG,
                            "Flashing photo LED from "
                                    + timingSource
                                    + " for "
                                    + durationMs
                                    + "ms");
                    mHardwareManager.flashRgbLedWhite(
                            durationMs, RgbLedConstants.DEFAULT_BRIGHTNESS);
                });
    }

    static int lightDurationMs(long estimatedExposureDurationNs) {
        long exposureMs =
                estimatedExposureDurationNs <= 0L
                        ? 0L
                        : estimatedExposureDurationNs / 1_000_000L
                                + (estimatedExposureDurationNs % 1_000_000L == 0L ? 0L : 1L);
        return (int)
                Math.min(
                        Integer.MAX_VALUE,
                        Math.max(AsgConstants.PHOTO_LIGHT_DURATION_MS, exposureMs));
    }
}
