package com.mentra.asg_client.service.core.handlers;

import static org.junit.Assert.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import android.os.Looper;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.service.media.interfaces.IMediaManager;
import io.github.thibaultbee.streampack.internal.sources.camera.CameraController;
import java.lang.reflect.Field;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class StreamCommandHandlerCleanupTest {
    @Test
    public void terminalOwnershipRestoresEisButOldSameIdStatusCannotReleaseReplacement() throws Exception {
        IMediaManager media = mock(IMediaManager.class);
        AtomicReference<Consumer<JSONObject>> listener = new AtomicReference<>();
        doAnswer(call -> { listener.set(call.getArgument(0)); return null; })
                .when(media).setStreamStatusListener(any());
        StreamCommandHandler handler = new StreamCommandHandler(
                ApplicationProvider.getApplicationContext(), null, media, null);
        Field owned = StreamCommandHandler.class.getDeclaredField("mOwnedStreamId");
        owned.setAccessible(true);
        Field revision = StreamCommandHandler.class.getDeclaredField("mOwnedStartRevision");
        revision.setAccessible(true);
        owned.set(handler, "same-id");
        revision.setLong(handler, 10);
        CameraController.enablePixsmartEisOnRequest = true;
        try {
            listener.get().accept(new JSONObject().put("streamId", "same-id")
                    .put("revision", 9).put("terminal", true));
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            assertEquals("same-id", owned.get(handler));
            assertTrue(CameraController.enablePixsmartEisOnRequest);
            listener.get().accept(new JSONObject().put("streamId", "same-id")
                    .put("revision", 11).put("terminal", true));
            Shadows.shadowOf(Looper.getMainLooper()).idle();
            assertNull(owned.get(handler));
            assertFalse(CameraController.enablePixsmartEisOnRequest);
        } finally {
            CameraController.enablePixsmartEisOnRequest = false;
        }
    }
}
