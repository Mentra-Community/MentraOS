package com.mentra.asg_client.camera.feedback;

import android.os.Handler;
import android.os.SystemClock;
import android.util.Log;
import androidx.annotation.Nullable;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.hardware.interfaces.RgbLedConstants;
import java.util.HashSet;
import java.util.Set;

/** Owns paired photo indicators from request acceptance through final frame availability. */
public final class PhotoLightController {
    /** Per-request ownership prevents a completed shot from extinguishing a later shot. */
    public static final class Token {
        private final String requestId;
        private long startedMs;
        private boolean finishing;
        private Runnable release;

        private Token(String requestId) {
            this.requestId = requestId;
        }
    }

    @Nullable private final IHardwareManager hardware;
    private final Handler handler;
    private final Set<Token> active = new HashSet<>();

    public PhotoLightController(@Nullable IHardwareManager hardware, Handler handler) {
        this.hardware = hardware;
        this.handler = handler;
    }

    /** Turn on both indicators at request acceptance, retaining existing privacy ownership. */
    public synchronized Token prepare(String requestId, boolean enabled) {
        Token token = new Token(requestId);
        if (!enabled || hardware == null) return token;
        if (hardware.supportsRecordingLed() && !hardware.acquireRecordingLed(token)) {
            // The camera's submission-time privacy gate will still reject a failed LED.
            Log.e("PhotoLight", "Could not acquire request-time privacy light");
            return token;
        }
        token.startedMs = SystemClock.uptimeMillis();
        if (hardware.supportsRgbLed()) {
            // BES interprets count=0 as disabled, despite the Android interface comment.
            // Use a solid single cycle and explicitly release it at the final frame.
            hardware.setRgbLedSolidWhite(AsgConstants.PHOTO_LIGHT_FAILSAFE_MS,
                    RgbLedConstants.DEFAULT_BRIGHTNESS);
        }
        active.add(token);
        Log.i("PhotoLight", "[PHOTO-LIGHT] paired on t_ms=" + token.startedMs);
        return token;
    }

    /** Exposure starts do not end the indication; final JPEG availability does. */
    public void onCaptureBoundary(Token token, String source, long exposureNs) {
        // Keep both indicators on through the full capture, including HDR/MFNR work.
    }

    /** Final-frame and completion fallbacks share the same idempotent release. */
    public void onCaptureBoundary(Token token, String source) {
        finish(token);
    }

    /** End a completed or failed request after its minimum indication time. */
    public synchronized void finish(Token token) {
        if (!active.contains(token) || token.finishing) return;
        token.finishing = true;
        long remaining = Math.max(0L, AsgConstants.PHOTO_LIGHT_DURATION_MS
                - (SystemClock.uptimeMillis() - token.startedMs));
        if (remaining == 0L) release(token);
        else {
            token.release = () -> release(token);
            handler.postDelayed(token.release, remaining);
        }
    }

    /** Release a timed-out job's feedback lease even when its camera callback never arrives. */
    public synchronized void finishForTimeout(String requestId) {
        if (requestId == null) return;
        for (Token token : new HashSet<>(active)) {
            if (requestId.equals(token.requestId)) finish(token);
        }
    }

    private synchronized void release(Token token) {
        if (!active.remove(token)) return;
        if (token.release != null) handler.removeCallbacks(token.release);
        hardware.releaseRecordingLed(token);
        if (active.isEmpty() && hardware.supportsRgbLed()
                && !hardware.isRecordingLedOwned()) hardware.setRgbLedOff();
        Log.i("PhotoLight", "[PHOTO-LIGHT] released t_ms=" + SystemClock.uptimeMillis());
    }

    /** Service teardown releases every request immediately, ignoring minimum display time. */
    public synchronized void cleanup() {
        for (Token token : new HashSet<>(active)) release(token);
    }
}
