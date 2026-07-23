package com.mentra.asg_client.service.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.os.Handler;
import android.os.Looper;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesWireFormat;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.ArgumentCaptor;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLooper;

/**
 * The glasses_ready boot announcement re-syncs a phone whose BLE link survived an asg
 * process restart (incident rep_01KY6BJ0B7A4RBMQ7VN39KAE5E): without it the phone skips
 * phone_ready and the v2 wire handshake never re-runs, leaving the new process on v1 TX
 * for the whole session.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class GlassesReadyBootAnnouncerTest {

    private ICommunicationManager communicationManager;
    private GlassesReadyBootAnnouncer announcer;

    @Before
    public void setUp() {
        BesWireFormat.resetBinaryProtocol();
        communicationManager = mock(ICommunicationManager.class);
        when(communicationManager.sendBluetoothResponse(any())).thenReturn(true);
        announcer =
                new GlassesReadyBootAnnouncer(
                        communicationManager, () -> null, new Handler(Looper.getMainLooper()));
    }

    @After
    public void tearDown() {
        BesWireFormat.resetBinaryProtocol();
    }

    private static void drainAllScheduledAttempts() {
        for (int i = 0; i < AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_ATTEMPTS; i++) {
            ShadowLooper.idleMainLooper(
                    AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_INTERVAL_MS,
                    java.util.concurrent.TimeUnit.MILLISECONDS);
        }
    }

    @Test
    public void announcesGlassesReadyWithTimestamp() throws Exception {
        announcer.onTransportUp();

        ArgumentCaptor<JSONObject> captor = ArgumentCaptor.forClass(JSONObject.class);
        verify(communicationManager).sendBluetoothResponse(captor.capture());
        JSONObject message = captor.getValue();
        assertThat(message.getString("type")).isEqualTo("glasses_ready");
        assertThat(message.getLong("timestamp")).isPositive();
    }

    @Test
    public void includesWireCapsWhenK900ManagerAvailable() {
        K900BluetoothManager k900Manager = mock(K900BluetoothManager.class);
        announcer =
                new GlassesReadyBootAnnouncer(
                        communicationManager,
                        () -> k900Manager,
                        new Handler(Looper.getMainLooper()));

        announcer.onTransportUp();

        verify(k900Manager).addPhoneWireCapsIfSupported(any(JSONObject.class));
    }

    @Test
    public void retriesUntilAttemptCapWhileWireV2Inactive() {
        announcer.onTransportUp();
        drainAllScheduledAttempts();

        verify(communicationManager, times(AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_ATTEMPTS))
                .sendBluetoothResponse(any(JSONObject.class));
    }

    @Test
    public void stopsRetryingOnceWireV2Activates() {
        announcer.onTransportUp();
        // The phone heard the announcement and completed the binary handshake.
        BesWireFormat.setBinaryProtocolActive(true);
        drainAllScheduledAttempts();

        verify(communicationManager, times(1)).sendBluetoothResponse(any(JSONObject.class));
    }

    @Test
    public void announcesOnlyOncePerProcessAcrossTransportEdges() {
        announcer.onTransportUp();
        drainAllScheduledAttempts();
        announcer.onTransportUp();
        drainAllScheduledAttempts();

        verify(communicationManager, times(AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_ATTEMPTS))
                .sendBluetoothResponse(any(JSONObject.class));
    }
}
