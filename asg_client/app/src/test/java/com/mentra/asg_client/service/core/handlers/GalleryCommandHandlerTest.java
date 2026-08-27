package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class GalleryCommandHandlerTest {
    @Test
    public void reportsGalleryFromSharedFileManagerWithoutCameraServer() {
        AsgClientServiceManager serviceManager = mock(AsgClientServiceManager.class);
        ICommunicationManager communicationManager = mock(ICommunicationManager.class);
        FileManager fileManager = mock(FileManager.class);
        AtomicReference<JSONObject> response = new AtomicReference<>();
        when(serviceManager.getFileManager()).thenReturn(fileManager);
        when(fileManager.getDefaultPackageName()).thenReturn("com.mentra");
        when(fileManager.listFiles("com.mentra"))
                .thenReturn(
                        List.of(
                                new FileManager.FileMetadata(
                                        "IMG_1/photo.jpg",
                                        "/gallery/IMG_1/photo.jpg",
                                        123L,
                                        1L,
                                        "image/jpeg",
                                        "com.mentra")));
        when(communicationManager.sendBluetoothResponse(any(JSONObject.class)))
                .thenAnswer(
                        invocation -> {
                            response.set(invocation.getArgument(0));
                            return true;
                        });

        GalleryCommandHandler handler =
                new GalleryCommandHandler(serviceManager, communicationManager);

        assertThat(handler.handleCommand("query_gallery_status", new JSONObject())).isTrue();
        assertThat(response.get().optInt("photos")).isEqualTo(1);
        assertThat(response.get().optBoolean("has_content")).isTrue();
        verify(serviceManager).getFileManager();
    }
}
