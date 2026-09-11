package com.mentra.asg_client.io.streaming.services;

import static org.junit.Assert.assertEquals;
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

        assertTrue(WhipBitratePolicy.applyTo(peerConnection, 2_500_000));

        verify(peerConnection).setBitrate(null, 1_500_000, 2_500_000);
    }
}
