package com.mentra.asg_client.camera.lifecycle;

import static org.assertj.core.api.Assertions.assertThat;

import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraDevice;
import android.os.Handler;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.Mockito;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class CameraCoordinatorTest {

    @Test
    public void startBackgroundThread_returnsHandler() {
        CameraCoordinator coordinator = new CameraCoordinator();

        Handler handler = coordinator.startBackgroundThread("CameraCoordinatorTest");

        assertThat(handler).isNotNull();
        assertThat(coordinator.backgroundHandler()).isSameAs(handler);

        coordinator.stopBackgroundThread();
        assertThat(coordinator.backgroundHandler()).isNull();
    }

    @Test
    public void startKeepAlive_marksCameraKeptAlive() {
        CameraCoordinator coordinator = new CameraCoordinator();

        coordinator.startKeepAlive(10_000, () -> false, () -> {});

        assertThat(coordinator.isCameraKeptAlive()).isTrue();
        coordinator.cancelKeepAlive();
    }

    @Test
    public void closeIfKeptAlive_runsCloseActionAndClearsFlag() {
        CameraCoordinator coordinator = new CameraCoordinator();
        AtomicBoolean closed = new AtomicBoolean(false);
        coordinator.startKeepAlive(10_000, () -> false, () -> {});

        boolean didClose = coordinator.closeIfKeptAlive(() -> closed.set(true));

        assertThat(didClose).isTrue();
        assertThat(closed).isTrue();
        assertThat(coordinator.isCameraKeptAlive()).isFalse();
    }

    @Test
    public void closeIfKeptAlive_whenNotKeptAlive_noops() {
        CameraCoordinator coordinator = new CameraCoordinator();
        AtomicBoolean closed = new AtomicBoolean(false);

        boolean didClose = coordinator.closeIfKeptAlive(() -> closed.set(true));

        assertThat(didClose).isFalse();
        assertThat(closed).isFalse();
    }

    @Test
    public void keepAliveExpiry_runsExpireAction() throws InterruptedException {
        CameraCoordinator coordinator = new CameraCoordinator();
        CountDownLatch expired = new CountDownLatch(1);

        coordinator.startKeepAlive(1, () -> false, expired::countDown);

        assertThat(expired.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(coordinator.isCameraKeptAlive()).isFalse();
    }

    @Test
    public void deviceAndSession_accessorsTrackConfiguredCamera() {
        CameraCoordinator coordinator = new CameraCoordinator();
        CameraDevice device = Mockito.mock(CameraDevice.class);
        CameraCaptureSession session = Mockito.mock(CameraCaptureSession.class);

        coordinator.setDevice(device);
        coordinator.setSession(session);

        assertThat(coordinator.device()).isSameAs(device);
        assertThat(coordinator.session()).isSameAs(session);
        assertThat(coordinator.hasConfiguredCamera()).isTrue();
    }

    @Test
    public void clearDeviceAndSession_resetsConfiguredCamera() {
        CameraCoordinator coordinator = new CameraCoordinator();
        coordinator.setDevice(Mockito.mock(CameraDevice.class));
        coordinator.setSession(Mockito.mock(CameraCaptureSession.class));

        coordinator.clearDevice();
        coordinator.clearSession();

        assertThat(coordinator.device()).isNull();
        assertThat(coordinator.session()).isNull();
        assertThat(coordinator.hasConfiguredCamera()).isFalse();
    }

    @Test
    public void closeDeviceAndSession_closesAndClearsBoth() {
        CameraCoordinator coordinator = new CameraCoordinator();
        CameraDevice device = Mockito.mock(CameraDevice.class);
        CameraCaptureSession session = Mockito.mock(CameraCaptureSession.class);
        coordinator.setDevice(device);
        coordinator.setSession(session);

        coordinator.closeDeviceAndSession();

        Mockito.verify(session).close();
        Mockito.verify(device).close();
        assertThat(coordinator.device()).isNull();
        assertThat(coordinator.session()).isNull();
    }
}
