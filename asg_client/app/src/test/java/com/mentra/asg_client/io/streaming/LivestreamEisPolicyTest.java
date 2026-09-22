package com.mentra.asg_client.io.streaming;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class LivestreamEisPolicyTest {

    @Test
    public void fiveFortyPMissesTheFiveHundredKGate() {
        assertFalse(LivestreamEisPolicy.shouldEnable(960, 540));
        assertFalse(LivestreamEisPolicy.shouldEnable(540, 960));
    }

    @Test
    public void sevenTwentyPStaysOff() {
        assertFalse(LivestreamEisPolicy.shouldEnable(1280, 720));
        assertFalse(LivestreamEisPolicy.shouldEnable(720, 1280));
    }

    @Test
    public void threeSixtyPIsUnderTheGate() {
        assertTrue(LivestreamEisPolicy.shouldEnable(640, 360));
    }

    @Test
    public void invalidSizesStayOff() {
        assertFalse(LivestreamEisPolicy.shouldEnable(0, 540));
        assertFalse(LivestreamEisPolicy.shouldEnable(960, 0));
    }
}
