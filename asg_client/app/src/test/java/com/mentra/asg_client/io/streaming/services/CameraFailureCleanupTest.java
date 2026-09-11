package com.mentra.asg_client.io.streaming.services;

import static org.junit.Assert.*;
import static org.mockito.Mockito.*;

import android.content.Context;
import io.github.thibaultbee.streampack.internal.endpoints.IEndpoint;
import io.github.thibaultbee.streampack.internal.muxers.IMuxer;
import io.github.thibaultbee.streampack.internal.sources.AudioSource;
import io.github.thibaultbee.streampack.internal.sources.camera.CameraSource;
import io.github.thibaultbee.streampack.error.CameraError;
import io.github.thibaultbee.streampack.listeners.OnErrorListener;
import io.github.thibaultbee.streampack.streamers.bases.BaseCameraStreamer;
import io.github.thibaultbee.streampack.streamers.bases.BaseStreamer;
import java.lang.reflect.Field;
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
            CameraSource camera = cameras.constructed().get(0);
            doThrow(new IllegalStateException("camera HAL died")).when(camera).stopStream();
            Field running = BaseStreamer.class.getDeclaredField("isStreaming");
            running.setAccessible(true);
            running.setBoolean(streamer, true);
            ArgumentCaptor<OnErrorListener> listener = ArgumentCaptor.forClass(OnErrorListener.class);
            verify(camera).setOnErrorListener(listener.capture());
            CameraError failure = new CameraError("Camera device has crashed");

            listener.getValue().onError(failure);

            verify(microphones.constructed().get(0)).stopStream();
            verify(endpoint).stopStream(null);
            verify(owner).onError(failure);
            assertFalse(running.getBoolean(streamer));
            streamer.release();
        }
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

            assertThrows(IllegalStateException.class, streamer::release);
            verify(microphone).release();
            verify(muxer).release();
            verify(endpoint).release();
        }
    }
}
