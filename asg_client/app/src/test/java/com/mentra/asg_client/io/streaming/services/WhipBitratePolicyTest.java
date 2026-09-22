package com.mentra.asg_client.io.streaming.services;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import org.junit.Test;
import org.webrtc.PeerConnection;

public class WhipBitratePolicyTest {

    @Test
    public void initialBitrateBps_usesConfiguredStartupSeedBelowMaximum() {
        assertEquals(1_500_000, WhipBitratePolicy.initialBitrateBps(2_500_000));
    }

    @Test
    public void initialBitrateBps_neverExceedsLowConfiguredMaximum() {
        assertEquals(500_000, WhipBitratePolicy.initialBitrateBps(500_000));
    }

    @Test
    public void applyTo_setsInitialAndMaximumPeerConnectionBitrates() {
        PeerConnection peerConnection = mock(PeerConnection.class);
        when(peerConnection.setBitrate(null, 1_500_000, 2_500_000)).thenReturn(true);

        assertTrue(WhipBitratePolicy.applyTo(peerConnection, null, 2_500_000));

        verify(peerConnection).setBitrate(null, 1_500_000, 2_500_000);
    }

    @Test
    public void applyTo_setsRequestedMinimum() {
        PeerConnection peerConnection = mock(PeerConnection.class);
        when(peerConnection.setBitrate(1_300_000, 1_500_000, 1_500_000)).thenReturn(true);

        assertTrue(WhipBitratePolicy.applyTo(peerConnection, 1_300_000, 1_500_000));

        verify(peerConnection).setBitrate(1_300_000, 1_500_000, 1_500_000);
    }

    @Test
    public void minimumBitrateBps_respectsLowerMaximum() {
        assertEquals(Integer.valueOf(1_000_000), WhipBitratePolicy.minimumBitrateBps(1_300_000, 1_000_000));
    }

    @Test
    public void minimumBitrateBps_omittedOrNonpositiveMeansUnset() {
        assertNull(WhipBitratePolicy.minimumBitrateBps(null, 1_500_000));
        assertNull(WhipBitratePolicy.minimumBitrateBps(0, 2_500_000));
    }
    @Test
    public void initialBitrateBps_clampsToBothBoundsAndPreservesDefault() {
        assertEquals(1_500_000, WhipBitratePolicy.initialBitrateBps(null, null, 2_500_000));
        assertEquals(500_000, WhipBitratePolicy.initialBitrateBps(null, null, 500_000));
        assertEquals(400_000, WhipBitratePolicy.initialBitrateBps(400_000, 300_000, 500_000));
        assertEquals(300_000, WhipBitratePolicy.initialBitrateBps(100_000, 300_000, 500_000));
        assertEquals(500_000, WhipBitratePolicy.initialBitrateBps(900_000, 300_000, 500_000));
        assertEquals(1_500_000, WhipBitratePolicy.initialBitrateBps(0, null, 2_500_000));
    }

    @Test
    public void applyTo_passesAllThreeRequestedBitrates() {
        PeerConnection peerConnection = mock(PeerConnection.class);
        when(peerConnection.setBitrate(300_000, 400_000, 500_000)).thenReturn(true);
        assertTrue(WhipBitratePolicy.applyTo(peerConnection, 300_000, 400_000, 500_000));
        verify(peerConnection).setBitrate(300_000, 400_000, 500_000);
    }

}
