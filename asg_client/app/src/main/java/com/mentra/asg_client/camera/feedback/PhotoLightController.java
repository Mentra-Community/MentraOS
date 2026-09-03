package com.mentra.asg_client.camera.feedback;

import android.os.Handler;
import android.util.Log;

import androidx.annotation.Nullable;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.hardware.interfaces.RgbLedConstants;

import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/** Synchronizes the privacy and user-visible photo LEDs with the camera capture lifecycle. */
public final class PhotoLightController {
    private static final String TAG = "PhotoLight";

    /** Request-scoped state for the privacy and RGB photo-light lifecycles. */
    public static final class Token {
        private final boolean mEnabled;
        private final AtomicBoolean mTriggered = new AtomicBoolean();
        private boolean mPrivacyLightActive;
        private boolean mPrivacyLightTerminal;
        @Nullable private Runnable mPrivacyLightSafetyTimeout;

        private Token(boolean enabled) {
            mEnabled = enabled;
        }
    }

    @Nullable private final IHardwareManager mHardwareManager;
    private final Handler mHandler;
    private final Object mPrivacyLightLock = new Object();
    private final Set<Token> mActivePrivacyLights = new HashSet<>();

    public PhotoLightController(@Nullable IHardwareManager hardwareManager, Handler handler) {
        mHardwareManager = hardwareManager;
        mHandler = handler;
    }

    /** Prepares one capture. Disabled tokens preserve the camera-restart cooldown behavior. */
    public Token prepare(boolean enabled) {
        return new Token(enabled);
    }

    /** Turns on the front-facing privacy light until the camera produces this photo. */
    public void startPrivacyLight(Token token, String timingSource) {
        synchronized (mPrivacyLightLock) {
            if (!token.mEnabled
                    || token.mPrivacyLightActive
                    || token.mPrivacyLightTerminal
                    || mHardwareManager == null
                    || !mHardwareManager.supportsRecordingLed()) {
                return;
            }

            token.mPrivacyLightActive = true;
            mActivePrivacyLights.add(token);
            Log.i(TAG, "Acquiring privacy light from " + timingSource);
            mHandler.post(() -> mHardwareManager.acquireRecordingLed(token));
        }
    }

    /**
     * Turns off the privacy light once every capture that turned it on has reached a terminal
     * boundary.
     */
    public void finishPrivacyLight(Token token, String timingSource) {
        synchronized (mPrivacyLightLock) {
            if (token.mPrivacyLightTerminal) {
                return;
            }
            token.mPrivacyLightTerminal = true;
            if (token.mPrivacyLightSafetyTimeout != null) {
                mHandler.removeCallbacks(token.mPrivacyLightSafetyTimeout);
                token.mPrivacyLightSafetyTimeout = null;
            }
            if (!token.mPrivacyLightActive || !mActivePrivacyLights.remove(token)) {
                return;
            }
            token.mPrivacyLightActive = false;
            if (mHardwareManager == null) {
                return;
            }

            Log.i(TAG, "Releasing privacy light from " + timingSource);
            mHandler.post(() -> mHardwareManager.releaseRecordingLed(token));
        }
    }

    /** Releases any privacy-light ownership left behind during service teardown. */
    public void cleanup() {
        synchronized (mPrivacyLightLock) {
            if (mActivePrivacyLights.isEmpty()) {
                return;
            }
            for (Token token : mActivePrivacyLights) {
                if (token.mPrivacyLightSafetyTimeout != null) {
                    mHandler.removeCallbacks(token.mPrivacyLightSafetyTimeout);
                    token.mPrivacyLightSafetyTimeout = null;
                }
                token.mPrivacyLightActive = false;
                token.mPrivacyLightTerminal = true;
                if (mHardwareManager != null) {
                    mHandler.post(() -> mHardwareManager.releaseRecordingLed(token));
                }
            }
            mActivePrivacyLights.clear();
        }
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
        armPrivacyLightSafetyTimeout(token);
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

    private void armPrivacyLightSafetyTimeout(Token token) {
        synchronized (mPrivacyLightLock) {
            if (!token.mPrivacyLightActive
                    || token.mPrivacyLightTerminal
                    || token.mPrivacyLightSafetyTimeout != null) {
                return;
            }
            token.mPrivacyLightSafetyTimeout =
                    () -> finishPrivacyLight(token, "safety timeout");
            mHandler.postDelayed(
                    token.mPrivacyLightSafetyTimeout,
                    AsgConstants.PHOTO_PRIVACY_LIGHT_SAFETY_TIMEOUT_MS);
        }
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
