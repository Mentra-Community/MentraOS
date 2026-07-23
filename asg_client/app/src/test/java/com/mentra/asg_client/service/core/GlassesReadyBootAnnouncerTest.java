package com.mentra.asg_client.service.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.os.Handler;
import android.os.Looper;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesWireFormat;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import java.util.concurrent.TimeUnit;
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
 * for the whole session. The announcer POLLS (transport callbacks can pre-date listener
 * registration) and waits for BES wire caps (the phone's remote wire reset clears its
 * stored caps and gates its handshake on the caps carried in the message).
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class GlassesReadyBootAnnouncerTest {

    private ICommunicationManager communicationManager;
    private K900BluetoothManager k900Manager;
    private GlassesReadyBootAnnouncer announcer;

    @Before
    public void setUp() {
        BesWireFormat.resetBinaryProtocol();
        communicationManager = mock(ICommunicationManager.class);
        when(communicationManager.sendBluetoothResponse(any())).thenReturn(true);
        k900Manager = mock(K900BluetoothManager.class);
        when(k900Manager.isConnected()).thenReturn(true);
        when(k900Manager.isBesBinaryRelaySupported()).thenReturn(true);
        announcer =
                new GlassesReadyBootAnnouncer(
                        () -> communicationManager,
                        () -> k900Manager,
                        new Handler(Looper.getMainLooper()));
    }

    @After
    public void tearDown() {
        BesWireFormat.resetBinaryProtocol();
    }

    /** Runs the immediate first tick posted by start(). */
    private static void firstTick() {
        ShadowLooper.idleMainLooper(0, TimeUnit.MILLISECONDS);
    }

    /** Advances the looper by n poll intervals (n further ticks). */
    private static void advanceTicks(int n) {
        for (int i = 0; i < n; i++) {
            ShadowLooper.idleMainLooper(
                    AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_INTERVAL_MS, TimeUnit.MILLISECONDS);
        }
    }

    private static void drainWholeWindow() {
        firstTick();
        advanceTicks(AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_MAX_TICKS + 2);
    }

    @Test
    public void announcesGlassesReadyWithTimestampAndCapsDecoration() throws Exception {
        announcer.start();
        firstTick();

        ArgumentCaptor<JSONObject> captor = ArgumentCaptor.forClass(JSONObject.class);
        verify(communicationManager).sendBluetoothResponse(captor.capture());
        JSONObject message = captor.getValue();
        assertThat(message.getString("type")).isEqualTo("glasses_ready");
        assertThat(message.getLong("timestamp")).isPositive();
        verify(k900Manager).addPhoneWireCapsIfSupported(any(JSONObject.class));
    }

    @Test
    public void resetsWireEpochBeforeEveryAnnouncement() {
        // Each glasses_ready must be preceded by onTransportReset(): the phone resets its
        // wire epoch on every glasses_ready and re-initiates the handshake, and the local
        // reset clears the wireV2HandshakeSent latch so that re-handshake gets a reply.
        announcer.start();
        drainWholeWindow();

        org.mockito.InOrder inOrder = org.mockito.Mockito.inOrder(k900Manager, communicationManager);
        for (int i = 0; i < AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_ATTEMPTS; i++) {
            inOrder.verify(k900Manager).onTransportReset();
            inOrder.verify(communicationManager).sendBluetoothResponse(any(JSONObject.class));
        }
        verify(k900Manager, times(AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_ATTEMPTS))
                .onTransportReset();
    }

    @Test
    public void waitsForTransportBeforeAnnouncing() {
        when(k900Manager.isConnected()).thenReturn(false);
        announcer.start();
        firstTick();
        advanceTicks(2);
        verify(communicationManager, never()).sendBluetoothResponse(any());

        // Transport comes up mid-window: the next tick announces.
        when(k900Manager.isConnected()).thenReturn(true);
        advanceTicks(1);
        verify(communicationManager, times(1)).sendBluetoothResponse(any(JSONObject.class));
    }

    @Test
    public void waitsForBesWireCapsBeforeAnnouncing() {
        when(k900Manager.isBesBinaryRelaySupported()).thenReturn(false);
        announcer.start();
        firstTick();
        advanceTicks(1);
        verify(communicationManager, never()).sendBluetoothResponse(any());

        // Caps resolve (sr_syvr reply landed): the next tick announces WITH caps.
        when(k900Manager.isBesBinaryRelaySupported()).thenReturn(true);
        advanceTicks(1);
        verify(communicationManager, times(1)).sendBluetoothResponse(any(JSONObject.class));
        verify(k900Manager).addPhoneWireCapsIfSupported(any(JSONObject.class));
    }

    @Test
    public void announcesWithoutCapsAfterWaitBudgetOnLegacyBes() {
        // A legacy BES never advertises binary relay; after the caps-wait budget the
        // announcement goes out anyway (v2 is impossible there, readiness still refreshes).
        when(k900Manager.isBesBinaryRelaySupported()).thenReturn(false);
        announcer.start();
        firstTick();
        advanceTicks(AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_CAPS_WAIT_TICKS - 1);
        verify(communicationManager, never()).sendBluetoothResponse(any());

        advanceTicks(1);
        verify(communicationManager, times(1)).sendBluetoothResponse(any(JSONObject.class));
    }

    @Test
    public void sendsUpToAttemptCapWithinWindow() {
        announcer.start();
        drainWholeWindow();

        verify(communicationManager, times(AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_ATTEMPTS))
                .sendBluetoothResponse(any(JSONObject.class));
    }

    @Test
    public void stopsAnnouncingOnceWireV2Activates() {
        announcer.start();
        firstTick();
        // The phone heard the announcement and completed the binary handshake.
        BesWireFormat.setBinaryProtocolActive(true);
        drainWholeWindow();

        verify(communicationManager, times(1)).sendBluetoothResponse(any(JSONObject.class));
    }

    @Test
    public void startIsOncePerProcess() {
        announcer.start();
        drainWholeWindow();
        announcer.start();
        drainWholeWindow();

        verify(communicationManager, times(AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_ATTEMPTS))
                .sendBluetoothResponse(any(JSONObject.class));
    }
}
