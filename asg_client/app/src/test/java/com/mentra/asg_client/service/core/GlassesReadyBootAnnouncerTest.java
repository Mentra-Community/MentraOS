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
import com.mentra.asg_client.service.core.processors.CommandProcessor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
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
 * The boot announcement re-syncs a phone whose BLE link survived an asg process restart
 * (incident rep_01KY6BJ0B7A4RBMQ7VN39KAE5E): without it the phone skips phone_ready and
 * the v2 wire handshake never re-runs, leaving the new process on v1 TX for the whole
 * session. The announcer POLLS (transport callbacks can pre-date listener registration),
 * waits for BES wire caps (the phone's remote wire reset clears its stored caps and gates
 * its handshake on the caps in glasses_ready), and delivers by driving the STANDARD
 * phone_ready flow so every handler side effect (wire epoch reset, WiFi/hotspot status,
 * RGB LED authority) runs identically to a real phone_ready.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class GlassesReadyBootAnnouncerTest {

    private CommandProcessor commandProcessor;
    private K900BluetoothManager k900Manager;
    private GlassesReadyBootAnnouncer announcer;

    @Before
    public void setUp() {
        BesWireFormat.resetBinaryProtocol();
        commandProcessor = mock(CommandProcessor.class);
        k900Manager = mock(K900BluetoothManager.class);
        when(k900Manager.isConnected()).thenReturn(true);
        when(k900Manager.isBesBinaryRelaySupported()).thenReturn(true);
        announcer =
                new GlassesReadyBootAnnouncer(
                        () -> commandProcessor,
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
    public void announcesByDrivingThePhoneReadyFlow() throws Exception {
        announcer.start();
        firstTick();

        // The synthetic command must carry no mId: the dispatch would otherwise ack a
        // message the phone never sent (and track it for duplicate suppression).
        ArgumentCaptor<JSONObject> captor = ArgumentCaptor.forClass(JSONObject.class);
        verify(commandProcessor).processJsonCommand(captor.capture());
        JSONObject synthetic = captor.getValue();
        assertThat(synthetic.getString("type")).isEqualTo("phone_ready");
        assertThat(synthetic.has("mId")).isFalse();
        assertThat(synthetic.getBoolean("boot_announce")).isTrue();
    }

    @Test
    public void waitsForTransportBeforeAnnouncing() {
        when(k900Manager.isConnected()).thenReturn(false);
        announcer.start();
        firstTick();
        advanceTicks(2);
        verify(commandProcessor, never()).processJsonCommand(any());

        // Transport comes up mid-window: the next tick announces.
        when(k900Manager.isConnected()).thenReturn(true);
        advanceTicks(1);
        verify(commandProcessor, times(1)).processJsonCommand(any(JSONObject.class));
    }

    @Test
    public void waitsForCommandProcessorBeforeAnnouncing() {
        AtomicReference<CommandProcessor> processorRef = new AtomicReference<>(null);
        announcer =
                new GlassesReadyBootAnnouncer(
                        processorRef::get, () -> k900Manager, new Handler(Looper.getMainLooper()));
        announcer.start();
        firstTick();
        advanceTicks(1);

        // Service init finishes mid-window: the next tick announces.
        processorRef.set(commandProcessor);
        advanceTicks(1);
        verify(commandProcessor, times(1)).processJsonCommand(any(JSONObject.class));
    }

    @Test
    public void waitsForBesWireCapsBeforeAnnouncing() {
        when(k900Manager.isBesBinaryRelaySupported()).thenReturn(false);
        announcer.start();
        firstTick();
        advanceTicks(1);
        verify(commandProcessor, never()).processJsonCommand(any());

        // Caps resolve (sr_syvr reply landed): the next tick announces.
        when(k900Manager.isBesBinaryRelaySupported()).thenReturn(true);
        advanceTicks(1);
        verify(commandProcessor, times(1)).processJsonCommand(any(JSONObject.class));
    }

    @Test
    public void announcesWithoutCapsAfterWaitBudgetOnLegacyBes() {
        // A legacy BES never advertises binary relay; after the caps-wait budget the
        // announcement goes out anyway (v2 is impossible there, readiness still refreshes).
        when(k900Manager.isBesBinaryRelaySupported()).thenReturn(false);
        announcer.start();
        firstTick();
        advanceTicks(AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_CAPS_WAIT_TICKS - 1);
        verify(commandProcessor, never()).processJsonCommand(any());

        advanceTicks(1);
        verify(commandProcessor, times(1)).processJsonCommand(any(JSONObject.class));
    }

    @Test
    public void transportGapRestartsTheCapsWait() {
        // Serial close clears the negotiated BES caps, so caps-wait progress from before
        // a UART blip must not count toward announcing caps-less right after the reopen.
        when(k900Manager.isBesBinaryRelaySupported()).thenReturn(false);
        announcer.start();
        firstTick();
        advanceTicks(AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_CAPS_WAIT_TICKS - 1);

        // UART blip: one disconnected tick, then reconnected, still capsless.
        when(k900Manager.isConnected()).thenReturn(false);
        advanceTicks(1);
        when(k900Manager.isConnected()).thenReturn(true);

        // The full caps-wait budget applies again after the gap.
        advanceTicks(AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_CAPS_WAIT_TICKS);
        verify(commandProcessor, never()).processJsonCommand(any());

        advanceTicks(1);
        verify(commandProcessor, times(1)).processJsonCommand(any(JSONObject.class));
    }

    @Test
    public void stopCancelsScheduledTicks() {
        announcer.start();
        firstTick();
        verify(commandProcessor, times(1)).processJsonCommand(any(JSONObject.class));

        // Service teardown mid-window: no further ticks may run.
        announcer.stop();
        drainWholeWindow();
        verify(commandProcessor, times(1)).processJsonCommand(any(JSONObject.class));
    }

    @Test
    public void sendsUpToAttemptCapWithinWindow() {
        announcer.start();
        drainWholeWindow();

        verify(commandProcessor, times(AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_ATTEMPTS))
                .processJsonCommand(any(JSONObject.class));
    }

    @Test
    public void stopsAnnouncingOnceWireV2Activates() {
        announcer.start();
        firstTick();
        // The phone heard the announcement and completed the binary handshake.
        BesWireFormat.setBinaryProtocolActive(true);
        drainWholeWindow();

        verify(commandProcessor, times(1)).processJsonCommand(any(JSONObject.class));
    }

    @Test
    public void startIsOncePerProcess() {
        announcer.start();
        drainWholeWindow();
        announcer.start();
        drainWholeWindow();

        verify(commandProcessor, times(AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_ATTEMPTS))
                .processJsonCommand(any(JSONObject.class));
    }
}
