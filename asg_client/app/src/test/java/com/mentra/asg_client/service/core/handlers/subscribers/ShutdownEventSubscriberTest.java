package com.mentra.asg_client.service.core.handlers.subscribers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.content.Intent;
import android.os.Looper;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.peripheral.events.ShutdownEvent;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import java.time.Duration;
import java.util.List;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowBuild;

/** Verifies {@link ShutdownEventSubscriber} acknowledges and triggers a graceful shutdown. */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class ShutdownEventSubscriberTest {

    private Application app;
    private AsgClientServiceManager serviceManager;
    private ICompanionTransport transport;
    private ShutdownEventSubscriber subscriber;

    @Before
    public void setUp() {
        app = ApplicationProvider.getApplicationContext();
        serviceManager = mock(AsgClientServiceManager.class);
        transport = mock(ICompanionTransport.class);
        when(serviceManager.getBluetoothManager()).thenReturn(transport);
        when(serviceManager.getContext()).thenReturn(app);
        when(serviceManager.getMediaCaptureService()).thenReturn(null);
        subscriber = new ShutdownEventSubscriber(serviceManager, app);
    }

    @Test
    public void shutdownEvent_sendsAckAndShutsDown() {
        ShadowBuild.setModel("MentraLive");
        when(transport.isConnected()).thenReturn(true);

        subscriber.onMcuEvent(new ShutdownEvent());

        // Acknowledgment (sr_shut) is sent immediately.
        verify(transport).sendMessage(any(byte[].class));

        // Graceful shutdown is performed after a 500ms delay.
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(500));
        List<Intent> intents = shadowOf(app).getBroadcastIntents();
        assertThat(intents).isNotEmpty();
        Intent last = intents.get(intents.size() - 1);
        assertThat(last.getStringExtra("cmd")).isEqualTo("shutdown");
    }

    @Test
    public void shutdownEvent_notConnected_skipsAck() {
        when(transport.isConnected()).thenReturn(false);

        subscriber.onMcuEvent(new ShutdownEvent());

        verify(transport, never()).sendMessage(any(byte[].class));
    }
}
