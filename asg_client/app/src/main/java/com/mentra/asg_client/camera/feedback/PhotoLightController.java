package com.mentra.asg_client.camera.feedback;

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

    public PhotoLightController(@Nullable IHardwareManager hardwareManager) {
        mHardwareManager = hardwareManager;
    }

    /** Prepares one capture. Disabled tokens preserve the camera-restart cooldown behavior. */
    public Token prepare(boolean enabled) {
        return new Token(enabled);
    }

    /** Flashes once at exposure start, or at the first later boundary when exposure is unavailable. */
    public void onCaptureBoundary(Token token, String timingSource) {
        if (!token.mEnabled || !token.mTriggered.compareAndSet(false, true)) {
            return;
        }
        if (mHardwareManager == null || !mHardwareManager.supportsRgbLed()) {
            Log.w(TAG, "RGB photo LED is not supported");
            return;
        }
        Log.i(TAG, "Flashing photo LED from " + timingSource);
        mHardwareManager.flashRgbLedWhite(
                AsgConstants.PHOTO_LIGHT_DURATION_MS, RgbLedConstants.DEFAULT_BRIGHTNESS);
    }
}
