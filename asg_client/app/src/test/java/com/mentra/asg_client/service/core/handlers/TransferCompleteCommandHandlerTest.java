package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Verifies {@link TransferCompleteCommandHandler} forwards phone confirmations through the {@link
 * ICompanionTransport} interface. Uses a plain transport mock (NOT a K900 type) — the regression
 * guard for the old {@code (K900BluetoothManager)} cast, which would have thrown {@code
 * ClassCastException} here.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class TransferCompleteCommandHandlerTest {

    private AsgClientServiceManager serviceManager;
    private ICompanionTransport transport;
    private MediaCaptureService mediaCaptureService;
    private TransferCompleteCommandHandler handler;

    @Before
    public void setUp() {
        serviceManager = mock(AsgClientServiceManager.class);
        transport = mock(ICompanionTransport.class);
        mediaCaptureService = mock(MediaCaptureService.class);
        when(serviceManager.getBluetoothManager()).thenReturn(transport);
        when(serviceManager.getMediaCaptureService()).thenReturn(mediaCaptureService);
        handler = new TransferCompleteCommandHandler(serviceManager);
    }

    @Test
    public void transferComplete_success_forwardedToTransport() throws Exception {
        boolean handled =
                handler.handleCommand(
                        "transfer_complete",
                        new JSONObject().put("fileName", "photo.jpg").put("success", true));

        assertThat(handled).isTrue();
        verify(transport).onFileTransferConfirmation("photo.jpg", true);
        verify(mediaCaptureService).onBlePhotoTransferComplete("photo.jpg", true);
    }

    @Test
    public void transferComplete_failure_forwardedToTransport() throws Exception {
        boolean handled =
                handler.handleCommand(
                        "transfer_complete",
                        new JSONObject().put("fileName", "video.mp4").put("success", false));

        assertThat(handled).isTrue();
        verify(transport).onFileTransferConfirmation("video.mp4", false);
        verify(mediaCaptureService).onBlePhotoTransferComplete("video.mp4", false);
    }

    @Test
    public void transferComplete_failureRetry_defersTerminalPhotoTiming() throws Exception {
        when(transport.isFileTransferInProgress()).thenReturn(true);

        boolean handled =
                handler.handleCommand(
                        "transfer_complete",
                        new JSONObject().put("fileName", "photo.jpg").put("success", false));

        assertThat(handled).isTrue();
        verify(transport).onFileTransferConfirmation("photo.jpg", false);
        verify(mediaCaptureService, never()).onBlePhotoTransferComplete(anyString(), anyBoolean());
    }

    @Test
    public void transferComplete_missingFileName_rejected() throws Exception {
        boolean handled =
                handler.handleCommand("transfer_complete", new JSONObject().put("success", true));

        assertThat(handled).isFalse();
        verify(transport, never()).onFileTransferConfirmation(anyString(), anyBoolean());
    }

    @Test
    public void transferComplete_transportUnavailable_failsGracefully() throws Exception {
        when(serviceManager.getBluetoothManager()).thenReturn(null);

        boolean handled =
                handler.handleCommand(
                        "transfer_complete",
                        new JSONObject().put("fileName", "photo.jpg").put("success", true));

        assertThat(handled).isFalse();
    }
}
