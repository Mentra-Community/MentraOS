package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.nullable;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.camera.model.PhotoCaptureSettings;
import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class PhotoCommandHandlerTransferMethodTest {

    @Rule public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    private MediaCaptureService captureService;
    private PhotoCommandHandler handler;

    @Before
    public void setUp() {
        AsgClientServiceManager serviceManager = mock(AsgClientServiceManager.class);
        FileManager fileManager = mock(FileManager.class);
        IStateManager stateManager = mock(IStateManager.class);
        captureService = mock(MediaCaptureService.class);

        when(serviceManager.getMediaCaptureService()).thenReturn(captureService);
        when(fileManager.getPackageDirectory("com.example.app"))
                .thenReturn(temporaryFolder.getRoot());
        when(fileManager.ensurePackageDirectoryExists("com.example.app")).thenReturn(true);
        when(stateManager.getBatteryLevel()).thenReturn(-1);

        when(captureService.takePhotoAutoTransfer(
                        anyString(),
                        anyString(),
                        anyString(),
                        anyString(),
                        anyString(),
                        anyBoolean(),
                        anyString(),
                        anyString(),
                        anyBoolean(),
                        anyBoolean(),
                        anyString(),
                        nullable(Long.class),
                        nullable(Integer.class),
                        any(PhotoCaptureSettings.class)))
                .thenReturn(true);
        when(captureService.takePhotoAndUpload(
                        anyString(),
                        anyString(),
                        anyString(),
                        anyString(),
                        anyBoolean(),
                        anyString(),
                        anyString(),
                        anyBoolean(),
                        anyBoolean(),
                        anyString(),
                        nullable(Long.class),
                        nullable(Integer.class),
                        any(PhotoCaptureSettings.class)))
                .thenReturn(true);

        handler = new PhotoCommandHandler(null, serviceManager, fileManager, stateManager);
    }

    private JSONObject takePhotoData() throws Exception {
        return new JSONObject()
                .put("requestId", "req-1")
                .put("packageName", "com.example.app")
                .put("webhookUrl", "https://example.com/upload")
                .put("bleImgId", "ble-1");
    }

    @Test
    public void takePhoto_omittedTransferMethod_defaultsToAuto() throws Exception {
        assertThat(handler.handleCommand("take_photo", takePhotoData())).isTrue();

        verify(captureService)
                .takePhotoAutoTransfer(
                        anyString(),
                        eq("req-1"),
                        eq("https://example.com/upload"),
                        eq(""),
                        eq("ble-1"),
                        eq(false),
                        eq("medium"),
                        eq("photo"),
                        eq(true),
                        eq(true),
                        anyString(),
                        nullable(Long.class),
                        nullable(Integer.class),
                        any(PhotoCaptureSettings.class));
    }

    @Test
    public void takePhoto_nullTransferMethod_isRejected() throws Exception {
        JSONObject data = takePhotoData().put("transferMethod", JSONObject.NULL);

        assertThat(handler.handleCommand("take_photo", data)).isFalse();
        verify(captureService)
                .sendPhotoErrorResponse(eq("req-1"), eq("INVALID_TRANSFER_METHOD"), anyString());
    }

    @Test
    public void takePhoto_validDirectTransferMethod_isAccepted() throws Exception {
        JSONObject data = takePhotoData().put("transferMethod", "direct");

        assertThat(handler.handleCommand("take_photo", data)).isTrue();
        verify(captureService)
                .takePhotoAndUpload(
                        anyString(),
                        eq("req-1"),
                        eq("https://example.com/upload"),
                        eq(""),
                        eq(false),
                        eq("medium"),
                        eq("photo"),
                        eq(true),
                        eq(true),
                        anyString(),
                        nullable(Long.class),
                        nullable(Integer.class),
                        any(PhotoCaptureSettings.class));
    }

    @Test
    public void takePhoto_invalidTransferMethod_isRejected() throws Exception {
        JSONObject data = takePhotoData().put("transferMethod", "wifi");

        assertThat(handler.handleCommand("take_photo", data)).isFalse();
        verify(captureService)
                .sendPhotoErrorResponse(eq("req-1"), eq("INVALID_TRANSFER_METHOD"), anyString());
    }
}
