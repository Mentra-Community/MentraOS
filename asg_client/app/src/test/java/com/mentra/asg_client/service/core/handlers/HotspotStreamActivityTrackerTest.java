package com.mentra.asg_client.service.core.handlers;

import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.os.Handler;
import android.os.Looper;
import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import java.time.Duration;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;

@RunWith(RobolectricTestRunner.class)
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

    @Test
    public void localStreamKeepsRefreshingAfterTheIdleCutoffWithoutPhoneKeepAlives() {
        INetworkManager networkManager = mock(INetworkManager.class);
        when(networkManager.isHotspotEnabled()).thenReturn(true);
        Handler handler = new Handler(Looper.getMainLooper());
        HotspotStreamActivityTracker tracker = new HotspotStreamActivityTracker(networkManager, handler);

        tracker.onStreamStarted(true);
        Shadows.shadowOf(Looper.getMainLooper())
                .idleFor(Duration.ofMillis(HotspotStreamActivityTracker.LOCAL_STREAM_REFRESH_MS * 4));

        // Start plus four 30s ticks — past the 120s hotspot idle cutoff.
        verify(networkManager, times(5)).updateHttpActivity();
    }
}
