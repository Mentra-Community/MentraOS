package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.app.Application;
import com.mentra.asg_client.io.bes.log.BesIncidentUploader;
import com.mentra.asg_client.io.bes.log.FileBackedBesIncidentAccess;
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

/** A BES incident uploads its stored bundle; a normal user report keeps the old behavior. */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class UploadIncidentLogsBesIncidentTest {
    private static final String KEY = "ML395018B-dump-0000002a-1f2e3d4c";
    private static final String REPORT = "rep_01JZWY3V8N0F2E9GQ4T6KXH5RD";
    private static final String API = "https://api.example.test/";

    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private FileBackedBesIncidentAccess access;
    private final ICompanionTransport bluetooth = mock(ICompanionTransport.class);
    private final AsgClientServiceManager services = mock(AsgClientServiceManager.class);
    private final K900CommandHandler bes = mock(K900CommandHandler.class);
    private final IConfigurationManager configuration = mock(IConfigurationManager.class);
    private final List<String> postedUrls = new ArrayList<>();
    private final List<String> postedAuth = new ArrayList<>();
    private final List<byte[]> postedBodies = new ArrayList<>();
    private final List<String> sentNames = new ArrayList<>();
    private final List<byte[]> sentBytes = new ArrayList<>();
    private int httpStatus = 200;
    private boolean httpThrows;
    private UploadIncidentLogsCommandHandler handler;

    @Before
    public void setUp() throws Exception {
        access = new FileBackedBesIncidentAccess(tmp.newFolder("bes_incident"));
        access.createStored(KEY, 1000L, "[CRASH-CONTEXT] v=2\ndump2\n", trace(6));
        access.markReported(KEY, REPORT);
        when(configuration.getCoreToken()).thenReturn("core-token");
        when(services.getBluetoothManager()).thenReturn(bluetooth);
        when(bluetooth.isConnected()).thenReturn(true);
        when(bluetooth.isFileTransferInProgress()).thenReturn(false);
        when(bluetooth.sendFile(anyString()))
                .thenAnswer(
                        invocation -> {
                            File file = new File(invocation.getArgument(0, String.class));
                            sentNames.add(file.getName());
                            sentBytes.add(Files.readAllBytes(file.toPath()));
                            return true;
                        });
        doAnswer(
                        invocation -> {
                            Consumer<String> callback = invocation.getArgument(4);
                            callback.accept("{\"source\":\"glasses_firmware\",\"entries\":[]}");
                            return null;
                        })
                .when(bes)
                .requestBesLogs(anyString(), any(), eq(configuration), anyString(), any());
        BesIncidentUploader.HttpPoster poster =
                (url, token, body) -> {
                    postedUrls.add(url);
                    postedAuth.add(token);
                    postedBodies.add(body);
                    if (httpThrows) {
                        throw new IOException("offline");
                    }
                    return httpStatus;
                };
        handler =
                new UploadIncidentLogsCommandHandler(
                        RuntimeEnvironment.getApplication(),
                        configuration,
                        bes,
                        null,
                        services,
                        new BesIncidentUploader(() -> access),
                        poster);
    }

    private static String trace(int lines) {
        StringBuilder text = new StringBuilder();
        for (int i = 0; i < lines; i++) {
            text.append(1759999000000L + i).append("\t1\t").append(i).append("\ttrace ").append(i).append('\n');
        }
        return text.toString();
    }

    private String state() {
        return access.find(KEY).optString("state");
    }

    @Test
    public void httpSuccessUploadsTheStoredBundleAndMarksUploaded() throws Exception {
        handler.uploadIncidentFirmwareOverHttp(REPORT, API);

        assertThat(postedUrls).containsExactly(API + "api/client/reports/" + REPORT + "/artifacts");
        assertThat(postedAuth).containsExactly("core-token");
        JSONObject body = new JSONObject(new String(postedBodies.get(0), StandardCharsets.UTF_8));
        assertThat(body.getString("source")).isEqualTo("glasses_firmware");
        assertThat(body.getString("retryKey")).isEqualTo("glasses_firmware:full");
        assertThat(body.getJSONArray("entries").getJSONObject(0).getString("source"))
                .isEqualTo("BES_CRASH");
        assertThat(state()).isEqualTo("UPLOADED");
        assertThat(sentNames).isEmpty();
        verify(bes, never()).requestBesLogs(anyString(), any(), any(), anyString(), any());
    }

    @Test
    public void rejectedHttpFallsBackToTheRelayBodyAndStaysReported() throws Exception {
        httpStatus = 503;

        handler.uploadIncidentFirmwareOverHttp(REPORT, API);

        assertThat(postedBodies).hasSize(1);
        assertThat(sentNames).containsExactly(BesIncidentUploader.relayFileBaseName(REPORT));
        JSONObject relay = new JSONObject(new String(sentBytes.get(0), StandardCharsets.UTF_8));
        assertThat(relay.getString("retryKey")).isEqualTo("glasses_firmware:relay");
        assertThat(sentBytes.get(0)).isNotEqualTo(postedBodies.get(0));
        // The glasses finishing the relay send is not an upload confirmation.
        assertThat(state()).isEqualTo("REPORTED");
        assertThat(access.find(KEY).getBoolean("uploaded")).isFalse();
    }

    @Test
    public void httpRetryAfterFailureSendsIdenticalBytesEvenWhenSourcesAreGone() throws Exception {
        httpStatus = 500;
        when(bluetooth.isConnected()).thenReturn(false); // no relay fallback in this test
        handler.uploadIncidentFirmwareOverHttp(REPORT, API);
        access.evictSources(KEY);
        httpStatus = 200;

        handler.uploadIncidentFirmwareOverHttp(REPORT, API);

        assertThat(postedBodies).hasSize(2);
        assertThat(postedBodies.get(1)).isEqualTo(postedBodies.get(0));
        assertThat(state()).isEqualTo("UPLOADED");
    }

    @Test
    public void networkErrorLeavesReported() throws Exception {
        httpThrows = true;
        when(bluetooth.isConnected()).thenReturn(false);

        handler.uploadIncidentFirmwareOverHttp(REPORT, API);

        assertThat(state()).isEqualTo("REPORTED");
    }

    @Test
    public void missingBundleDoesNotCrashOrMarkAnything() throws Exception {
        access.evictSources(KEY);

        handler.uploadIncidentFirmwareOverHttp(REPORT, API);
        handler.relayLogsViaBle(REPORT);

        assertThat(postedBodies).isEmpty();
        assertThat(state()).isEqualTo("REPORTED");
        assertThat(access.find(KEY).getBoolean("uploaded")).isFalse();
        verify(bes, never()).requestBesLogs(anyString(), any(), any(), anyString(), any());
    }

    @Test
    public void bleRelaySendsThePersistedRelayBodyThenJavaLogsWithoutMhLogs() throws Exception {
        handler.relayLogsViaBle(REPORT);

        String firmwareName = BesIncidentUploader.relayFileBaseName(REPORT);
        assertThat(sentNames).containsExactly(firmwareName, "L" + firmwareName.substring(1));
        File persisted = new File(access.bundleDir(KEY), "upload-relay.json");
        assertThat(sentBytes.get(0)).isEqualTo(Files.readAllBytes(persisted.toPath()));
        assertThat(state()).isEqualTo("REPORTED");
        verify(bes, never()).requestBesLogs(anyString(), any(), any(), anyString(), any());

        handler.relayLogsViaBle(REPORT); // a retry resends the same persisted bytes
        assertThat(sentBytes.get(2)).isEqualTo(sentBytes.get(0));
        assertThat(access.recordArtifactCalls).isEqualTo(1);
    }

    @Test
    public void alreadyUploadedIncidentSendsNoFirmwareAndNoMhLogs() throws Exception {
        access.markUploaded(KEY);

        handler.relayLogsViaBle(REPORT);

        assertThat(sentNames).hasSize(1);
        assertThat(sentNames.get(0)).startsWith("L");
        verify(bes, never()).requestBesLogs(anyString(), any(), any(), anyString(), any());
        handler.uploadIncidentFirmwareOverHttp(REPORT, API);
        assertThat(postedBodies).isEmpty();
    }

    @Test
    public void anEvictedIncidentIsNotAnsweredWithTheCurrentBesLog() throws Exception {
        access.evict(KEY);

        handler.relayLogsViaBle(REPORT);
        handler.uploadIncidentFirmwareOverHttp(REPORT, API);

        // Only the Java logs go out; the BES ring now holds something else and is not read.
        verify(bes, never()).requestBesLogs(anyString(), any(), any(), anyString(), any());
        assertThat(postedBodies).isEmpty();
        assertThat(sentNames).hasSize(1);
        assertThat(sentNames.get(0)).startsWith("L");
    }

    @Test
    public void userBugReportKeepsTheLegacyMhLogsPath() throws Exception {
        handler.relayLogsViaBle("rep_user_bug_report");

        verify(bes).requestBesLogs(eq("rep_user_bug_report"), any(), eq(configuration), eq(""), any(Consumer.class));
        assertThat(sentNames).hasSize(2);
        assertThat(sentNames.get(0)).startsWith("B");
        assertThat(access.recordArtifactCalls).isZero();
        assertThat(state()).isEqualTo("REPORTED");
    }
}
