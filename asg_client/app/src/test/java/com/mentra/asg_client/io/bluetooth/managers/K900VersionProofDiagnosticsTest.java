package com.mentra.asg_client.io.bluetooth.managers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.CALLS_REAL_METHODS;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.os.SystemClock;

import com.mentra.asg_client.io.bes.BesOtaStateStore;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesUartTransportCoordinator;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.SerialSession;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLog;
import org.robolectric.shadows.ShadowSystemClock;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.time.Duration;

/** Uses the production receive callback without constructing serial hardware. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class K900VersionProofDiagnosticsTest {
    @Test
    public void versionProofRecordsReceiveElapsedTimeBeforeSlowStateRead() throws Exception {
        K900BluetoothManager manager = mock(K900BluetoothManager.class, CALLS_REAL_METHODS);
        BesOtaStateStore store = mock(BesOtaStateStore.class);
        BesOtaStateStore.Snapshot snapshot = mock(BesOtaStateStore.Snapshot.class);
        when(snapshot.toDiagnosticString()).thenReturn("state=IDLE");
        when(store.read())
                .thenAnswer(
                        call -> {
                            ShadowSystemClock.advanceBy(Duration.ofMillis(500));
                            return snapshot;
                        });
        field(manager, "besOtaStateStore", store);
        field(manager, "currentBootId", "bf8ce063-04f8-4d9a-810e-1b887b864673");
        ShadowSystemClock.advanceBy(Duration.ofMillis(25));
        long receivedAt = SystemClock.elapsedRealtime();
        ShadowLog.clear();

        Method receive =
                K900BluetoothManager.class.getDeclaredMethod(
                        "reconcileBesOtaVersionProof", String.class);
        receive.setAccessible(true);
        receive.invoke(manager, "26.9.23.0");

        assertThat(SystemClock.elapsedRealtime()).isEqualTo(receivedAt + 500);
        assertThat(ShadowLog.getLogsForTag("K900BluetoothManager"))
                .extracting(item -> item.msg)
                .contains(
                        "BES_OTA_DIAG version_proof actual=26.9.23.0"
                                + " current_boot=bf8ce063-04f8-4d9a-810e-1b887b864673"
                                + " elapsed_realtime_ms="
                                + receivedAt
                                + " disposition=ignored reason=invalid_or_idle_state"
                                + " snapshot={state=IDLE}");
        verify(store, never()).completeVersionProofAfterRestart(any(), any(), any());
    }

    @Test
    public void retiredUartSessionCannotProduceFreshVersionDiagnostic() throws Exception {
        K900BluetoothManager manager = mock(K900BluetoothManager.class, CALLS_REAL_METHODS);
        BesOtaStateStore store = mock(BesOtaStateStore.class);
        BesUartTransportCoordinator coordinator = mock(BesUartTransportCoordinator.class);
        when(coordinator.onSystemVersion(anyString(), any(), any()))
                .thenReturn(BesUartTransportCoordinator.SystemVersionResult.IGNORED);
        field(manager, "transportCoordinator", coordinator);
        field(manager, "besOtaStateStore", store);
        ShadowLog.clear();

        Method receive =
                K900BluetoothManager.class.getDeclaredMethod(
                        "handleSrSyvrResponse", byte[].class, SerialSession.class);
        receive.setAccessible(true);
        receive.invoke(
                manager,
                "{\"C\":\"sr_syvr\",\"B\":{\"version\":\"26.9.23.0\"}}"
                        .getBytes(StandardCharsets.UTF_8),
                mock(SerialSession.class));

        assertThat(ShadowLog.getLogsForTag("K900BluetoothManager"))
                .noneMatch(item -> item.msg.contains("BES_OTA_DIAG version_proof"));
        verify(store, never()).read();
    }

    private static void field(Object target, String name, Object value) throws Exception {
        Field field = K900BluetoothManager.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }
}
