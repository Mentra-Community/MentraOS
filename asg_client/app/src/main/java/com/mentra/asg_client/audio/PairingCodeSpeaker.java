package com.mentra.asg_client.audio;

import android.content.Context;
import android.util.Log;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.peripheral.events.PairingModeExitEvent;
import com.mentra.asg_client.utils.WakeLockManager;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;
import java.util.function.Predicate;
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

    /** Plays the generic exit clip (unknown reason). */
    public static boolean speakPairingEnded(Context context, IHardwareManager hardwareManager) {
        return speakPairingEnded(context, hardwareManager, null);
    }

    /**
     * Plays the one-shot message emitted when BES closes its pairing window, chosen by the {@code
     * hm_pairexit} reason. See {@link #chooseEndedAsset(String, Predicate)}.
     */
    public static boolean speakPairingEnded(
            Context context, IHardwareManager hardwareManager, String reason) {
        if (context == null || hardwareManager == null || !hardwareManager.supportsAudioPlayback()) {
            Log.w(TAG, "pairing-ended playback skipped: audio unavailable");
            return false;
        }
        final Context appContext = context.getApplicationContext() != null
                ? context.getApplicationContext()
                : context;
        String asset = chooseEndedAsset(reason, name -> assetExists(appContext, name));
        WakeLockManager.acquireScreen(
                context,
                WakeLockManager.WakeOwner.PAIRING_CODE,
                SHORT_PROMPT_WAKE_LOCK_MS);
        try {
            hardwareManager.playAudioAsset(asset);
        } catch (RuntimeException e) {
            Log.e(TAG, "pairing-ended playback failed asset=" + asset, e);
            return false;
        }
        Log.i(TAG, "pairing-ended asset dispatched reason=" + reason + " asset=" + asset);
        return true;
    }

    /**
     * Picks the exit clip for an {@code hm_pairexit} reason.
     *
     * <ul>
     *   <li>{@code timeout}: {@link AudioAssets#AUDIO_PAIRING_ENDED_NO_PHONE}
     *   <li>{@code cancelled}: {@link AudioAssets#AUDIO_PAIRING_CANCELLED}
     *   <li>{@code paired}, unknown or missing: {@link AudioAssets#PAIRING_EXITED} (today's clip)
     * </ul>
     *
     * A reason-specific clip that is not packaged in the APK falls back to the generic clip.
     */
    public static String chooseEndedAsset(String reason, Predicate<String> assetExists) {
        String specific = null;
        if (reason != null) {
            String normalized = reason.trim().toLowerCase(Locale.ROOT);
            if (PairingModeExitEvent.REASON_TIMEOUT.equals(normalized)) {
                specific = AudioAssets.AUDIO_PAIRING_ENDED_NO_PHONE;
            } else if (PairingModeExitEvent.REASON_CANCELLED.equals(normalized)) {
                specific = AudioAssets.AUDIO_PAIRING_CANCELLED;
            }
        }
        if (specific == null) {
            return AudioAssets.PAIRING_EXITED;
        }
        boolean present = false;
        try {
            present = assetExists != null && assetExists.test(specific);
        } catch (RuntimeException e) {
            Log.w(TAG, "asset check failed for " + specific, e);
        }
        if (present) {
            return specific;
        }
        Log.w(TAG, "clip " + specific + " missing, falling back to " + AudioAssets.PAIRING_EXITED);
        return AudioAssets.PAIRING_EXITED;
    }

    private static boolean assetExists(Context context, String name) {
        try (InputStream ignored = context.getAssets().open(name)) {
            return true;
        } catch (IOException e) {
            return false;
        }
    }
}
