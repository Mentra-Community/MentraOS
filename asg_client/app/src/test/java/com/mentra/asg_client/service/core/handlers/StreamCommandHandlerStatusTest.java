package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import android.os.Looper;

import androidx.test.core.app.ApplicationProvider;

import com.mentra.asg_client.io.streaming.StreamStatusSnapshot;
import com.mentra.asg_client.service.media.interfaces.IMediaManager;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;

import java.util.ArrayList;
import java.util.List;

/** Query correlation survives queued delivery without becoming retained stream state. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
@LooperMode(LooperMode.Mode.PAUSED)
public class StreamCommandHandlerStatusTest {
    private final List<JSONObject> responses = new ArrayList<>();
    private final StreamStatusSnapshot state = new StreamStatusSnapshot("1234abcd");
    private StreamCommandHandler handler;

    @Before
    public void setUp() throws Exception {
        IMediaManager media = mock(IMediaManager.class);
        when(media.getStreamSnapshot()).thenAnswer(call -> state.snapshot());
        doAnswer(
                        call -> {
                            JSONObject value = call.getArgument(1);
                            responses.add(new JSONObject(value.toString()));
                            return null;
                        })
                .when(media)
                .sendStreamStatusResponse(eq(true), any(JSONObject.class));
        handler =
                new StreamCommandHandler(
                        ApplicationProvider.getApplicationContext(), null, media, null);
    }

    @Test
    public void repeatedSnapshotsKeepTheirOwnIdsWithoutChangingStreamState() throws Exception {
        handler.handleCommand(
                "get_stream_status", new JSONObject().put("request_id", "old-request"));
        handler.handleCommand(
                "get_stream_status", new JSONObject().put("request_id", "new-request"));
        handler.handleStatusCommand();
        Shadows.shadowOf(Looper.getMainLooper()).idle();

        assertThat(responses).hasSize(3);
        assertThat(responses.get(0).getString("request_id")).isEqualTo("old-request");
        assertThat(responses.get(1).getString("request_id")).isEqualTo("new-request");
        assertThat(responses.get(2).has("request_id")).isFalse();
        assertThat(state.snapshot().has("request_id")).isFalse();
        for (JSONObject response : responses) {
            assertThat(response.getString("sid")).isEqualTo("1234abcd");
            assertThat(response.getString("status")).isEqualTo("stopped");
            assertThat(response.getLong("revision")).isZero();
            assertThat(response.getBoolean("terminal")).isTrue();
        }
    }

    @Test
    public void backgroundQueryKeepsCorrelationThroughTheLifecycleHandler() throws Exception {
        JSONObject query = new JSONObject().put("request_id", "background-query");
        Thread background = new Thread(() -> handler.handleCommand("get_stream_status", query));
        background.start();
        background.join();
        assertThat(responses).isEmpty();
        Shadows.shadowOf(Looper.getMainLooper()).idle();

        assertThat(responses).hasSize(1);
        assertThat(responses.get(0).getString("request_id")).isEqualTo("background-query");
    }

    @Test
    public void missingAndInvalidIdsPreserveLegacyStatusResponse() throws Exception {
        for (Object invalid :
                new Object[] {JSONObject.NULL, 42, "", "has spaces", "x".repeat(121)}) {
            handler.handleCommand("get_stream_status", new JSONObject().put("request_id", invalid));
        }
        handler.handleCommand("get_stream_status", new JSONObject());
        Shadows.shadowOf(Looper.getMainLooper()).idle();

        assertThat(responses).hasSize(6);
        for (JSONObject response : responses) {
            assertThat(response.has("request_id")).isFalse();
            assertThat(response.getString("status")).isEqualTo("stopped");
        }
    }
}
