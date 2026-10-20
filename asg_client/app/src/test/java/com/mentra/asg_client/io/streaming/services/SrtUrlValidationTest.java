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
import java.lang.reflect.Field;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;

/** A URL the SRT publisher's own parser rejects must fail the start once, before the camera opens. */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
@LooperMode(LooperMode.Mode.PAUSED)
public class SrtUrlValidationTest {
    private static final String KEY_LENGTH_URL =
            "srt://ingest.example:9000?mode=caller&passphrase=0123456789abcdef&pbkeylen=16";

    @Test
    public void keyLengthParameterIsRejectedWithoutEchoingThePassphrase() {
        String error = SrtStreamingService.srtUrlError(KEY_LENGTH_URL);

        assertNotNull(error);
        assertTrue(error, error.contains("pbkeylen"));
        assertFalse(error, error.contains("0123456789abcdef"));
    }

    @Test
    public void passphraseCallerUrlIsAccepted() {
        assertNull(
                SrtStreamingService.srtUrlError(
                        "srt://ingest.example:9000?mode=caller&passphrase=0123456789abcdef"));
    }

    @Test
    public void rejectedUrlFailsTheStartWithoutRetryingOrStartingThePublisher() throws Exception {
        SrtStreamingService service = mock(SrtStreamingService.class, CALLS_REAL_METHODS);
        doReturn(RuntimeEnvironment.getApplication()).when((ContextWrapper) service).getApplicationContext();
        set(service, "mStateLock", new Object());
        set(service, "mPublisherCallbacks", new StreamCallbackScope(Runnable::run));
        set(service, "mReconnectHandler", new Handler(Looper.getMainLooper()));
        set(service, "mCurrentStreamId", "owned-stream");
        set(service, "mSrtUrl", KEY_LENGTH_URL);
        set(service, "mStreamState", idleState());
        StreamingStatusCallback status = mock(StreamingStatusCallback.class);
        set(service, "sStatusCallback", status);
        try {
            service.startStreaming();

            verify(status).onStreamError(startsWith("Invalid SRT URL"), eq("owned-stream"));
            verify(status, never()).onStreamError(anyString(), anyString(), eq(true));
            verify(status, never()).onStreamStarting(anyString(), anyString());
            assertEquals(idleState(), field(service, "mStreamState").get(service));
            assertEquals(0, field(service, "mReconnectAttempts").get(service));
            assertNull(field(service, "mSrtStreamer").get(service));
        } finally {
            set(service, "sStatusCallback", null);
        }
    }

    private static Object idleState() throws Exception {
        Class<?> type = SrtStreamingService.class.getDeclaredField("mStreamState").getType();
        for (Object state : type.getEnumConstants()) {
            if ("IDLE".equals(state.toString())) return state;
        }
        throw new AssertionError("SrtStreamingService has no IDLE state");
    }

    private static Field field(Object service, String name) throws Exception {
        Field field = SrtStreamingService.class.getDeclaredField(name);
        field.setAccessible(true);
        return field;
    }

    private static void set(Object service, String name, Object value) throws Exception {
        field(service, name).set(service, value);
    }
}
