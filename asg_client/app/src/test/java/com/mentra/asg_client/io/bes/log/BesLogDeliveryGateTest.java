package com.mentra.asg_client.io.bes.log;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.After;
import org.junit.Test;

public class BesLogDeliveryGateTest {
    @After
    public void restoreDefault() {
        BesLogDeliveryGate.setForTest(null);
    }

    @Test
    public void shipsOff() {
        assertFalse("BES log delivery must ship off", BesLogDeliveryGate.DEFAULT_ENABLED);
        BesLogDeliveryGate.setForTest(null);
        assertFalse(BesLogDeliveryGate.isEnabled());
    }

    @Test
    public void overrideWinsOverDefault() {
        BesLogDeliveryGate.setForTest(true);
        assertTrue(BesLogDeliveryGate.isEnabled());
        BesLogDeliveryGate.setForTest(false);
        assertFalse(BesLogDeliveryGate.isEnabled());
    }
}
