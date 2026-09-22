package com.mentra.asg_client.io.server.services;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.server.core.DefaultServerFactory;
import androidx.test.core.app.ApplicationProvider;
import org.json.JSONObject;
import com.mentra.asg_client.logging.Logger;
import fi.iki.elonen.NanoHTTPD;
import java.io.File;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;
import java.util.Map;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 33)
public class GalleryServerApiTest {
    @Rule public TemporaryFolder temp = new TemporaryFolder();
    private FileManager files;
    private AsgCameraServer server;
    private File galleryDirectory;

    @Before
    public void setUp() throws Exception {
        files = mock(FileManager.class);
        when(files.getDefaultPackageName()).thenReturn("gallery");
        galleryDirectory = temp.newFolder("gallery");
        when(files.getPackageDirectory("gallery")).thenReturn(galleryDirectory);
        when(files.listFiles("gallery")).thenReturn(List.of());
        server = DefaultServerFactory.createCameraWebServer(
                0, "CameraWebServer", ApplicationProvider.getApplicationContext(), mock(Logger.class), files);
    }

    @After
    public void tearDown() {
        server.stopServer();
    }

    @Test
    public void networkClientCanListAndResumeADownloadWithoutCredentials() throws Exception {
        File photo = temp.newFile("photo.jpg");
        Files.write(photo.toPath(), "0123456789".getBytes(StandardCharsets.UTF_8));
        when(files.getFile("gallery", "IMG_1/photo.jpg")).thenReturn(photo);
        assertThat(server.startServer()).isTrue();
        String base = "http://127.0.0.1:" + server.getListeningPort();

        HttpURLConnection list = (HttpURLConnection) new URL(base + "/api/gallery").openConnection();
        list.setReadTimeout(5000);
        try {
            assertThat(list.getResponseCode()).isEqualTo(200);
            assertThat(new String(list.getInputStream().readAllBytes(), StandardCharsets.UTF_8))
                    .contains("\"total_count\":0");
        } finally {
            list.disconnect();
        }

        HttpURLConnection download = (HttpURLConnection) new URL(
                base + "/api/download?file=IMG_1%2Fphoto.jpg").openConnection();
        download.setReadTimeout(5000);
        download.setRequestProperty("Range", "bytes=3-6");
        try {
            assertThat(download.getResponseCode()).isEqualTo(206);
            assertThat(download.getHeaderField("Content-Range")).isEqualTo("bytes 3-6/10");
            assertThat(new String(download.getInputStream().readAllBytes(), StandardCharsets.UTF_8))
                    .isEqualTo("3456");
        } finally {
            download.disconnect();
        }
    }

    @Test
    public void existingCameraAndStatusRoutesRemainAvailable() {
        AsgCameraServer.OnPictureRequestListener camera = mock(AsgCameraServer.OnPictureRequestListener.class);
        server.setOnPictureRequestListener(camera);
        assertThat(request("/api/take-picture", NanoHTTPD.Method.POST).getStatus())
                .isEqualTo(NanoHTTPD.Response.Status.OK);
        verify(camera).onPictureRequest();
        assertThat(request("/api/health", NanoHTTPD.Method.GET).getStatus())
                .isEqualTo(NanoHTTPD.Response.Status.OK);
        assertThat(request("/api/delete-files", NanoHTTPD.Method.GET).getStatus())
                .isEqualTo(NanoHTTPD.Response.Status.METHOD_NOT_ALLOWED);
        assertThat(request("/api/future-route", NanoHTTPD.Method.GET).getStatus())
                .isEqualTo(NanoHTTPD.Response.Status.NOT_FOUND);
    }

    @Test
    public void existingDeleteApiMovesCaptureToTrashOverHttp() throws Exception {
        File capture = new File(galleryDirectory, "IMG_1");
        assertThat(capture.mkdir()).isTrue();
        Files.write(new File(capture, "photo.jpg").toPath(), new byte[] {1, 2, 3});
        assertThat(server.startServer()).isTrue();
        HttpURLConnection delete = (HttpURLConnection) new URL(
                "http://127.0.0.1:" + server.getListeningPort() + "/api/delete-files").openConnection();
        delete.setReadTimeout(5000);
        delete.setRequestMethod("POST");
        delete.setDoOutput(true);
        delete.setRequestProperty("Content-Type", "application/json");
        try {
            try (java.io.OutputStream output = delete.getOutputStream()) {
                output.write("{\"files\":[\"IMG_1/photo.jpg\"]}".getBytes(StandardCharsets.UTF_8));
            }
            assertThat(delete.getResponseCode()).isEqualTo(200);
            JSONObject response = new JSONObject(new String(
                    delete.getInputStream().readAllBytes(), StandardCharsets.UTF_8));
            assertThat(response.getString("status")).isEqualTo("success");
            assertThat(capture.exists()).isFalse();
            assertThat(new File(galleryDirectory, FileManager.GALLERY_TRASH_DIR_NAME + "/IMG_1/photo.jpg"))
                    .exists();
        } finally {
            delete.disconnect();
        }
    }

    @Test
    public void inProgressRecordingsRemainUndownloadable() {
        server.setActiveRecordingProvider(() -> "VID_1");
        NanoHTTPD.IHTTPSession session = mock(NanoHTTPD.IHTTPSession.class);
        when(session.getUri()).thenReturn("/api/download");
        when(session.getMethod()).thenReturn(NanoHTTPD.Method.GET);
        when(session.getHeaders()).thenReturn(Map.of());
        when(session.getParms()).thenReturn(Map.of("file", "VID_1/video.mp4"));
        assertThat(server.serve(session).getStatus()).isEqualTo(NanoHTTPD.Response.Status.FORBIDDEN);
    }

    private NanoHTTPD.Response request(String path, NanoHTTPD.Method method) {
        NanoHTTPD.IHTTPSession session = mock(NanoHTTPD.IHTTPSession.class);
        when(session.getRemoteIpAddress()).thenReturn("127.0.0.1");
        when(session.getUri()).thenReturn(path);
        when(session.getMethod()).thenReturn(method);
        when(session.getHeaders()).thenReturn(Map.of());
        when(session.getParms()).thenReturn(Map.of());
        return server.serve(session);
    }
}
