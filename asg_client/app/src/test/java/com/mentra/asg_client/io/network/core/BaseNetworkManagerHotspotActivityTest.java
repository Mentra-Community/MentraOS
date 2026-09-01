package com.mentra.asg_client.io.network.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.robolectric.Shadows.shadowOf;

import android.content.Context;
import android.os.Looper;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.network.interfaces.NetworkStateListener;
import java.time.Duration;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

@RunWith(RobolectricTestRunner.class)
public class BaseNetworkManagerHotspotActivityTest {
    private TestNetworkManager manager;

    @Before
    public void setUp() {
        manager = new TestNetworkManager(ApplicationProvider.getApplicationContext());
    }

    @Test
    public void activeHttpTrafficPostponesIdleShutdown() {
        manager.markStarted();
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(100));

        manager.updateHttpActivity();
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(30));

        assertThat(manager.stopCount).isZero();

        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(100));

        assertThat(manager.stopCount).isEqualTo(1);
    }

    @Test
    public void duplicateLifecycleTransitionsDoNotPublishStaleStates() {
        NetworkStateListener listener = mock(NetworkStateListener.class);
        manager.addWifiListener(listener);

        manager.markStarted();
        manager.markStarted();
        manager.markStopped();
        manager.markStopped();

        verify(listener, times(1)).onHotspotStateChanged(true);
        verify(listener, times(1)).onHotspotStateChanged(false);
        assertThat(manager.isHotspotEnabled()).isFalse();
    }

    private static final class TestNetworkManager extends BaseNetworkManager {
        int stopCount;

        TestNetworkManager(Context context) {
            super(context);
        }

        void markStarted() {
            onHotspotStarted("test", "x", "192.168.43.1");
        }

        void markStopped() {
            onHotspotStopped();
        }

        @Override
        public void startHotspot() {}

        @Override
        public void stopHotspot() {
            stopCount++;
            onHotspotStopped();
        }

        @Override
        public void enableWifi() {}

        @Override
        public void disableWifi() {}

        @Override
        public void connectToWifi(String ssid, String password) {}

        @Override
        public void disconnectFromWifi() {}

        @Override
        public boolean forgetWifiNetwork(String ssid) {
            return false;
        }
    }
}
