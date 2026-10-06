package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.Mockito.*;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.os.Looper;
import com.mentra.asg_client.io.streaming.StreamStatusSnapshot;
import com.mentra.asg_client.io.streaming.interfaces.StreamingStatusCallback;
import com.mentra.asg_client.io.streaming.services.RtmpStreamingService;
import com.mentra.asg_client.io.streaming.services.SrtStreamingService;
import com.mentra.asg_client.io.streaming.services.WhipStreamingService;
import com.mentra.asg_client.service.media.interfaces.IMediaManager;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.MockedStatic;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;

/** A stale cleanup request cannot stop or cancel a replacement publisher. */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
@LooperMode(LooperMode.Mode.PAUSED)
public class StreamCommandHandlerConditionalStopTest {
    private final IMediaManager media = mock(IMediaManager.class);
    private final StreamingStatusCallback callback = mock(StreamingStatusCallback.class);
    private final StreamStatusSnapshot state = new StreamStatusSnapshot("1234abcd");
    private final List<JSONObject> responses = new ArrayList<>();
    private StreamCommandHandler handler;

    @Before public void setUp() throws Exception {
        when(media.getStreamSnapshot()).thenAnswer(call -> state.snapshot());
        when(media.getStreamingStatusCallback()).thenReturn(callback);
        doAnswer(call -> {
            responses.add(new JSONObject(((JSONObject) call.getArgument(1)).toString()));
            return null;
        }).when(media).sendStreamStatusResponse(anyBoolean(), any(JSONObject.class));
        doAnswer(call -> {
            state.update(new JSONObject().put("streamId", call.getArgument(0))
                    .put("status", "stopped"));
            return null;
        }).when(callback).onStreamStopped(any());
        handler = new StreamCommandHandler(null, null, media, null);
    }

    private void field(String name, Object value) throws Exception {
        Field field = StreamCommandHandler.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(handler, value);
    }

    private Object field(String name) throws Exception {
        Field field = StreamCommandHandler.class.getDeclaredField(name);
        field.setAccessible(true);
        return field.get(handler);
    }

    private JSONObject stop(String stream, String controller) throws Exception {
        return new JSONObject().put("request_id", "cleanup-1")
                .put("streamId", stream).put("controllerId", controller)
                .put("expectedSid", "1234abcd").put("expectedRevision", state.snapshot().getLong("revision"));
    }

    private void owned(String stream, String controller) throws Exception {
        state.begin(stream);
        field("mOwnedStreamId", stream);
        field("mOwnedControllerId", controller);
        field("mOwnedStartRevision", state.snapshot().getLong("revision"));
    }

    @Test public void staleQueuedStopRefusesReplacementBeforeAnyMutation() throws Exception {
        owned("old", "old-controller");
        JSONObject command = stop("old", "old-controller");
        Thread background = new Thread(() -> handler.handleCommand("stop_stream", command));
        background.start(); background.join();
        owned("new", "new-controller");
        try (MockedStatic<RtmpStreamingService> rtmp = mockStatic(RtmpStreamingService.class);
                MockedStatic<SrtStreamingService> srt = mockStatic(SrtStreamingService.class);
                MockedStatic<WhipStreamingService> whip = mockStatic(WhipStreamingService.class)) {
            shadowOf(Looper.getMainLooper()).idle();
            rtmp.verifyNoInteractions(); srt.verifyNoInteractions(); whip.verifyNoInteractions();
        }
        assertThat(responses).hasSize(1);
        assertThat(responses.get(0).getBoolean("stopAccepted")).isFalse();
        assertThat(responses.get(0).getString("request_id")).isEqualTo("cleanup-1");
        assertThat(responses.get(0).getString("streamId")).isEqualTo("new");
        assertThat(field("mOwnedStreamId")).isEqualTo("new");
        verifyNoInteractions(callback);
    }

    @Test public void exactOwnerStopsAndAcknowledgesWithoutRetainingCorrelation() throws Exception {
        owned("one", "controller");
        try (MockedStatic<RtmpStreamingService> rtmp = mockStatic(RtmpStreamingService.class);
                MockedStatic<SrtStreamingService> srt = mockStatic(SrtStreamingService.class);
                MockedStatic<WhipStreamingService> whip = mockStatic(WhipStreamingService.class)) {
            handler.handleCommand("stop_stream", stop("one", "controller"));
            shadowOf(Looper.getMainLooper()).idle();
            rtmp.verify(() -> RtmpStreamingService.stopStreaming(null));
            srt.verify(() -> SrtStreamingService.stopStreaming(null));
            whip.verify(() -> WhipStreamingService.stopStreaming(null));
        }
        JSONObject ack = responses.get(responses.size() - 1);
        assertThat(ack.getString("kind")).isEqualTo("stop_ack");
        assertThat(ack.getBoolean("stopAccepted")).isTrue();
        assertThat(ack.getString("requestedControllerId")).isEqualTo("controller");
        assertThat(ack.getBoolean("terminal")).isTrue();
        assertThat(state.snapshot().has("request_id")).isFalse();
        assertThat(state.snapshot().has("stopAccepted")).isFalse();
    }

    @Test public void differentPendingStartRefusesEvenTheMatchingActiveOwner() throws Exception {
        owned("one", "controller");
        JSONObject pending = new JSONObject().put("streamId", "two").put("controllerId", "next");
        field("mPendingStart", pending);
        handler.handleCommand("stop_stream", stop("one", "controller"));
        shadowOf(Looper.getMainLooper()).idle();
        assertThat(responses.get(0).getBoolean("stopAccepted")).isFalse();
        assertThat(field("mPendingStart")).isSameAs(pending);
        verifyNoInteractions(callback);
    }

    @Test public void pendingAdmissionAlwaysRefusesWithoutCancellingOrStopping() throws Exception {
        owned("other", "other-controller");
        JSONObject pending = new JSONObject().put("streamId", "pending").put("controllerId", "controller");
        field("mPendingStart", pending);
        try (MockedStatic<RtmpStreamingService> rtmp = mockStatic(RtmpStreamingService.class);
                MockedStatic<SrtStreamingService> srt = mockStatic(SrtStreamingService.class);
                MockedStatic<WhipStreamingService> whip = mockStatic(WhipStreamingService.class)) {
            handler.handleCommand("stop_stream", stop("pending", "controller"));
            shadowOf(Looper.getMainLooper()).idle();
            rtmp.verifyNoInteractions(); srt.verifyNoInteractions(); whip.verifyNoInteractions();
        }
        JSONObject ack = responses.get(responses.size() - 1);
        assertThat(ack.getBoolean("stopAccepted")).isFalse();
        assertThat(ack.getString("stopReason")).isEqualTo("pending_admission");
        assertThat(field("mPendingStart")).isSameAs(pending);
        assertThat(field("mOwnedStreamId")).isEqualTo("other");
        verifyNoInteractions(callback);
    }

    @Test public void sameIdsReplacementChangesRevisionAndRefusesStaleStop() throws Exception {
        owned("one", "controller");
        JSONObject stale = stop("one", "controller");
        owned("one", "controller");
        handler.handleCommand("stop_stream", stale);
        shadowOf(Looper.getMainLooper()).idle();
        assertThat(responses.get(0).getBoolean("stopAccepted")).isFalse();
        assertThat(responses.get(0).getString("stopReason")).isEqualTo("snapshot_changed");
        assertThat(state.snapshot().getBoolean("terminal")).isFalse();
        verifyNoInteractions(callback);
    }

    @Test public void wrongProcessSidOrRevisionNeverStopsCurrentOwner() throws Exception {
        owned("one", "controller");
        handler.handleCommand("stop_stream", stop("one", "controller").put("expectedSid", "9999ffff"));
        handler.handleCommand("stop_stream", stop("one", "controller").put("expectedRevision", -1));
        shadowOf(Looper.getMainLooper()).idle();
        assertThat(responses).hasSize(2);
        for (JSONObject response : responses) assertThat(response.getBoolean("stopAccepted")).isFalse();
        verifyNoInteractions(callback);
    }

    @Test public void wrongControllerAndIncompleteIdentityNeverBecomeGlobalStop() throws Exception {
        owned("one", "controller");
        handler.handleCommand("stop_stream", stop("one", "foreign"));
        handler.handleCommand("stop_stream", new JSONObject().put("streamId", "one"));
        handler.handleCommand("stop_stream", stop("one", "controller").put("request_id", 12));
        shadowOf(Looper.getMainLooper()).idle();
        assertThat(responses).hasSize(3);
        for (JSONObject response : responses) assertThat(response.getBoolean("stopAccepted")).isFalse();
        assertThat(state.snapshot().getBoolean("terminal")).isFalse();
        verifyNoInteractions(callback);
    }

    @Test public void alreadyTerminalOriginalAcknowledgesWithoutStoppingAnything() throws Exception {
        owned("one", "controller");
        state.update(new JSONObject().put("streamId", "one").put("status", "stopped"));
        field("mOwnedStreamId", null);
        handler.handleCommand("stop_stream", stop("one", "controller"));
        shadowOf(Looper.getMainLooper()).idle();
        assertThat(responses.get(0).getBoolean("stopAccepted")).isTrue();
        assertThat(responses.get(0).getString("stopReason")).isEqualTo("already_terminal");
        verifyNoInteractions(callback);
    }

    @Test public void expectedOnlyGuardsNeverBecomeGlobalStopOrCancelPendingAdmission() throws Exception {
        owned("one", "controller");
        JSONObject pending = new JSONObject().put("streamId", "two").put("controllerId", "next");
        field("mPendingStart", pending);
        try (MockedStatic<RtmpStreamingService> rtmp = mockStatic(RtmpStreamingService.class);
                MockedStatic<SrtStreamingService> srt = mockStatic(SrtStreamingService.class);
                MockedStatic<WhipStreamingService> whip = mockStatic(WhipStreamingService.class)) {
            handler.handleCommand("stop_stream", new JSONObject().put("expectedSid", "1234abcd"));
            handler.handleCommand("stop_stream", new JSONObject().put("expectedRevision", 1));
            handler.handleCommand("stop_stream", new JSONObject().put("expectedSid", JSONObject.NULL));
            handler.handleCommand("stop_stream", new JSONObject().put("expectedRevision", "bad"));
            shadowOf(Looper.getMainLooper()).idle();
            rtmp.verifyNoInteractions(); srt.verifyNoInteractions(); whip.verifyNoInteractions();
        }
        assertThat(responses).hasSize(4);
        for (JSONObject response : responses) assertThat(response.getBoolean("stopAccepted")).isFalse();
        assertThat(field("mPendingStart")).isSameAs(pending);
        assertThat(field("mOwnedStreamId")).isEqualTo("one");
        verifyNoInteractions(callback);
    }

    @Test public void terminalSnapshotPreservesAdmittedIdentityWithoutActiveOwnership() throws Exception {
        owned("one", "controller");
        try (MockedStatic<RtmpStreamingService> rtmp = mockStatic(RtmpStreamingService.class);
                MockedStatic<SrtStreamingService> srt = mockStatic(SrtStreamingService.class);
                MockedStatic<WhipStreamingService> whip = mockStatic(WhipStreamingService.class)) {
            handler.handleCommand("stop_stream", stop("one", "controller"));
            shadowOf(Looper.getMainLooper()).idle();
        }
        assertThat(field("mOwnedStreamId")).isNull();
        JSONObject terminal = responses.get(responses.size() - 1);
        assertThat(terminal.getBoolean("terminal")).isTrue();
        assertThat(terminal.getString("controllerId")).isEqualTo("controller");
        assertThat(terminal.getLong("startRevision")).isEqualTo(1);
        handler.handleCommand("stop_stream", stop("one", "foreign"));
        shadowOf(Looper.getMainLooper()).idle();
        assertThat(responses.get(responses.size() - 1).getBoolean("stopAccepted")).isFalse();
        owned("one", "controller");
        handler.handleCommand("get_stream_status", new JSONObject().put("request_id", "replacement-query"));
        shadowOf(Looper.getMainLooper()).idle();
        assertThat(responses.get(responses.size() - 1).getLong("startRevision")).isGreaterThan(1);
    }

    @Test public void queryMakesIdlePendingAdmissionAndActiveControllerExplicit() throws Exception {
        field("mPendingStart", new JSONObject().put("streamId", "pending").put("controllerId", "controller"));
        handler.handleCommand("get_stream_status", new JSONObject().put("request_id", "query-1"));
        shadowOf(Looper.getMainLooper()).idle();
        assertThat(responses.get(0).getBoolean("terminal")).isTrue();
        assertThat(responses.get(0).getBoolean("pendingStart")).isTrue();
        assertThat(responses.get(0).getString("pendingStreamId")).isEqualTo("pending");
        field("mPendingStart", null);
        owned("one", "controller");
        handler.handleCommand("get_stream_status", new JSONObject().put("request_id", "query-2"));
        shadowOf(Looper.getMainLooper()).idle();
        assertThat(responses.get(1).getBoolean("pendingStart")).isFalse();
        assertThat(responses.get(1).getString("controllerId")).isEqualTo("controller");
        assertThat(responses.get(1).getLong("startRevision")).isEqualTo(1);
        assertThat(state.snapshot().has("pendingStart")).isFalse();
    }
}
