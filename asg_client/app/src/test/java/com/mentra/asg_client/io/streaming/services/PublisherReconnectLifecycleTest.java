package com.mentra.asg_client.io.streaming.services;

import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import android.app.Application;
import android.content.ContextWrapper;
import android.os.Handler;
import android.os.Looper;
import com.mentra.asg_client.io.streaming.StreamCallbackScope;
import com.mentra.asg_client.io.streaming.interfaces.StreamingStatusCallback;
import io.github.thibaultbee.streampack.ext.rtmp.streamers.CameraRtmpLiveStreamer;
import io.github.thibaultbee.streampack.ext.srt.streamers.CameraSrtLiveStreamer;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import kotlin.ResultKt;
import kotlin.coroutines.Continuation;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;

/** Exercises the real service cleanup/retry paths with a failing publisher. */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
@LooperMode(LooperMode.Mode.PAUSED)
public class PublisherReconnectLifecycleTest {
    private Field field(Object service, String name) throws Exception {
        Field field = service.getClass().getDeclaredField(name);
        field.setAccessible(true);
        return field;
    }

    private void set(Object service, String name, Object value) throws Exception {
        field(service, name).set(service, value);
    }

    private void invoke(Object service, String name, Class<?> type, Object value) throws Exception {
        Method method = service.getClass().getDeclaredMethod(name, type);
        method.setAccessible(true);
        method.invoke(service, value);
    }

    private Object service(boolean srt, StreamCallbackScope scope) throws Exception {
        Object service = srt ? mock(SrtStreamingService.class, CALLS_REAL_METHODS)
                : mock(RtmpStreamingService.class, CALLS_REAL_METHODS);
        doReturn(RuntimeEnvironment.getApplication()).when((ContextWrapper) service).getApplicationContext();
        set(service, "mStateLock", new Object());
        set(service, "mPublisherCallbacks", scope);
        set(service, "mReconnectHandler", new Handler(Looper.getMainLooper()));
        set(service, "mCurrentStreamId", "owned-stream");
        set(service, "mIsStreamingActive", true);
        // Notification rendering is unrelated to the lifecycle under test.
        set(service, "mHasShownReconnectingNotification", true);
        return service;
    }

    @SuppressWarnings("unchecked")
    private void cleanupFailure(boolean srt) throws Exception {
        List<Runnable> callbacks = new ArrayList<>();
        Object service = service(srt, new StreamCallbackScope(callbacks::add));
        StreamingStatusCallback status = mock(StreamingStatusCallback.class);
        set(service, "sStatusCallback", status);
        RuntimeException failure = new RuntimeException("publisher cleanup failed");
        if (srt) {
            CameraSrtLiveStreamer publisher = mock(CameraSrtLiveStreamer.class);
            doAnswer(call -> {
                ((Continuation<Object>) call.getRawArguments()[0]).resumeWith(ResultKt.createFailure(failure));
                return kotlin.Unit.INSTANCE;
            }).when(publisher).stopStream(null);
            doThrow(failure).when(publisher).stopPreview();
            doThrow(failure).when(publisher).release();
            set(service, "mSrtStreamer", publisher);
        } else {
            CameraRtmpLiveStreamer publisher = mock(CameraRtmpLiveStreamer.class);
            doAnswer(call -> {
                ((Continuation<Object>) call.getRawArguments()[0]).resumeWith(ResultKt.createFailure(failure));
                return kotlin.Unit.INSTANCE;
            }).when(publisher).stopStream(null);
            doThrow(failure).when(publisher).stopPreview();
            doThrow(failure).when(publisher).release();
            set(service, "mStreamer", publisher);
        }
        try {
            invoke(service, "forceStopStreamingInternal", boolean.class, true);
            callbacks.forEach(Runnable::run);
            verify(status, times(3)).onStreamError(anyString(), eq("owned-stream"), eq(true));
            verify(status, never()).onStreamError(anyString(), anyString());
            verify(status, never()).onStreamStopped(anyString());
            assertEquals("owned-stream", field(service, "mCurrentStreamId").get(service));
            assertEquals(true, field(service, "mIsStreamingActive").get(service));
        } finally {
            set(service, "sStatusCallback", null);
        }
    }

    private void duplicateFailure(boolean srt) throws Exception {
        List<Runnable> callbacks = new ArrayList<>();
        StreamCallbackScope scope = new StreamCallbackScope(callbacks::add);
        Object service = service(srt, scope);
        long generation = scope.current();
        Runnable failure = () -> {
            try {
                invoke(service, "scheduleReconnect", String.class, "connection_lost");
            } catch (Exception e) {
                throw new AssertionError(e);
            }
        };
        scope.dispatch(generation, failure);
        scope.dispatch(generation, failure);
        callbacks.forEach(Runnable::run);
        assertEquals(1, field(service, "mReconnectAttempts").get(service));
        assertEquals(1, field(service, "mReconnectionSequence").get(service));
        assertFalse(scope.isCurrent(generation));
        // A new publisher can fail again: deduplication must not suppress later attempts.
        callbacks.clear();
        scope.dispatch(scope.advance(), failure);
        callbacks.forEach(Runnable::run);
        assertEquals(2, field(service, "mReconnectAttempts").get(service));
        ((Handler) field(service, "mReconnectHandler").get(service)).removeCallbacksAndMessages(null);
    }

    @Test public void rtmpCleanupFailurePreservesOwnership() throws Exception { cleanupFailure(false); }
    @Test public void srtCleanupFailurePreservesOwnership() throws Exception { cleanupFailure(true); }
    @Test public void rtmpDuplicateFailureSchedulesOneRetry() throws Exception { duplicateFailure(false); }
    @Test public void srtDuplicateFailureSchedulesOneRetry() throws Exception { duplicateFailure(true); }

    @Test public void cameraDeviceLossIsTerminalForBothStreamPackPublishers() throws Exception {
        for (boolean srt : new boolean[] {false, true}) {
            Object service = service(srt, new StreamCallbackScope(Runnable::run));
            Method classify = service.getClass().getDeclaredMethod("isRetryableError",
                    io.github.thibaultbee.streampack.error.StreamPackError.class);
            classify.setAccessible(true);
            for (String message : new String[] {"Camera device has crashed", "Camera has been disconnected",
                    "Camera Connection failed"}) {
                assertEquals(false, classify.invoke(service,
                        new io.github.thibaultbee.streampack.error.CameraError(message)));
            }
            assertEquals(true, classify.invoke(service,
                    new io.github.thibaultbee.streampack.error.StreamPackError("Connection reset")));
        }
    }
}
