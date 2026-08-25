package com.mentra.asg_client.audio;

import android.content.Context;
import android.util.Log;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.utils.WakeLockManager;
import java.io.File;

/**
 * Stitches a pairing code into one I2S WAV and plays it. Used by the MCU {@code hm_spkcode} path
 * and the JSON {@code speak_pairing_code} command.
 */
public final class PairingCodeSpeaker {

    private static final String TAG = "PairingCodeSpeaker";
    private static final long WAKE_LOCK_MS = 8000L;

    private PairingCodeSpeaker() {}

    public static boolean speak(Context context, IHardwareManager hardwareManager, String code) {
        if (context == null || hardwareManager == null || code == null) {
            Log.w(TAG, "speak skipped: missing context, hardware, or code");
            return false;
        }
        String normalized = code.trim();
        if (normalized.isEmpty()) {
            Log.w(TAG, "speak skipped: empty pairing code");
            return false;
        }
        if (!hardwareManager.supportsAudioPlayback()) {
            Log.w(TAG, "speak skipped: hardware does not support audio playback");
            return false;
        }

        WakeLockManager.acquireScreen(context, WakeLockManager.WakeOwner.PAIRING_CODE, WAKE_LOCK_MS);
        try {
            File wav = PairingCodePcmStitcher.stitchCodeToCache(context, normalized);
            boolean played = hardwareManager.playAudioFile(wav);
            Log.i(
                    TAG,
                    "pairing code playback code="
                            + normalized
                            + " file="
                            + wav.getAbsolutePath()
                            + " playAudioFile="
                            + played);
            return played;
        } catch (Exception e) {
            Log.e(TAG, "failed to speak pairing code " + normalized, e);
            return false;
        }
    }
}
