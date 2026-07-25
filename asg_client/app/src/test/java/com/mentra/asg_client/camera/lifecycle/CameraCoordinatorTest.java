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
import java.util.concurrent.atomic.AtomicReference;

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
    public void keepAliveExpiry_runsExpireActionOnCameraThread() throws InterruptedException {
        CameraCoordinator coordinator = new CameraCoordinator();
        coordinator.startBackgroundThread("CameraCoordinatorTest");
        CountDownLatch expired = new CountDownLatch(1);
        AtomicReference<String> expiredOn = new AtomicReference<>();

        coordinator.startKeepAlive(
                1,
                () -> false,
                () -> {
                    expiredOn.set(Thread.currentThread().getName());
                    expired.countDown();
                });

        assertThat(expired.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(coordinator.isCameraKeptAlive()).isFalse();
        assertThat(expiredOn.get()).isEqualTo("CameraCoordinatorTest");
        coordinator.stopBackgroundThread();
    }

    @Test
    public void keepAliveExpiry_withoutCameraThread_skipsTeardown() throws InterruptedException {
        CameraCoordinator coordinator = new CameraCoordinator();
        CountDownLatch expired = new CountDownLatch(1);

        coordinator.startKeepAlive(1, () -> false, expired::countDown);

        // No camera thread means service teardown already owns the close; the raw
        // Timer thread must never run camera teardown itself.
        assertThat(expired.await(300, TimeUnit.MILLISECONDS)).isFalse();
    }

    @Test
    public void runOnCameraThread_offThread_postsToCameraThread() throws InterruptedException {
        CameraCoordinator coordinator = new CameraCoordinator();
        coordinator.startBackgroundThread("CameraCoordinatorTest");
        CountDownLatch ran = new CountDownLatch(1);
        AtomicReference<String> ranOn = new AtomicReference<>();

        coordinator.runOnCameraThread(
                () -> {
                    ranOn.set(Thread.currentThread().getName());
                    ran.countDown();
                });

        assertThat(ran.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(ranOn.get()).isEqualTo("CameraCoordinatorTest");
        coordinator.stopBackgroundThread();
    }

    @Test
    public void runOnCameraThread_onCameraThread_runsInline() throws InterruptedException {
        CameraCoordinator coordinator = new CameraCoordinator();
        Handler handler = coordinator.startBackgroundThread("CameraCoordinatorTest");
        CountDownLatch done = new CountDownLatch(1);
        AtomicBoolean ranInline = new AtomicBoolean(false);

        handler.post(
                () -> {
                    AtomicBoolean ran = new AtomicBoolean(false);
                    coordinator.runOnCameraThread(() -> ran.set(true));
                    // Inline execution means the action completed before this returns.
                    ranInline.set(ran.get());
                    done.countDown();
                });

        assertThat(done.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(ranInline).isTrue();
        coordinator.stopBackgroundThread();
    }

    @Test
    public void isOnCameraThread_reflectsCallingThread() throws InterruptedException {
        CameraCoordinator coordinator = new CameraCoordinator();
        Handler handler = coordinator.startBackgroundThread("CameraCoordinatorTest");
        assertThat(coordinator.isOnCameraThread()).isFalse();

        CountDownLatch done = new CountDownLatch(1);
        AtomicBoolean onThread = new AtomicBoolean(false);
        handler.post(
                () -> {
                    onThread.set(coordinator.isOnCameraThread());
                    done.countDown();
                });

        assertThat(done.await(1, TimeUnit.SECONDS)).isTrue();
        assertThat(onThread).isTrue();
        coordinator.stopBackgroundThread();
        assertThat(coordinator.isOnCameraThread()).isFalse();
    }

    @Test
    public void runOnCameraThread_withoutCameraThread_runsInline() {
        CameraCoordinator coordinator = new CameraCoordinator();
        AtomicBoolean ran = new AtomicBoolean(false);

        coordinator.runOnCameraThread(() -> ran.set(true));

        assertThat(ran).isTrue();
    }

    @Test
    public void awaitOnCameraThread_waitsForCompletion() throws InterruptedException {
        CameraCoordinator coordinator = new CameraCoordinator();
        coordinator.startBackgroundThread("CameraCoordinatorTest");
        AtomicBoolean ran = new AtomicBoolean(false);

        boolean completed = coordinator.awaitOnCameraThread(() -> ran.set(true), 1_000);

        assertThat(completed).isTrue();
        assertThat(ran).isTrue();
        coordinator.stopBackgroundThread();
    }

    @Test
    public void awaitOnCameraThread_timesOutOnBusyThread() throws InterruptedException {
        CameraCoordinator coordinator = new CameraCoordinator();
        Handler handler = coordinator.startBackgroundThread("CameraCoordinatorTest");
        CountDownLatch release = new CountDownLatch(1);
        handler.post(
                () -> {
                    try {
                        release.await(5, TimeUnit.SECONDS);
                    } catch (InterruptedException ignored) {
                        Thread.currentThread().interrupt();
                    }
                });

        try {
            boolean completed = coordinator.awaitOnCameraThread(() -> {}, 100);
            assertThat(completed).isFalse();
        } finally {
            release.countDown();
            coordinator.stopBackgroundThread();
        }
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
    public void beginOpen_bumpsGenerationAndMarksOpening() {
        CameraCoordinator coordinator = new CameraCoordinator();
        long before = coordinator.generation();

        long gen = coordinator.beginOpen();

        assertThat(gen).isEqualTo(before + 1);
        assertThat(coordinator.isCurrentGeneration(gen)).isTrue();
        assertThat(coordinator.state()).isEqualTo(CameraCoordinator.LifecycleState.OPENING);
    }

    @Test
    public void closeDeviceAndSession_retiresTheOpenGeneration() {
        CameraCoordinator coordinator = new CameraCoordinator();
        long gen = coordinator.beginOpen();

        coordinator.closeDeviceAndSession();

        assertThat(coordinator.isCurrentGeneration(gen)).isFalse();
        assertThat(coordinator.state()).isEqualTo(CameraCoordinator.LifecycleState.CLOSED);
    }

    @Test
    public void lifecycleState_tracksOpenConfigureClose() {
        CameraCoordinator coordinator = new CameraCoordinator();
        assertThat(coordinator.state()).isEqualTo(CameraCoordinator.LifecycleState.CLOSED);

        coordinator.beginOpen();
        assertThat(coordinator.state()).isEqualTo(CameraCoordinator.LifecycleState.OPENING);

        coordinator.setDevice(Mockito.mock(CameraDevice.class));
        assertThat(coordinator.state()).isEqualTo(CameraCoordinator.LifecycleState.OPENED);

        coordinator.setSession(Mockito.mock(CameraCaptureSession.class));
        assertThat(coordinator.state()).isEqualTo(CameraCoordinator.LifecycleState.CONFIGURED);

        coordinator.closeDeviceAndSession();
        assertThat(coordinator.state()).isEqualTo(CameraCoordinator.LifecycleState.CLOSED);
    }

    @Test
    public void keepAliveExpiry_staleGeneration_skipsTeardown() throws InterruptedException {
        CameraCoordinator coordinator = new CameraCoordinator();
        coordinator.startBackgroundThread("CameraCoordinatorTest");
        CountDownLatch expired = new CountDownLatch(1);

        try {
            coordinator.startKeepAlive(250, () -> false, expired::countDown);
            // Reopen before the timer fires: the expiry was armed for the old camera
            // and must not tear down its successor. The 250ms arm gives the bump a
            // wide margin over Timer scheduling jitter.
            coordinator.closeDeviceAndSession();

            assertThat(expired.await(800, TimeUnit.MILLISECONDS)).isFalse();
        } finally {
            coordinator.stopBackgroundThread();
        }
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
