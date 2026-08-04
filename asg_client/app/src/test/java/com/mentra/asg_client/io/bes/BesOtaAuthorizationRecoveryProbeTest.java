package com.mentra.asg_client.io.bes;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.os.Looper;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bes.events.BesOtaProgressEvent;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesUartTransportCoordinator;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.Subscribe;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowSystemClock;

@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class BesOtaAuthorizationRecoveryProbeTest {

    private BesOtaManager manager;
    private K900BluetoothManager k900;
    private BesUartTransportCoordinator coordinator;
    private BesUartTransportCoordinator.OperationLease lease;
    private final List<BesOtaProgressEvent> events = new ArrayList<>();

    @Subscribe
    public void onEvent(BesOtaProgressEvent event) {
        events.add(event);
    }

    @Before
    public void setUp() throws Exception {
        k900 = mock(K900BluetoothManager.class);
        coordinator = mock(BesUartTransportCoordinator.class);
        lease = mock(BesUartTransportCoordinator.OperationLease.class);
        when(k900.getTransportCoordinator()).thenReturn(coordinator);
        when(coordinator.promoteOtaAuthorizationToTransfer(lease)).thenReturn(true);
        when(coordinator.returnOtaTransferToAuthorization(lease)).thenReturn(true);
        when(coordinator.writeOta(eq(lease), any(byte[].class))).thenReturn(true);
        when(k900.writeBesOtaAuthorizationMessage(eq(lease), any(byte[].class))).thenReturn(true);

        manager = new BesOtaManager(null, k900, ApplicationProvider.getApplicationContext());
        setField("transportLease", lease);
        setBooleanField("bInit", true);
        setBooleanField("isWaitingForAuthorization", true);
        setBooleanField("authorizationAttempted", true);
        BesOtaManager.isBesOtaInProgress = true;
        events.clear();
        EventBus.getDefault().register(this);
    }

    @After
    public void tearDown() {
        manager.abortIfInProgress();
        EventBus.getDefault().unregister(this);
        BesOtaManager.isBesOtaInProgress = false;
        shadowOf(Looper.getMainLooper()).idle();
    }

    @Test
    public void missingHmOta_rawProtocolReplyContinuesTransfer() {
        manager.onAuthorizationWriteComplete(true, false);

        ShadowSystemClock.advanceBy(Duration.ofSeconds(31));
        shadowOf(Looper.getMainLooper()).idle();

        verify(coordinator).promoteOtaAuthorizationToTransfer(lease);
        verify(coordinator).writeOta(eq(lease), eq(new byte[] {(byte) 0x99, 0, 0, 0, 0}));
        assertThat(events).isEmpty();

        manager.onOtaRecv(new byte[] {(byte) 0x9A, 0, 0, 0, 0}, 5);
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2));

        verify(coordinator).writeOta(eq(lease), eq(new byte[] {(byte) 0x97, 0, 0, 0, 0}));
        verify(coordinator, times(2)).writeOta(eq(lease), any(byte[].class));
        assertThat(events).isEmpty();
        assertThat(BesOtaManager.isBesOtaInProgress).isTrue();
    }

    @Test
    public void missingHmOta_silentRawAndNormalProbesRequireReboot() {
        manager.onAuthorizationWriteComplete(true, true);

        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(40));

        verify(coordinator).promoteOtaAuthorizationToTransfer(lease);
        verify(coordinator, times(3)).writeOta(eq(lease), eq(new byte[] {(byte) 0x99, 0, 0, 0, 0}));
        verify(coordinator).returnOtaTransferToAuthorization(lease);
        verify(k900)
                .writeBesOtaAuthorizationMessage(
                        eq(lease),
                        argThat(
                                data ->
                                        new String(data, StandardCharsets.UTF_8)
                                                .contains("\"C\":\"cs_syvr\"")));
        assertThat(events).hasSize(1);
        assertThat(events.get(0).getErrorMessage())
                .isEqualTo(AsgConstants.BES_OTA_REBOOT_REQUIRED_ERROR);
        assertThat(BesOtaManager.isBesOtaInProgress).isFalse();
    }

    @Test
    public void missingHmOta_normalReplyProvesSafeSingleAuthorizationResend() {
        manager.onAuthorizationWriteComplete(true, true);

        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(34));
        assertThat(events).isEmpty();

        manager.onBesNormalModeProven();

        verify(k900)
                .writeBesOtaAuthorizationMessage(
                        eq(lease),
                        argThat(
                                data ->
                                        new String(data, StandardCharsets.UTF_8)
                                                .contains("\"C\":\"mh_ota\"")));
        assertThat(events).isEmpty();
        assertThat(BesOtaManager.isBesOtaInProgress).isTrue();
    }

    @Test
    public void authorizationResendStillNormal_failsRetryablyWithoutAnotherResend() {
        manager.onAuthorizationWriteComplete(true, true);

        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(34));
        manager.onBesNormalModeProven();
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(34));
        manager.onBesNormalModeProven();

        verify(k900, times(1))
                .writeBesOtaAuthorizationMessage(
                        eq(lease),
                        argThat(
                                data ->
                                        new String(data, StandardCharsets.UTF_8)
                                                .contains("\"C\":\"mh_ota\"")));
        verify(coordinator).endOta(lease);
        assertThat(events).hasSize(1);
        assertThat(events.get(0).getErrorMessage()).isEqualTo("BES chip did not enter OTA mode");
        assertThat(BesOtaManager.isBesOtaInProgress).isFalse();
    }

    private void setBooleanField(String name, boolean value) throws Exception {
        setField(name, value);
    }

    private void setField(String name, Object value) throws Exception {
        Field field = BesOtaManager.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(manager, value);
    }
}
