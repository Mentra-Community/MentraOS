package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import android.app.Application;
import com.mentra.asg_client.io.bes.log.FileBackedBesIncidentAccess;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class BesCrashReportedCommandHandlerTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private FileBackedBesIncidentAccess access;
    private final List<JSONObject> acks = new ArrayList<>();
    private BesCrashReportedCommandHandler handler;

    @Before
    public void setUp() throws Exception {
        access = new FileBackedBesIncidentAccess(tmp.newFolder("bes_incident"));
        ICommunicationManager comms = mock(ICommunicationManager.class);
        when(comms.sendBluetoothResponse(any(JSONObject.class)))
                .thenAnswer(
                        invocation -> {
                            acks.add(invocation.getArgument(0));
                            return true;
                        });
        handler = new BesCrashReportedCommandHandler(comms, () -> access);
        access.createStored("k1", 100L, "dump\n", "1\t1\t0\ttrace\n");
    }

    private boolean report(String key, String reportId) throws Exception {
        return handler.handleCommand(
                "bes_crash_reported",
                new JSONObject()
                        .put("type", "bes_crash_reported")
                        .put("incidentKey", key)
                        .put("reportId", reportId));
    }

    @Test
    public void persistsTheReportIdAndAcksOk() throws Exception {
        assertThat(report("k1", "rep_1")).isTrue();

        JSONObject ack = acks.get(0);
        assertThat(ack.getString("type")).isEqualTo("bes_crash_reported_ack");
        assertThat(ack.getString("incidentKey")).isEqualTo("k1");
        assertThat(ack.getString("reportId")).isEqualTo("rep_1");
        assertThat(ack.getBoolean("ok")).isTrue();
        assertThat(ack.has("error")).isFalse();
        assertThat(access.find("k1").getString("state")).isEqualTo("REPORTED");
        assertThat(access.findByReportId("rep_1")).isNotNull();
    }

    @Test
    public void repeatedReportIsIdempotentAndAckedEachTime() throws Exception {
        report("k1", "rep_1");
        report("k1", "rep_1");
        report("k1", "rep_1");

        assertThat(acks).hasSize(3);
        assertThat(acks).allMatch(a -> a.optBoolean("ok"));
        assertThat(access.find("k1").getString("state")).isEqualTo("REPORTED");
    }

    @Test
    public void repeatAfterUploadIsStillOkAndDoesNotRegress() throws Exception {
        report("k1", "rep_1");
        access.markUploaded("k1");

        report("k1", "rep_1");

        assertThat(acks.get(1).getBoolean("ok")).isTrue();
        assertThat(access.find("k1").getString("state")).isEqualTo("UPLOADED");
    }

    @Test
    public void unknownIncidentIsRefused() throws Exception {
        assertThat(report("nope", "rep_1")).isTrue();

        JSONObject ack = acks.get(0);
        assertThat(ack.getBoolean("ok")).isFalse();
        assertThat(ack.getString("error")).isEqualTo("unknown_incident");
        assertThat(ack.getString("incidentKey")).isEqualTo("nope");
    }

    @Test
    public void aDifferentReportIdIsRefusedAndChangesNothing() throws Exception {
        report("k1", "rep_1");
        report("k1", "rep_2");

        assertThat(acks.get(1).getBoolean("ok")).isFalse();
        assertThat(acks.get(1).getString("error")).isEqualTo("report_id_conflict");
        assertThat(access.find("k1").getString("reportId")).isEqualTo("rep_1");
    }

    @Test
    public void evictedIncidentIsUnknown() throws Exception {
        access.evict("k1");

        report("k1", "rep_1");

        assertThat(acks.get(0).getString("error")).isEqualTo("unknown_incident");
    }

    @Test
    public void noStoreYetIsUnknownIncident() throws Exception {
        ICommunicationManager comms = mock(ICommunicationManager.class);
        when(comms.sendBluetoothResponse(any(JSONObject.class))).thenAnswer(i -> acks.add(i.getArgument(0)));
        BesCrashReportedCommandHandler noStore = new BesCrashReportedCommandHandler(comms, () -> null);

        noStore.handleCommand(
                "bes_crash_reported",
                new JSONObject().put("incidentKey", "k1").put("reportId", "rep_1"));

        assertThat(acks.get(0).getString("error")).isEqualTo("unknown_incident");
    }

    @Test
    public void malformedAndForeignCommandsAreRejected() throws Exception {
        assertThat(handler.handleCommand("bes_crash_reported", new JSONObject())).isFalse();
        assertThat(handler.handleCommand("other", new JSONObject().put("incidentKey", "k1"))).isFalse();
        assertThat(acks).isEmpty();
        assertThat(handler.getSupportedCommandTypes()).containsExactly("bes_crash_reported");
    }
}
