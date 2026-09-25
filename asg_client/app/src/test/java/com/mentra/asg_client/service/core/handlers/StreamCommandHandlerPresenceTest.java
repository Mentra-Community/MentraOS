package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.os.Looper;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.LinkStateMachine;
import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.media.interfaces.IMediaManager;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import org.junit.Before;
import org.mockito.MockedStatic;
import com.mentra.asg_client.io.streaming.services.RtmpStreamingService;
import com.mentra.asg_client.io.streaming.services.SrtStreamingService;
import com.mentra.asg_client.io.streaming.services.WhipStreamingService;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;

@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
@LooperMode(LooperMode.Mode.PAUSED)
public class StreamCommandHandlerPresenceTest {
    private final LinkStateMachine link = new LinkStateMachine();
    private final K900BluetoothManager bluetooth = mock(K900BluetoothManager.class);
    private final IMediaManager media = mock(IMediaManager.class);
    private final List<JSONObject> errors = new ArrayList<>();
    private StreamCommandHandler handler;

    @Before public void setUp() {
        AsgClientServiceManager services = mock(AsgClientServiceManager.class);
        when(services.getBluetoothManager()).thenReturn(bluetooth);
        when(bluetooth.getLinkStateMachine()).thenReturn(link);
        when(bluetooth.requestSystemVersionRefresh()).thenReturn(true);
        doAnswer(invocation -> { errors.add(invocation.getArgument(1)); return null; })
                .when(media).sendStreamStatusResponse(eq(false), any(JSONObject.class));
        handler = new StreamCommandHandler(null, null, media, mock(INetworkManager.class), services);
    }

    private JSONObject start(String id) throws Exception {
        // A missing URL is deliberately rejected immediately after presence admission. That
        // proves the real handler resumed validation without opening a camera in this JVM test.
        return new JSONObject().put("streamId", id).put("controllerId", "controller")
                .put("controllerProbeVersion", 1);
    }

    private void advance(long ms) {
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms));
    }

    @Test public void missedConnectEdgeRefreshesBesBeforeContinuingStart() throws Exception {
        link.phonePresenceReported(false);
        assertThat(handler.handleCommand("start_stream", start("one"))).isTrue();
        advance(0);
        verify(bluetooth).requestSystemVersionRefresh();
        assertThat(errors).isEmpty();
        assertThat(link.getPhonePresence()).isEqualTo(LinkStateMachine.PhonePresence.ABSENT);
        link.phonePresenceReported(true); // sr_syvr response to cs_syvr
        advance(AsgConstants.STREAM_PHONE_PRESENCE_REFRESH_RETRY_MS);
        assertThat(errors).hasSize(1);
        assertThat(errors.get(0).optString("errorDetails")).isEqualTo("missing_stream_url");
        assertThat(errors.get(0).optString("streamId")).isEqualTo("one");
    }

    @Test public void noReportTimesOutWithoutTreatingCommandAsConnected() throws Exception {
        handler.handleCommand("start_stream", start("one"));
        advance(AsgConstants.STREAM_PHONE_PRESENCE_REFRESH_TIMEOUT_MS);
        assertThat(errors).hasSize(1);
        assertThat(errors.get(0).optString("errorDetails")).contains("could not be synchronized");
        assertThat(link.getPhonePresence()).isEqualTo(LinkStateMachine.PhonePresence.UNKNOWN);
        link.phonePresenceReported(true);
        advance(1000);
        assertThat(errors).hasSize(1); // timed-out start cannot revive
    }

    @Test public void confirmedAbsenceRemainsBlockedAndReportsDisconnection() throws Exception {
        link.phonePresenceReported(false);
        handler.handleCommand("start_stream", start("one"));
        advance(AsgConstants.STREAM_PHONE_PRESENCE_REFRESH_TIMEOUT_MS);
        assertThat(errors).hasSize(1);
        assertThat(errors.get(0).optString("errorDetails")).contains("disconnected");
    }

    @Test public void replacementCancelsOldRequestAndOnlyResumesNewest() throws Exception {
        handler.handleCommand("start_stream", start("old"));
        handler.handleCommand("start_stream", start("new"));
        advance(0);
        link.phonePresenceReported(true);
        advance(AsgConstants.STREAM_PHONE_PRESENCE_REFRESH_RETRY_MS);
        assertThat(errors).hasSize(2);
        assertThat(errors.get(0).optString("streamId")).isEqualTo("old");
        assertThat(errors.get(0).optString("errorDetails")).contains("superseded");
        assertThat(errors.get(1).optString("streamId")).isEqualTo("new");
    }

    @Test public void duplicateRequestDoesNotExtendDeadline() throws Exception {
        handler.handleCommand("start_stream", start("one"));
        advance(1000);
        handler.handleCommand("start_stream", start("one"));
        advance(1000);
        assertThat(errors).hasSize(1);
        assertThat(errors.get(0).optString("errorDetails")).contains("could not be synchronized");
    }

    @Test public void stopAndCleanupCancelPendingAdmission() throws Exception {
        try (MockedStatic<RtmpStreamingService> rtmp =
                        mockStatic(RtmpStreamingService.class);
                MockedStatic<SrtStreamingService> srt =
                        mockStatic(SrtStreamingService.class);
                MockedStatic<WhipStreamingService> whip =
                        mockStatic(WhipStreamingService.class)) {
            when(media.getStreamSnapshot()).thenReturn(new JSONObject());
            handler.handleCommand("start_stream", start("stopped"));
            advance(0);
            handler.handleCommand("stop_stream", new JSONObject());
            advance(0);
            assertThat(errors).hasSize(1);
            assertThat(errors.get(0).optString("errorDetails")).contains("cancelled");
            handler.handleCommand("start_stream", start("closed"));
            advance(0);
            handler.cleanup();
            advance(0);
            assertThat(errors).hasSize(2);
            assertThat(errors.get(1).optString("errorDetails")).contains("owner closed");
            link.phonePresenceReported(true);
            advance(3000);
            assertThat(errors).hasSize(2);
        }
    }
}
