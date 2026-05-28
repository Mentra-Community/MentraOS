package com.mentra.asg_client.service.core.handlers;

import static org.mockito.Mockito.verify;

import android.content.Context;

import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;

import org.junit.Test;
import org.mockito.Mockito;

import java.lang.reflect.Method;

public class PhotoCommandHandlerTest {

    private PhotoCommandHandler createHandler() {
        Context context = Mockito.mock(Context.class);
        AsgClientServiceManager serviceManager = Mockito.mock(AsgClientServiceManager.class);
        FileManager fileManager = Mockito.mock(FileManager.class);
        IStateManager stateManager = Mockito.mock(IStateManager.class);
        return new PhotoCommandHandler(context, serviceManager, fileManager, stateManager);
    }

    @Test
    public void processPhotoCapture_forwardsIncludeImuToBleTransfer() throws Exception {
        PhotoCommandHandler handler = createHandler();
        MediaCaptureService captureService = Mockito.mock(MediaCaptureService.class);

        Method method =
                PhotoCommandHandler.class.getDeclaredMethod(
                        "processPhotoCapture",
                        MediaCaptureService.class,
                        String.class,
                        String.class,
                        String.class,
                        String.class,
                        String.class,
                        boolean.class,
                        String.class,
                        String.class,
                        boolean.class,
                        boolean.class,
                        String.class,
                        boolean.class,
                        Long.class);
        method.setAccessible(true);
        method.invoke(
                handler,
                captureService,
                "/tmp/p.jpg",
                "req-1",
                "",
                "",
                "ble-1",
                false,
                "medium",
                "ble",
                true,
                true,
                "none",
                true,
                null);

        verify(captureService)
                .takePhotoForBleTransfer(
                        "/tmp/p.jpg", "req-1", "ble-1", false, "medium", true, true, true, null);
    }

    @Test
    public void processPhotoCapture_forwardsIncludeImuToDirectUpload() throws Exception {
        PhotoCommandHandler handler = createHandler();
        MediaCaptureService captureService = Mockito.mock(MediaCaptureService.class);

        Method method =
                PhotoCommandHandler.class.getDeclaredMethod(
                        "processPhotoCapture",
                        MediaCaptureService.class,
                        String.class,
                        String.class,
                        String.class,
                        String.class,
                        String.class,
                        boolean.class,
                        String.class,
                        String.class,
                        boolean.class,
                        boolean.class,
                        String.class,
                        boolean.class,
                        Long.class);
        method.setAccessible(true);
        method.invoke(
                handler,
                captureService,
                "/tmp/p2.jpg",
                "req-2",
                "https://example.com",
                "token",
                "ble-2",
                true,
                "large",
                "direct",
                true,
                false,
                "medium",
                false,
                1000L);

        verify(captureService)
                .takePhotoAndUpload(
                        "/tmp/p2.jpg",
                        "req-2",
                        "https://example.com",
                        "token",
                        true,
                        "large",
                        true,
                        false,
                        "medium",
                        false,
                        1000L);
    }
}
