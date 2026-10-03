package com.mentra.asg_client.io.server.services;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.file.core.FileManager.FileMetadata;
import com.mentra.asg_client.io.server.interfaces.CacheManager;
import com.mentra.asg_client.io.server.interfaces.NetworkProvider;
import com.mentra.asg_client.io.server.interfaces.RateLimiter;
import com.mentra.asg_client.io.server.interfaces.ServerConfig;
import com.mentra.asg_client.logging.Logger;
import fi.iki.elonen.NanoHTTPD;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(manifest = Config.NONE, sdk = 33)
public class GalleryManifestTest {
    @Rule public TemporaryFolder temp = new TemporaryFolder();
    private FileManager files;
    private AsgCameraServer server;

    @Before
    public void setUp() throws Exception {
        files = mock(FileManager.class);
        when(files.getDefaultPackageName()).thenReturn("gallery");
        when(files.getPackageDirectory("gallery")).thenReturn(temp.newFolder("gallery"));
        server = new AsgCameraServer(mock(ServerConfig.class), mock(NetworkProvider.class),
                mock(CacheManager.class), mock(RateLimiter.class), mock(Logger.class), files);
    }

    private void populate(int count) {
        List<FileMetadata> captures = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            String name = "IMG_" + i + "/base.jpg";
            captures.add(new FileMetadata(name, "/gallery/" + name, 100, i + 1,
                    "image/jpeg", "gallery"));
        }
        when(files.listFiles("gallery")).thenReturn(captures);
    }

    private JSONObject request(String uri, Map<String, String> params) throws Exception {
        NanoHTTPD.IHTTPSession session = mock(NanoHTTPD.IHTTPSession.class);
        when(session.getUri()).thenReturn(uri);
        when(session.getMethod()).thenReturn(NanoHTTPD.Method.GET);
        when(session.getParms()).thenReturn(params);
        when(session.getHeaders()).thenReturn(Collections.emptyMap());
        NanoHTTPD.Response response = server.serve(session);
        assertThat(response.getStatus()).isEqualTo(NanoHTTPD.Response.Status.OK);
        return new JSONObject(new String(response.getData().readAllBytes(), StandardCharsets.UTF_8))
                .getJSONObject("data");
    }

    @Test
    public void incidentSizedGalleryNeedsOnlyOneListing() throws Exception {
        populate(310);
        int limit = request("/api/v3/capabilities", Collections.emptyMap())
                .getInt("max_manifest_page_size");
        JSONObject manifest = request("/api/v3/manifest", Map.of("limit", String.valueOf(limit)));
        assertThat(manifest.getJSONArray("captures").length()).isEqualTo(310);
        assertThat(manifest.getInt("total_count")).isEqualTo(310);
        assertThat(manifest.getBoolean("has_more")).isFalse();
        verify(files, times(1)).listFiles("gallery");
    }

    @Test
    public void oversizedRequestsStayBoundedAndRetainKeysetPagination() throws Exception {
        populate(501);
        JSONObject first = request("/api/v3/manifest", Map.of("limit", "100000"));
        assertThat(first.getJSONArray("captures").length()).isEqualTo(500);
        assertThat(first.getBoolean("has_more")).isTrue();
        JSONObject second = request("/api/v3/manifest",
                Map.of("limit", "500", "cursor", first.getString("next_cursor")));
        assertThat(second.getJSONArray("captures").length()).isEqualTo(1);
        assertThat(second.getJSONArray("captures").getJSONObject(0).getString("capture_id"))
                .isEqualTo("IMG_0");
        assertThat(second.getBoolean("has_more")).isFalse();
    }

    @Test
    public void omittedLimitKeepsExistingDefault() throws Exception {
        populate(310);
        JSONObject manifest = request("/api/v3/manifest", Collections.emptyMap());
        assertThat(manifest.getJSONArray("captures").length()).isEqualTo(50);
        assertThat(manifest.getBoolean("has_more")).isTrue();
    }
}
