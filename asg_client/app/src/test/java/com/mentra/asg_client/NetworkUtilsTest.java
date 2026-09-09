package com.mentra.asg_client;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class NetworkUtilsTest {
    @Test
    public void normalizeMacAddressAcceptsHardwareAddress() {
        assertEquals(
                "2C:BA:CA:25:E6:13",
                NetworkUtils.normalizeMacAddress(" 2c:ba:ca:25:e6:13 "));
    }

    @Test
    public void normalizeMacAddressRejectsUnavailableAddresses() {
        assertEquals("", NetworkUtils.normalizeMacAddress(null));
        assertEquals("", NetworkUtils.normalizeMacAddress("02:00:00:00:00:00"));
        assertEquals("", NetworkUtils.normalizeMacAddress("00:00:00:00:00:00"));
        assertEquals("", NetworkUtils.normalizeMacAddress("not-a-mac"));
    }
}
