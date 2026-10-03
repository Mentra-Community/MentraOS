package com.mentra.asg_client.io.streaming.services;

import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.CALLS_REAL_METHODS;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.app.Application;
import android.os.SystemClock;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.io.hardware.managers.K900HardwareManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

/** Runs the real stream monitor and shared hardware policy, with only final teardown stubbed. */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class StreamingBatteryPolicyTest {
    private static void set(Object target, String name, Object value) throws Exception {
        Field field = target.getClass().getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private Runnable monitor(Object service, K900HardwareManager hardware) throws Exception {
        set(service, "mStateLock", new Object());
        set(service, "mStateManager", mock(IStateManager.class));
        set(service, "mHardwareManager", hardware);
        set(service, "mIsStreaming", true);
        Field state = service.getClass().getDeclaredField("mStreamState");
        state.setAccessible(true);
        state.set(service, Enum.valueOf((Class) state.getType(), "STREAMING"));
        Method start = service.getClass().getDeclaredMethod("startBatteryMonitoring");
        start.setAccessible(true);
        start.invoke(service);
        Field runnable = service.getClass().getDeclaredField("mBatteryCheckRunnable");
        runnable.setAccessible(true);
        return (Runnable) runnable.get(service);
    }

    private K900HardwareManager chargingHardware() {
        K900HardwareManager hardware = new K900HardwareManager(RuntimeEnvironment.getApplication());
        K900BluetoothManager transport = mock(K900BluetoothManager.class);
        when(transport.isConnected()).thenReturn(true);
        when(transport.isCurrentUartEvidence(anyLong())).thenReturn(true);
        hardware.setTransport(transport);
        hardware.notifyBatteryReading(4, 3700, true, SystemClock.elapsedRealtime());
        return hardware;
    }

    @Test
    public void rtmpChargerRemovalStopsThroughExistingMonitor() throws Exception {
        RtmpStreamingService service = mock(RtmpStreamingService.class, CALLS_REAL_METHODS);
        doNothing().when(service).stopStreaming();
        K900HardwareManager hardware = chargingHardware();
        Runnable monitor = monitor(service, hardware);
        monitor.run();
        verify(service, never()).stopStreaming();
        hardware.notifyBatteryReading(4, 3700, false, SystemClock.elapsedRealtime());
        monitor.run();
        verify(service).stopStreaming();
    }

    @Test
    public void srtChargerRemovalStopsThroughExistingMonitor() throws Exception {
        SrtStreamingService service = mock(SrtStreamingService.class, CALLS_REAL_METHODS);
        doNothing().when(service).stopStreaming();
        K900HardwareManager hardware = chargingHardware();
        Runnable monitor = monitor(service, hardware);
        monitor.run();
        verify(service, never()).stopStreaming();
        hardware.notifyBatteryReading(4, 3700, false, SystemClock.elapsedRealtime());
        monitor.run();
        verify(service).stopStreaming();
    }
}
