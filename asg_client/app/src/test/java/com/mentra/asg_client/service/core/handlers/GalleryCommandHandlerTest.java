package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.ArgumentMatchers.anyBoolean;
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
    public void galleryServerAckSeparatesSavedSettingFromCurrentListener() throws Exception {
        AsgClientServiceManager manager = mock(AsgClientServiceManager.class);
        ICommunicationManager communication = mock(ICommunicationManager.class);
        AtomicReference<JSONObject> response = new AtomicReference<>();
        when(communication.sendBluetoothResponse(any(JSONObject.class))).thenAnswer(call -> {
            response.set(call.getArgument(0));
            return true;
        });
        when(manager.setGalleryServerEnabled(true)).thenReturn(true);
        when(manager.isGalleryServerEnabled()).thenReturn(true);
        GalleryCommandHandler handler = new GalleryCommandHandler(manager, communication);
        JSONObject request = new JSONObject().put("request_id", "enable-1").put("enabled", true);

        handler.handleCommand("set_gallery_server_enabled", request);

        assertThat(response.get().getString("request_id")).isEqualTo("enable-1");
        assertThat(response.get().getString("setting")).isEqualTo("gallery_server");
        assertThat(response.get().getString("status")).isEqualTo("applied");
        assertThat(response.get().getBoolean("enabled")).isTrue();
        assertThat(response.get().getBoolean("listening")).isFalse();
        assertThat(response.get().has("url")).isFalse();

        when(manager.getGalleryServerUrl()).thenReturn("http://10.1.2.3:8089");
        handler.handleCommand("set_gallery_server_enabled", request);
        assertThat(response.get().getBoolean("listening")).isTrue();
        assertThat(response.get().getString("url")).isEqualTo("http://10.1.2.3:8089");

        when(manager.setGalleryServerEnabled(false)).thenReturn(true);
        when(manager.isGalleryServerEnabled()).thenReturn(false);
        when(manager.getGalleryServerUrl()).thenReturn(null);
        handler.handleCommand("set_gallery_server_enabled",
                new JSONObject().put("request_id", "disable-2").put("enabled", false));
        assertThat(response.get().getString("request_id")).isEqualTo("disable-2");
        assertThat(response.get().getBoolean("enabled")).isFalse();
        assertThat(response.get().getBoolean("listening")).isFalse();
    }

    @Test
    public void galleryServerRejectsMalformedRequestsWithoutChangingSettings() throws Exception {
        AsgClientServiceManager manager = mock(AsgClientServiceManager.class);
        ICommunicationManager communication = mock(ICommunicationManager.class);
        AtomicReference<JSONObject> response = new AtomicReference<>();
        when(communication.sendBluetoothResponse(any(JSONObject.class))).thenAnswer(call -> {
            response.set(call.getArgument(0));
            return true;
        });
        GalleryCommandHandler handler = new GalleryCommandHandler(manager, communication);
        for (JSONObject request : List.of(
                new JSONObject().put("enabled", true),
                new JSONObject().put("request_id", "a"),
                new JSONObject().put("request_id", "a").put("enabled", "true"),
                new JSONObject().put("request_id", "a").put("enabled", JSONObject.NULL))) {
            handler.handleCommand("set_gallery_server_enabled", request);
            assertThat(response.get().getString("error_code")).isEqualTo("invalid_request");
        }
        verify(manager, never()).setGalleryServerEnabled(anyBoolean());
    }

    @Test
    public void galleryServerPersistenceFailureReturnsError() throws Exception {
        AsgClientServiceManager manager = mock(AsgClientServiceManager.class);
        ICommunicationManager communication = mock(ICommunicationManager.class);
        AtomicReference<JSONObject> response = new AtomicReference<>();
        when(communication.sendBluetoothResponse(any(JSONObject.class))).thenAnswer(call -> {
            response.set(call.getArgument(0));
            return true;
        });
        new GalleryCommandHandler(manager, communication).handleCommand("set_gallery_server_enabled",
                new JSONObject().put("request_id", "a").put("enabled", true));
        assertThat(response.get().getString("status")).isEqualTo("error");
        assertThat(response.get().getString("error_code")).isEqualTo("settings_unavailable");
    }

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
