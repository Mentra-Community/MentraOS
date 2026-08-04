package com.mentra.asg_client.io.network.utils;

/**
 * Chooses the WiFi security configuration for a connect attempt from the AP's advertised
 * scan capabilities instead of inferring it from password presence. Password-presence
 * inference configures WPA3-only networks as legacy PSK (never associates) and can never
 * express SAE; the closed K900 SystemUI path guesses and has saved WPA2/WPA3-transition
 * networks as OPEN in the field.
 *
 * <p>Pure logic, separated from {@code K900NetworkManager} so it is unit-testable on the
 * JVM (the join itself needs a system-signed build on hardware).
 */
public final class WifiSecurityChooser {

    public enum Security {
        /** No password supplied — open (or OWE-transition open leg) network. */
        OPEN,
        /** WPA2, or WPA2/WPA3-transition where the PSK leg associates on both. */
        PSK,
        /** WPA3-only AP — legacy PSK association is rejected; needs SAE with PMF. */
        SAE
    }

    private WifiSecurityChooser() {}

    /**
     * @param password the password supplied by the user (may be null/empty)
     * @param scanCapabilities the matching ScanResult's capabilities string, or null when
     *     the SSID was not found in current scan results (hidden network, stale scan)
     */
    public static Security choose(String password, String scanCapabilities) {
        boolean hasPassword = password != null && !password.isEmpty();
        if (!hasPassword) {
            return Security.OPEN;
        }
        if (scanCapabilities != null
                && scanCapabilities.contains("SAE")
                && !scanCapabilities.contains("PSK")) {
            return Security.SAE;
        }
        // WPA2, WPA2/WPA3-transition, or unknown SSID (fall back to the widest-compat PSK).
        return Security.PSK;
    }
}
