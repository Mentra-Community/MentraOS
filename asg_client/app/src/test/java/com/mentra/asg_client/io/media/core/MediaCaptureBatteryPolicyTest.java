package com.mentra.asg_client.io.media.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.CALLS_REAL_METHODS;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockStatic;
import static org.mockito.Mockito.when;

import android.app.Application;
import android.content.Context;
import android.os.SystemClock;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.camera.CameraNeoService;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.io.hardware.managers.K900HardwareManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.time.Duration;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.MockedStatic;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowSystemClock;

/** Real video battery monitor and stop lifecycle; only the final Android camera call is mocked. */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class MediaCaptureBatteryPolicyTest {
    private static void set(Object target, String name, Object value) throws Exception {
        Field field = MediaCaptureService.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(target, value);
    }

    @Test
    public void lossExpiryAndCriticalFloorDispatchTheNormalRecordingStop() throws Exception {
        for (String reason : new String[] {"charger_removed", "expired", "critical_floor"}) {
            Context context = RuntimeEnvironment.getApplication();
            K900HardwareManager hardware = new K900HardwareManager(context);
            K900BluetoothManager transport = mock(K900BluetoothManager.class);
            when(transport.isConnected()).thenReturn(true);
            when(transport.isCurrentUartEvidence(anyLong())).thenReturn(true);
            hardware.setTransport(transport);
            hardware.notifyBatteryReading(4, 3700, true, SystemClock.elapsedRealtime());

            MediaCaptureService service = mock(MediaCaptureService.class, CALLS_REAL_METHODS);
            doNothing().when(service).playBatteryLowSound();
            VideoRecordingLifecycle lifecycle = new VideoRecordingLifecycle();
            lifecycle.requestStart(() -> {});
            lifecycle.recordingStarted();
            set(service, "mStopLock", new Object());
            set(service, "videoRecordingLifecycle", lifecycle);
            set(service, "mStateManager", mock(IStateManager.class));
            set(service, "hardwareManager", hardware);
            set(service, "mContext", context);
            set(service, "isRecordingVideo", true);
            set(service, "currentVideoId", "recording");
            Method start = MediaCaptureService.class.getDeclaredMethod("startBatteryMonitoring");
            start.setAccessible(true);
            start.invoke(service);
            Field runnable = MediaCaptureService.class.getDeclaredField("mBatteryCheckRunnable");
            runnable.setAccessible(true);
            Runnable monitor = (Runnable) runnable.get(service);

            try (MockedStatic<CameraNeoService> camera = mockStatic(CameraNeoService.class)) {
                monitor.run();
                camera.verifyNoInteractions();
                assertThat(lifecycle.isStopping()).isFalse();
                if (reason.equals("expired")) {
                    ShadowSystemClock.advanceBy(Duration.ofMillis(AsgConstants.CAMERA_ACTIVE_CHARGE_MAX_AGE_MS));
                } else {
                    hardware.notifyBatteryReading(reason.equals("critical_floor") ? 3 : 4,
                            3700, reason.equals("critical_floor"), SystemClock.elapsedRealtime());
                }
                monitor.run();
                assertThat(lifecycle.isStopping()).isTrue();
                camera.verify(() -> CameraNeoService.stopVideoRecording(context, "recording"));
            }
        }
    }
}
