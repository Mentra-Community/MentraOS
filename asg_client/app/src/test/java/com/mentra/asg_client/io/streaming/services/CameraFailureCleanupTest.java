package com.mentra.asg_client.io.streaming.services;

import static org.junit.Assert.*;
import static org.mockito.Mockito.*;

import android.content.Context;
import android.os.Looper;
import io.github.thibaultbee.streampack.internal.endpoints.IEndpoint;
import io.github.thibaultbee.streampack.internal.sources.IVideoSource;
import io.github.thibaultbee.streampack.internal.muxers.IMuxer;
import io.github.thibaultbee.streampack.internal.sources.AudioSource;
import io.github.thibaultbee.streampack.internal.sources.camera.CameraSource;
import io.github.thibaultbee.streampack.error.CameraError;
import io.github.thibaultbee.streampack.listeners.OnErrorListener;
import io.github.thibaultbee.streampack.streamers.bases.BaseCameraStreamer;
import io.github.thibaultbee.streampack.streamers.bases.BaseStreamer;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import kotlin.coroutines.EmptyCoroutineContext;
import kotlinx.coroutines.BuildersKt;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.MockedConstruction;
import org.mockito.ArgumentCaptor;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Exercise the real StreamPack teardown, replacing only hardware and network resources. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class CameraFailureCleanupTest {
    @Test public void activeCameraErrorReachesRealStreamerCleanupWithoutAnExplicitStop() throws Exception {
        try (MockedConstruction<CameraSource> cameras = mockConstruction(CameraSource.class);
                MockedConstruction<AudioSource> microphones = mockConstruction(AudioSource.class)) {
            IMuxer muxer = mock(IMuxer.class, RETURNS_DEEP_STUBS);
            IEndpoint endpoint = mock(IEndpoint.class);
            OnErrorListener owner = mock(OnErrorListener.class);
            BaseCameraStreamer streamer = new BaseCameraStreamer(mock(Context.class), true, muxer, endpoint, owner);
            CountDownLatch notified = new CountDownLatch(1);
            AtomicReference<Thread> callbackThread = new AtomicReference<>();
            doAnswer(call -> {
                callbackThread.set(Thread.currentThread());
                streamer.release(); // Listener reentry must not deadlock the lifecycle owner.
                notified.countDown();
                return null;
            }).when(owner).onError(any());
            CameraSource camera = cameras.constructed().get(0);
            doThrow(new IllegalStateException("camera HAL died")).when(camera).stopStream();
            Field running = BaseStreamer.class.getDeclaredField("isStreaming");
            running.setAccessible(true);
            running.setBoolean(streamer, true);
            ArgumentCaptor<OnErrorListener> listener = ArgumentCaptor.forClass(OnErrorListener.class);
            verify(camera).setOnErrorListener(listener.capture());
            CameraError failure = new CameraError("Camera device has crashed");

            listener.getValue().onError(failure);

            assertTrue(notified.await(5, TimeUnit.SECONDS));
            assertNotSame(Looper.getMainLooper().getThread(), callbackThread.get());
            verify(microphones.constructed().get(0)).stopStream();
            verify(endpoint).stopStream(null);
            verify(owner).onError(failure);
            verify(camera).release();
            verify(microphones.constructed().get(0)).release();
            assertFalse(running.getBoolean(streamer));
            streamer.release();
        }
    }

    @Test public void successfulStopKeepsThePublisherReusable() throws Exception {
        IMuxer muxer = mock(IMuxer.class, RETURNS_DEEP_STUBS);
        IEndpoint endpoint = mock(IEndpoint.class);
        BaseStreamer streamer = new BaseStreamer(mock(Context.class), null, null, muxer, endpoint, null) {};
        for (int i = 0; i < 2; i++) {
            BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
                    (scope, continuation) -> streamer.startStream(continuation));
            BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
                    (scope, continuation) -> streamer.stopStream(continuation));
        }
        verify(endpoint, times(2)).startStream(null);
        verify(endpoint, times(2)).stopStream(null);
        verify(endpoint, never()).release();
        streamer.release();
        streamer.release();
        verify(endpoint).release();
    }

    @Test public void resetFailureDisposesInsteadOfAllowingReuse() throws Exception {
        IMuxer muxer = mock(IMuxer.class, RETURNS_DEEP_STUBS);
        IEndpoint endpoint = mock(IEndpoint.class);
        IVideoSource source = mock(IVideoSource.class);
        BaseStreamer streamer = new BaseStreamer(mock(Context.class), null, source, muxer, endpoint, null) {};
        Field running = BaseStreamer.class.getDeclaredField("isStreaming");
        running.setAccessible(true);
        running.setBoolean(streamer, true);
        IllegalStateException resetFailure = new IllegalStateException("codec reset failed");
        doThrow(resetFailure).when(source).setEncoderSurface(null);
        doThrow(resetFailure).when(source).release();

        assertSame(resetFailure, assertThrows(IllegalStateException.class,
                () -> BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
                        (scope, continuation) -> streamer.stopStream(continuation))));

        verify(source).release();
        verify(muxer).release();
        verify(endpoint).release();
        streamer.release();
        assertThrows(IllegalStateException.class,
                () -> BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
                        (scope, continuation) -> streamer.startStream(continuation)));
    }

    @Test public void deadCameraCannotSkipMicrophoneAndEndpointCleanup() throws Exception {
        try (MockedConstruction<CameraSource> cameras = mockConstruction(CameraSource.class);
                MockedConstruction<AudioSource> microphones = mockConstruction(AudioSource.class)) {
            IMuxer muxer = mock(IMuxer.class, RETURNS_DEEP_STUBS);
            IEndpoint endpoint = mock(IEndpoint.class);
            BaseCameraStreamer streamer = new BaseCameraStreamer(mock(Context.class), true, muxer, endpoint, null);
            CameraSource camera = cameras.constructed().get(0);
            AudioSource microphone = microphones.constructed().get(0);
            IllegalStateException cameraError = new IllegalStateException("camera HAL died");
            doThrow(cameraError).when(camera).stopStream();
            doThrow(new IllegalStateException("preview failed")).when(camera).stopPreview();
            doThrow(new IllegalStateException("camera release failed")).when(camera).release();
            Field running = BaseStreamer.class.getDeclaredField("isStreaming");
            running.setAccessible(true);
            running.setBoolean(streamer, true);

            assertEquals(cameraError.getMessage(), assertThrows(IllegalStateException.class,
                    () -> BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
                            (scope, continuation) -> streamer.stopStream(continuation))).getMessage());
            verify(microphone).stopStream();
            verify(muxer).stopStream();
            // Mockito omits Kotlin's synthetic continuation parameter from matching.
            verify(endpoint).stopStream(null);
            assertFalse(running.getBoolean(streamer));

            // A failed stop disposes independently and leaves release idempotent.
            streamer.release();
            verify(microphone).release();
            verify(muxer).release();
            verify(endpoint).release();
            assertThrows(IllegalStateException.class,
                    () -> BuildersKt.runBlocking(EmptyCoroutineContext.INSTANCE,
                            (scope, continuation) -> streamer.startStream(continuation)));
        }
    }
}
