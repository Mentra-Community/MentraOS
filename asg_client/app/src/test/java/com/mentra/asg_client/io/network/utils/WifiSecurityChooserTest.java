package com.mentra.asg_client.io.network.utils;

import static org.junit.Assert.assertEquals;

import com.mentra.asg_client.io.network.utils.WifiSecurityChooser.Security;
import org.junit.Test;

public class WifiSecurityChooserTest {

    @Test
    public void noPassword_isOpen_regardlessOfCapabilities() {
        assertEquals(Security.OPEN, WifiSecurityChooser.choose(null, "[ESS]"));
        assertEquals(Security.OPEN, WifiSecurityChooser.choose("", "[WPA2-PSK-CCMP][ESS]"));
        assertEquals(Security.OPEN, WifiSecurityChooser.choose("", null));
    }

    @Test
    public void wpa2Only_isPsk() {
        assertEquals(
                Security.PSK,
                WifiSecurityChooser.choose("pw", "[WPA2-PSK-CCMP][RSN-PSK-CCMP][ESS]"));
    }

    @Test
    public void wpa2Wpa3Transition_isPsk() {
        // Transition APs advertise both legs; the PSK leg associates on both, so PSK is
        // the widest-compatibility correct choice (the field bug saved these as OPEN).
        assertEquals(
                Security.PSK,
                WifiSecurityChooser.choose(
                        "pw", "[WPA2-PSK+SAE-CCMP][RSN-PSK+SAE-CCMP][ESS][MFPC]"));
    }

    @Test
    public void wpa3Only_isSae() {
        assertEquals(
                Security.SAE,
                WifiSecurityChooser.choose("pw", "[RSN-SAE-CCMP][ESS][MFPC][MFPR]"));
    }

    @Test
    public void unknownSsid_fallsBackToPsk() {
        // Hidden network / stale scan: no capabilities available. PSK preserves the
        // pre-fix behavior for password-protected networks.
        assertEquals(Security.PSK, WifiSecurityChooser.choose("pw", null));
    }
}
