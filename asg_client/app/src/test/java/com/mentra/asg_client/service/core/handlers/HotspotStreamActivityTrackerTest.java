package com.mentra.asg_client.service.core.handlers;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.io.network.interfaces.INetworkManager;

import org.junit.Test;

public class HotspotStreamActivityTrackerTest {
    @Test
    public void localStreamStartAndKeepAliveRefreshHotspotActivity() {
        INetworkManager networkManager = mock(INetworkManager.class);
        when(networkManager.isHotspotEnabled()).thenReturn(true);
        HotspotStreamActivityTracker tracker = new HotspotStreamActivityTracker(networkManager);

        tracker.onStreamStarted(true);
        tracker.onKeepAlive();

        verify(networkManager, times(2)).updateHttpActivity();
    }

    @Test
    public void stoppedStreamNoLongerRefreshesHotspotActivity() {
        INetworkManager networkManager = mock(INetworkManager.class);
        when(networkManager.isHotspotEnabled()).thenReturn(true);
        HotspotStreamActivityTracker tracker = new HotspotStreamActivityTracker(networkManager);

        tracker.onStreamStarted(true);
        tracker.onStreamStopped();
        tracker.onKeepAlive();

        verify(networkManager).updateHttpActivity();
    }

    @Test
    public void staStreamDoesNotKeepUnrelatedHotspotAlive() {
        INetworkManager networkManager = mock(INetworkManager.class);
        when(networkManager.isHotspotEnabled()).thenReturn(true);
        HotspotStreamActivityTracker tracker = new HotspotStreamActivityTracker(networkManager);

        tracker.onStreamStarted(false);
        tracker.onKeepAlive();

        verify(networkManager, never()).updateHttpActivity();
    }

    @Test
    public void localStreamDoesNotRefreshDisabledHotspot() {
        INetworkManager networkManager = mock(INetworkManager.class);
        when(networkManager.isHotspotEnabled()).thenReturn(false);
        HotspotStreamActivityTracker tracker = new HotspotStreamActivityTracker(networkManager);

        tracker.onStreamStarted(true);
        tracker.onKeepAlive();

        verify(networkManager, never()).updateHttpActivity();
    }
}
