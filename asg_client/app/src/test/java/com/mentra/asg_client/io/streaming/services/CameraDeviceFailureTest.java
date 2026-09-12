package com.mentra.asg_client.io.streaming.services;

import static org.junit.Assert.*;
import static org.mockito.Mockito.*;
import static org.robolectric.Shadows.shadowOf;

import android.content.Context;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.os.Looper;
import android.view.Surface;
import io.github.thibaultbee.streampack.internal.sources.camera.CameraController;
import io.github.thibaultbee.streampack.internal.sources.camera.CameraExecutorManager;
import io.github.thibaultbee.streampack.listeners.OnErrorListener;
import java.util.ArrayList;
import java.util.List;
import kotlin.Unit;
import kotlin.coroutines.EmptyCoroutineContext;
import kotlinx.coroutines.BuildersKt;
import kotlinx.coroutines.CancellableContinuation;
import kotlinx.coroutines.Dispatchers;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.MockedConstruction;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;

/** Real controller callback routing with Camera2 hardware replaced by mocks. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
@LooperMode(LooperMode.Mode.PAUSED)
public class CameraDeviceFailureTest {
    @Test public void deviceFailureAfterOpenIsDeliveredOffTheCameraCallbackAndOnlyOnce() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.open();
            CameraDevice.StateCallback callback = fixture.callbacks.get(0);
            callback.onError(fixture.camera, CameraDevice.StateCallback.ERROR_CAMERA_DEVICE);
            callback.onDisconnected(fixture.camera);
            verifyNoInteractions(fixture.listener);

            shadowOf(Looper.getMainLooper()).idle();

            verify(fixture.listener, times(1)).onError(any());
        }
    }

    @Test public void queuedFailureFromClosedCameraCannotReachAReplacement() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.open();
            fixture.callbacks.get(0).onError(fixture.camera, CameraDevice.StateCallback.ERROR_CAMERA_SERVICE);
            fixture.controller.stopCamera();
            fixture.open();
            shadowOf(Looper.getMainLooper()).idle();
            verifyNoInteractions(fixture.listener);

            fixture.callbacks.get(1).onDisconnected(fixture.camera);
            shadowOf(Looper.getMainLooper()).idle();
            verify(fixture.listener).onError(any());
        }
    }

    @Test public void lateFailureAfterReplacementIsIgnored() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.open();
            fixture.controller.stopCamera();
            fixture.open();
            fixture.callbacks.get(0).onDisconnected(fixture.camera);
            shadowOf(Looper.getMainLooper()).idle();
            verifyNoInteractions(fixture.listener);
        }
    }

    @SuppressWarnings("unchecked")
    @Test public void disconnectDuringOpenRejectsTheOpenRatherThanReportingAnActiveStreamFailure() {
        CancellableContinuation<CameraDevice> continuation = mock(CancellableContinuation.class);
        when(continuation.isActive()).thenReturn(true);
        OnErrorListener listener = mock(OnErrorListener.class);
        CameraController.CameraDeviceCallback callback = new CameraController.CameraDeviceCallback(
                continuation, error -> { listener.onError(error); return Unit.INSTANCE; });

        callback.onDisconnected(mock(CameraDevice.class));

        verify(continuation).resumeWith(any());
        verifyNoInteractions(listener);
    }

    private static final class Fixture implements AutoCloseable {
        final CameraDevice camera = mock(CameraDevice.class);
        final CameraCaptureSession session = mock(CameraCaptureSession.class);
        final OnErrorListener listener = mock(OnErrorListener.class);
        final List<CameraDevice.StateCallback> callbacks = new ArrayList<>();
        final MockedConstruction<CameraExecutorManager> managers;
        final CameraController controller;

        Fixture() {
            Context context = mock(Context.class);
            when(context.getSystemService(Context.CAMERA_SERVICE)).thenReturn(mock(CameraManager.class));
            managers = mockConstruction(CameraExecutorManager.class, (manager, ignored) -> {
                doAnswer(call -> {
                    CameraDevice.StateCallback callback = call.getArgument(2);
                    callbacks.add(callback);
                    callback.onOpened(camera);
                    return null;
                }).when(manager).openCamera(any(), anyString(), any());
                doAnswer(call -> {
                    CameraCaptureSession.StateCallback callback = call.getArgument(2);
                    callback.onConfigured(session);
                    return null;
                }).when(manager).createCaptureSessionByOutputConfiguration(any(), anyList(), any());
            });
            controller = new CameraController(context, Dispatchers.getDefault());
            controller.setOnErrorListener(listener);
        }

        void open() throws Exception {
            BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE, (scope, continuation) ->
                    controller.startCamera("0", List.of(mock(Surface.class)), 1L, continuation));
        }

        @Override public void close() {
            controller.release();
            managers.close();
        }
    }
}
