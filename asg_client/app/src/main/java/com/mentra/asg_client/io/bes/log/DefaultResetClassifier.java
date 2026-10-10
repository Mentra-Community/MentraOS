package com.mentra.asg_client.io.bes.log;

/**
 * Conservative default until the firmware's reset table lands: a reset is unexpected only when the
 * software boot-mode word carries a bit the firmware sets for an abnormal restart. Everything else
 * (power-on, requested reboot, OTA, an all-zero or unrecognized code) is treated as expected and
 * raises no incident, so an unknown classification can never create a noise incident.
 *
 * <p>Source: {@code HAL_SW_BOOTMODE_REBOOT_FROM_CRASH} ({@code 1 << 25}) in the BES
 * {@code platform/hal/hal_bootmode.h}. Watchdog and brown-out resets that leave {@code reset_sw}
 * clear are not recognized here: they need the {@code reset_hw} table from
 * {@code docs/crash-timestamps.md}, to be supplied through {@link ResetClassifier}.
 */
public final class DefaultResetClassifier implements ResetClassifier {
    /** HAL_SW_BOOTMODE_REBOOT_FROM_CRASH. */
    static final long SW_REBOOT_FROM_CRASH = 1L << 25;

    @Override
    public boolean isUnexpected(long resetHw, long resetSw) {
        return (resetSw & SW_REBOOT_FROM_CRASH) != 0;
    }
}
