package com.mentra.asg_client.service.core;

/**
 * Tracks a short cooldown after the camera HAL is restarted (e.g. after FOV change).
 * During cooldown, photo capture should skip shutter sound and LED flash to avoid
 * misleading feedback while the camera is coming back up.
 */
public final class CameraRestartCooldown {
    private static final int COOLDOWN_DURATION_MS = 3000;

    private static volatile long cooldownUntilMs = 0;

    private CameraRestartCooldown() {}

    /**
     * Start the cooldown period (call after restarting the camera HAL).
     */
    public static void setCooldownMs(int durationMs) {
        cooldownUntilMs = System.currentTimeMillis() + durationMs;
    }

    /**
     * Start the cooldown with the default duration (3 seconds).
     */
    public static void setCooldown() {
        setCooldownMs(COOLDOWN_DURATION_MS);
    }

    /**
     * Returns true if we are still within the cooldown window (sound/flash should be suppressed).
     */
    public static boolean isActive() {
        return System.currentTimeMillis() < cooldownUntilMs;
    }
}
