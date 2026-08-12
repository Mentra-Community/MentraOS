package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.content.Context;
import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.io.media.managers.MediaUploadQueueManager;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.pairing.PairingTransferCaptureGate;
import java.io.File;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.mockito.ArgumentCaptor;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class WipeMediaCommandHandlerTest {

    @Rule public TemporaryFolder tempFolder = new TemporaryFolder();

    private ICommunicationManager communicationManager;
    private AsgClientServiceManager serviceManager;
    private FileManager fileManager;
    private MediaUploadQueueManager queueManager;
    private MediaCaptureService captureService;
    private WipeMediaCommandHandler handler;
    private File mediaDir;
    private Context context;

    @Before
    public void setUp() throws Exception {
        communicationManager = mock(ICommunicationManager.class);
        serviceManager = mock(AsgClientServiceManager.class);
        fileManager = mock(FileManager.class);
        queueManager = mock(MediaUploadQueueManager.class);
        captureService = mock(MediaCaptureService.class);
        context = RuntimeEnvironment.getApplication();

        mediaDir = tempFolder.newFolder("media");
        when(fileManager.getDefaultMediaDirectory()).thenReturn(mediaDir);
        when(fileManager.getThumbnailManager()).thenReturn(null);
        when(serviceManager.getMediaQueueManager()).thenReturn(queueManager);
        when(serviceManager.getMediaCaptureService()).thenReturn(captureService);
        when(serviceManager.getContext()).thenReturn(context);
        when(communicationManager.sendBluetoothResponse(any(JSONObject.class))).thenReturn(true);
        when(captureService.isRecordingVideo()).thenReturn(false);

        handler = new WipeMediaCommandHandler(communicationManager, serviceManager, fileManager);
        WipeMediaCommandHandler.clearCaptureBarrier(context);
    }

    @Test
    public void wipeMedia_disabledSkipsDeleteAndReportsSuccess() throws Exception {
        // ENABLE_PAIRING_MEDIA_WIPE is currently false — wipe code retained but inactive.
        File photo = new File(mediaDir, "IMG_test/base.jpg");
        assertThat(photo.getParentFile().mkdirs()).isTrue();
        assertThat(photo.createNewFile()).isTrue();

        JSONObject command = new JSONObject();
        command.put("request_id", "req-1");
        command.put("transfer_id", "ABCDEF0123456789");

        boolean handled = handler.handleCommand("wipe_media", command);
        assertThat(handled).isTrue();
        assertThat(photo.exists()).isTrue();
        assertThat(WipeMediaCommandHandler.isCaptureBarrierActive(context)).isTrue();

        ArgumentCaptor<JSONObject> captor = ArgumentCaptor.forClass(JSONObject.class);
        verify(communicationManager).sendBluetoothResponse(captor.capture());
        JSONObject response = captor.getValue();
        assertThat(response.getBoolean("success")).isTrue();
        assertThat(response.getString("transfer_id")).isEqualTo("ABCDEF0123456789");
        assertThat(response.getString("request_id")).isEqualTo("req-1");
    }

    @Test
    public void wipeMedia_disabledDoesNotStopRecording() throws Exception {
        when(captureService.isRecordingVideo()).thenReturn(true);

        JSONObject command = new JSONObject().put("transfer_id", "1122334455667788");
        assertThat(handler.handleCommand("wipe_media", command)).isTrue();
        verify(captureService, never()).cancelInFlightCapturesForPairingWipe();
        verify(captureService, never()).stopVideoRecording();
    }

    @Test
    public void pairingFinalize_clearsCaptureBarrier() throws Exception {
        PairingTransferCaptureGate.arm(context, "ABCDEF0123456789");
        assertThat(WipeMediaCommandHandler.isCaptureBarrierActive(context)).isTrue();

        assertThat(handler.handleCommand(
                        "pairing_finalize", new JSONObject().put("transfer_id", "ABCDEF0123456789")))
                .isTrue();
        assertThat(WipeMediaCommandHandler.isCaptureBarrierActive(context)).isFalse();
        verify(communicationManager, never()).sendBluetoothResponse(any(JSONObject.class));
    }

    @Test
    public void pairingFinalize_wrongTransferIdLeavesCaptureBarrierArmed() throws Exception {
        PairingTransferCaptureGate.arm(context, "ABCDEF0123456789");

        assertThat(handler.handleCommand(
                        "pairing_finalize", new JSONObject().put("transfer_id", "wrong-transfer")))
                .isTrue();
        assertThat(WipeMediaCommandHandler.isCaptureBarrierActive(context)).isTrue();
    }

    @Test
    public void pairingAbort_clearsCaptureBarrier() throws Exception {
        PairingTransferCaptureGate.arm(context, "1122334455667788");
        assertThat(WipeMediaCommandHandler.isCaptureBarrierActive(context)).isTrue();

        assertThat(handler.handleCommand(
                        "pairing_abort", new JSONObject().put("transfer_id", "1122334455667788")))
                .isTrue();
        assertThat(WipeMediaCommandHandler.isCaptureBarrierActive(context)).isFalse();
    }

    @Test
    public void pairingAbort_emptyTransferIdLeavesCaptureBarrierArmed() {
        PairingTransferCaptureGate.arm(context, "1122334455667788");

        assertThat(handler.handleCommand("pairing_abort", new JSONObject())).isTrue();
        assertThat(WipeMediaCommandHandler.isCaptureBarrierActive(context)).isTrue();
    }

    @Test
    public void unsupportedCommandType_rejected() {
        assertThat(handler.handleCommand("not_wipe", new JSONObject())).isFalse();
    }
}
