package com.mentra.asg_client.audio.diag;

import android.content.Context;
import com.mentra.asg_client.AsgConstants;
import java.io.File;

/**
 * The harness runs only when an engineer has created the gate file over adb, for example
 * {@code adb shell touch /sdcard/Android/data/<package>/files/audio-repro/ENABLED}. Without it every
 * harness command is refused, so shipping the harness code never changes production behavior.
 */
public final class AudioReproGate {

    private AudioReproGate() {}

    /** The harness root, or null when external storage is unavailable. */
    public static File baseDir(Context context) {
        File external = context.getExternalFilesDir(null);
        return external == null ? null : new File(external, AsgConstants.AUDIO_REPRO_DIR);
    }

    public static boolean isEnabled(Context context) {
        File base = baseDir(context);
        return base != null && new File(base, AsgConstants.AUDIO_REPRO_ENABLED_FILE).isFile();
    }

    /**
     * Resolve a sequence path relative to the harness root, refusing anything outside it so the
     * command cannot be used to read arbitrary files.
     */
    public static File resolveInside(Context context, String relativePath) {
        File base = baseDir(context);
        if (base == null || relativePath == null || relativePath.isEmpty()) return null;
        try {
            File baseCanonical = base.getCanonicalFile();
            File candidate = new File(baseCanonical, relativePath).getCanonicalFile();
            String prefix = baseCanonical.getPath() + File.separator;
            return candidate.getPath().startsWith(prefix) ? candidate : null;
        } catch (java.io.IOException e) {
            return null;
        }
    }
}
