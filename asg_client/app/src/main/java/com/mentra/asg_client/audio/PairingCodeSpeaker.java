package com.mentra.asg_client.audio;

import android.content.Context;
import android.util.Log;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.utils.WakeLockManager;
import java.io.File;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Stitches a pairing code into one I2S WAV and plays it. Used by the MCU {@code hm_spkcode} path
 * and the JSON {@code speak_pairing_code} command.
 */
public final class PairingCodeSpeaker {

    private static final String TAG = "PairingCodeSpeaker";
    /* The longest intro + four-character WAV is a little over six seconds.
     * Leave enough headroom for stitching, I2S startup, and scheduler latency
     * so the screen lease cannot expire while the code is still playing. */
    private static final long PAIRING_CODE_WAKE_LOCK_MS = 15000L;
    private static final long SHORT_PROMPT_WAKE_LOCK_MS = 8000L;
    private static final Pattern PAIRING_CODE = Pattern.compile("[0-9A-F]{4}");

    private PairingCodeSpeaker() {}

    public static boolean speak(Context context, IHardwareManager hardwareManager, String code) {
        if (context == null || hardwareManager == null || code == null) {
            Log.w(TAG, "speak skipped: missing context, hardware, or code");
            return false;
        }
        String normalized = code.trim().toUpperCase(Locale.US);
        if (!PAIRING_CODE.matcher(normalized).matches()) {
            Log.w(
                    TAG,
                    "speak skipped: pairing code must contain exactly four hexadecimal characters");
            return false;
        }
        if (!hardwareManager.supportsAudioPlayback()) {
            Log.w(TAG, "speak skipped: hardware does not support audio playback");
            return false;
        }

        WakeLockManager.acquireScreen(
                context,
                WakeLockManager.WakeOwner.PAIRING_CODE,
                PAIRING_CODE_WAKE_LOCK_MS);
        try {
            File wav = PairingCodePcmStitcher.stitchCodeToCache(context, normalized);
            boolean played = hardwareManager.playAudioFile(wav);
            Log.i(
                    TAG,
                    "pairing code playback file="
                            + wav.getAbsolutePath()
                            + " playAudioFile="
                            + played);
            return played;
        } catch (Exception e) {
            Log.e(TAG, "failed to speak pairing code", e);
            return false;
        }
    }

    /** Plays the one-shot message emitted when BES closes its pairing window. */
    public static boolean speakPairingEnded(Context context, IHardwareManager hardwareManager) {
        if (context == null || hardwareManager == null || !hardwareManager.supportsAudioPlayback()) {
            Log.w(TAG, "pairing-ended playback skipped: audio unavailable");
            return false;
        }
        WakeLockManager.acquireScreen(
                context,
                WakeLockManager.WakeOwner.PAIRING_CODE,
                SHORT_PROMPT_WAKE_LOCK_MS);
        hardwareManager.playAudioAsset(AudioAssets.PAIRING_EXITED);
        Log.i(TAG, "pairing-ended asset dispatched");
        return true;
    }
}
