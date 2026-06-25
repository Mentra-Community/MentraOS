package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.media.interfaces.IMediaManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.ArgumentMatchers;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Verifies that {@code stop_video_recording} threads the stop-time upload target (webhookUrl +
 * authToken) through to the right {@link MediaCaptureService} entry point. The webhook/token are
 * supplied at STOP (not start) so the token is fresh when the upload runs.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class VideoCommandHandlerStopUploadTest {

    private AsgClientServiceManager serviceManager;
    private IMediaManager streamingManager;
    private MediaCaptureService captureService;
    private VideoCommandHandler handler;

    @Before
    public void setUp() {
        serviceManager = mock(AsgClientServiceManager.class);
        streamingManager = mock(IMediaManager.class);
        IStateManager stateManager = mock(IStateManager.class);
        captureService = mock(MediaCaptureService.class);

        when(serviceManager.getMediaCaptureService()).thenReturn(captureService);
        when(captureService.isRecordingVideo()).thenReturn(true);

        handler =
                new VideoCommandHandler(
                        null, serviceManager, streamingManager, null, stateManager);
    }

    @Test
    public void stop_withRequestIdAndWebhook_routesToValidatingStopWithUploadTarget()
            throws Exception {
        JSONObject data =
                new JSONObject()
                        .put("requestId", "req-123")
                        .put("webhookUrl", "https://example.com/hook")
                        .put("authToken", "tok-abc");

        boolean handled = handler.handleStopCommand(data);

        assertThat(handled).isTrue();
        verify(captureService)
                .handleStopVideoCommand("req-123", "https://example.com/hook", "tok-abc");
        verify(captureService, never())
                .stopVideoRecording(ArgumentMatchers.anyString(), ArgumentMatchers.anyString());
    }

    @Test
    public void stop_withoutRequestId_fallsBackToDirectStopWithUploadTarget() throws Exception {
        // No requestId → backward-compat path, but the webhook/token must still flow through.
        JSONObject data =
                new JSONObject()
                        .put("webhookUrl", "https://example.com/hook")
                        .put("authToken", "tok-abc");

        boolean handled = handler.handleStopCommand(data);

        assertThat(handled).isTrue();
        verify(captureService).stopVideoRecording("https://example.com/hook", "tok-abc");
        verify(captureService, never())
                .handleStopVideoCommand(
                        ArgumentMatchers.anyString(),
                        ArgumentMatchers.anyString(),
                        ArgumentMatchers.anyString());
    }

    @Test
    public void stop_emptyRequestId_fallsBackToDirectStop() throws Exception {
        JSONObject data =
                new JSONObject()
                        .put("requestId", "")
                        .put("webhookUrl", "https://example.com/hook")
                        .put("authToken", "tok-abc");

        boolean handled = handler.handleStopCommand(data);

        assertThat(handled).isTrue();
        verify(captureService).stopVideoRecording("https://example.com/hook", "tok-abc");
        verify(captureService, never())
                .handleStopVideoCommand(
                        ArgumentMatchers.anyString(),
                        ArgumentMatchers.anyString(),
                        ArgumentMatchers.anyString());
    }

    @Test
    public void stop_noWebhookFields_passesEmptyStrings() throws Exception {
        JSONObject data = new JSONObject().put("requestId", "req-123");

        boolean handled = handler.handleStopCommand(data);

        assertThat(handled).isTrue();
        // Empty webhook = no upload; the service treats "" as "keep on device".
        verify(captureService).handleStopVideoCommand("req-123", "", "");
        verify(captureService, never())
                .stopVideoRecording(ArgumentMatchers.anyString(), ArgumentMatchers.anyString());
    }

    @Test
    public void stop_notRecording_returnsFalseAndDoesNotStop() throws Exception {
        when(captureService.isRecordingVideo()).thenReturn(false);

        boolean handled =
                handler.handleStopCommand(new JSONObject().put("requestId", "req-123"));

        assertThat(handled).isFalse();
        verify(captureService, never())
                .handleStopVideoCommand(
                        ArgumentMatchers.anyString(),
                        ArgumentMatchers.anyString(),
                        ArgumentMatchers.anyString());
        verify(captureService, never())
                .stopVideoRecording(ArgumentMatchers.anyString(), ArgumentMatchers.anyString());
        verify(streamingManager)
                .sendVideoRecordingStatusResponse("req-123", false, "not_recording", null);
    }

    @Test
    public void stop_serviceUnavailable_returnsFalse() throws Exception {
        when(serviceManager.getMediaCaptureService()).thenReturn(null);

        boolean handled =
                handler.handleStopCommand(new JSONObject().put("requestId", "req-123"));

        assertThat(handled).isFalse();
        verify(streamingManager)
                .sendVideoRecordingStatusResponse("req-123", false, "service_unavailable", null);
    }
}
