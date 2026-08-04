package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
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
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Verifies that {@code start_video_recording} validates the optional {@code maxRecordingTimeMinutes}
 * auto-stop timer before forwarding it to {@link MediaCaptureService}. A negative value means "no
 * limit" and an out-of-range value is capped, so the downstream {@code minutes * 60 * 1000L} timer
 * math can't overflow to a negative duration and immediately stop the recording.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class VideoCommandHandlerStartValidationTest {

    // Keep in sync with VideoCommandHandler.MAX_RECORDING_TIME_MINUTES.
    private static final int MAX_RECORDING_TIME_MINUTES = 24 * 60;

    private MediaCaptureService captureService;
    private VideoCommandHandler handler;

    @Before
    public void setUp() {
        AsgClientServiceManager serviceManager = mock(AsgClientServiceManager.class);
        IMediaManager streamingManager = mock(IMediaManager.class);
        IStateManager stateManager = mock(IStateManager.class);
        captureService = mock(MediaCaptureService.class);

        when(serviceManager.getMediaCaptureService()).thenReturn(captureService);
        when(captureService.isRecordingVideo()).thenReturn(false);
        // -1 → battery unknown, skip the low-battery rejection so the start path runs.
        when(stateManager.getBatteryLevel()).thenReturn(-1);

        handler =
                new VideoCommandHandler(
                        null, serviceManager, streamingManager, null, stateManager);
    }

    private JSONObject startData(int maxRecordingTimeMinutes) throws Exception {
        // packageName is supplied so resolvePackageName never touches the (null) FileManager;
        // no "settings" object → videoSettings stays null (the default path).
        return new JSONObject()
                .put("requestId", "req-1")
                .put("packageName", "com.example.app")
                .put("maxRecordingTimeMinutes", maxRecordingTimeMinutes);
    }

    @Test
    public void start_negativeMaxTime_clampedToZero() throws Exception {
        boolean handled = handler.handleCommand("start_video_recording", startData(-5));

        assertThat(handled).isTrue();
        verify(captureService)
                .handleStartVideoCommand(
                        eq("req-1"),
                        anyBoolean(),
                        isNull(),
                        anyBoolean(),
                        anyBoolean(),
                        eq(0));
    }

    @Test
    public void start_overCap_clampedToMax() throws Exception {
        boolean handled =
                handler.handleCommand("start_video_recording", startData(Integer.MAX_VALUE));

        assertThat(handled).isTrue();
        verify(captureService)
                .handleStartVideoCommand(
                        eq("req-1"),
                        anyBoolean(),
                        isNull(),
                        anyBoolean(),
                        anyBoolean(),
                        eq(MAX_RECORDING_TIME_MINUTES));
    }

    @Test
    public void start_inRangeMaxTime_passedThrough() throws Exception {
        boolean handled = handler.handleCommand("start_video_recording", startData(5));

        assertThat(handled).isTrue();
        verify(captureService)
                .handleStartVideoCommand(
                        eq("req-1"),
                        anyBoolean(),
                        isNull(),
                        anyBoolean(),
                        anyBoolean(),
                        eq(5));
    }
}
