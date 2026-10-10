package com.mentra.asg_client.io.bes.log;

/**
 * Reset classification measured on Mentra Live hardware (BES repo {@code docs/crash-timestamps.md},
 * "Reset classification and boot identity"):
 *
 * <ul>
 *   <li>{@code reset_hw} 0x01 (hardware watchdog) is how an assert, an exception and a bare
 *       watchdog all restart, always with {@code reset_sw} 0x00800030. Only the presence of a saved
 *       dump tells them apart, and the collector already links a dump to its reset, so a watchdog
 *       restart with no dump is the unexplained, unexpected case.
 *   <li>{@code reset_hw} 0x02 (global reset) is a requested restart: a BES soft reboot
 *       (0x00800030) or an OTA apply (0x00810030). These are expected.
 *   <li>The software boot-mode word's {@code HAL_SW_BOOTMODE_REBOOT_FROM_CRASH} bit
 *       ({@code 1 << 25}) is also treated as abnormal.
 * </ul>
 *
 * Brown-out, button power-on and charger-insert boots have not been measured yet (they need a
 * person at the glasses), so they are treated as expected: an unknown class never raises a noise
 * incident.
 */
public final class DefaultResetClassifier implements ResetClassifier {
    /** HAL_SW_BOOTMODE_REBOOT_FROM_CRASH. */
    static final long SW_REBOOT_FROM_CRASH = 1L << 25;
    /** Hardware watchdog bit of {@code reset_hw}. */
    static final long HW_WATCHDOG = 0x01;
    /** Global (requested) reset bit of {@code reset_hw}. */
    static final long HW_GLOBAL = 0x02;

    @Override
    public boolean isUnexpected(long resetHw, long resetSw) {
        if ((resetSw & SW_REBOOT_FROM_CRASH) != 0) {
            return true;
        }
        return (resetHw & HW_WATCHDOG) != 0 && (resetHw & HW_GLOBAL) == 0;
    }
}
