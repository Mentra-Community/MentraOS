package com.mentra.asg_client.service.core.handlers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.app.Application;
import com.mentra.asg_client.io.bes.log.BesIncidentNotifier;
import com.mentra.asg_client.io.bes.log.BesIncidentUploader;
import com.mentra.asg_client.io.bes.log.FileBackedBesIncidentAccess;
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.communication.interfaces.IResponseBuilder;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
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

/** phone_ready re-announces pending incidents; transfer_complete completes only relay uploads. */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class BesIncidentPhoneLinkHandlersTest {
    @Rule public TemporaryFolder tmp = new TemporaryFolder();

    private FileBackedBesIncidentAccess access;
    private final List<String> types = new ArrayList<>();
    private final List<String> detectedKeys = new ArrayList<>();
    private ICommunicationManager comms;
    private AsgClientServiceManager services;
    private ICompanionTransport transport;
    private PhoneReadyCommandHandler phoneReady;
    private TransferCompleteCommandHandler transferComplete;
    private boolean glassesReadySent = true;

    @Before
    public void setUp() throws Exception {
        access = new FileBackedBesIncidentAccess(tmp.newFolder("bes_incident"));
        comms = mock(ICommunicationManager.class);
        when(comms.sendBluetoothResponse(any(JSONObject.class)))
                .thenAnswer(
                        invocation -> {
                            JSONObject message = invocation.getArgument(0);
                            types.add(message.optString("type"));
                            if ("bes_crash_detected".equals(message.optString("type"))) {
                                detectedKeys.add(message.optString("incidentKey"));
                            }
                            return !"glasses_ready".equals(message.optString("type")) || glassesReadySent;
                        });
        IResponseBuilder responseBuilder = mock(IResponseBuilder.class);
        when(responseBuilder.buildGlassesReadyResponse())
                .thenReturn(new JSONObject().put("type", "glasses_ready"));
        services = mock(AsgClientServiceManager.class);
        transport = mock(ICompanionTransport.class);
        when(services.getBluetoothManager()).thenReturn(transport);
        phoneReady =
                new PhoneReadyCommandHandler(
                        comms,
                        mock(IStateManager.class),
                        responseBuilder,
                        services,
                        new BesIncidentNotifier(() -> access));
        transferComplete =
                new TransferCompleteCommandHandler(
                        services, new BesIncidentUploader(() -> access));
    }

    @Test
    public void phoneReadyResendsAfterGlassesReadyOnEveryReadyUntilUploaded() throws Exception {
        access.createStored("k1", 100L, "d\n", "1\t1\t0\tt\n");

        phoneReady.handleCommand("phone_ready", new JSONObject());
        phoneReady.handleCommand("phone_ready", new JSONObject());
        assertThat(detectedKeys).containsExactly("k1", "k1");
        assertThat(types.subList(0, 2)).containsExactly("glasses_ready", "bes_crash_detected");

        access.markReported("k1", "rep_1");
        phoneReady.handleCommand("phone_ready", new JSONObject());
        assertThat(detectedKeys).hasSize(3);

        access.markUploaded("k1");
        phoneReady.handleCommand("phone_ready", new JSONObject());
        assertThat(detectedKeys).hasSize(3);
    }

    @Test
    public void phoneReadyWithoutPendingIncidentsSendsOnlyGlassesReady() {
        phoneReady.handleCommand("phone_ready", new JSONObject());

        assertThat(types).containsExactly("glasses_ready");
    }

    @Test
    public void failedGlassesReadySendsNoIncidents() throws Exception {
        access.createStored("k1", 100L, "d\n", null);
        glassesReadySent = false;

        phoneReady.handleCommand("phone_ready", new JSONObject());

        assertThat(detectedKeys).isEmpty();
    }

    @Test
    public void transferCompleteSuccessForTheRelayFileUploadsAndStillForwards() throws Exception {
        access.createStored("k1", 100L, "d\n", "1\t1\t0\tt\n");
        access.markReported("k1", "rep_ABCDEFGHIJKLMNOP");
        new BesIncidentUploader(() -> access).prepare("k1", BesIncidentUploader.ARTIFACT_RELAY);
        String file = BesIncidentUploader.relayFileBaseName("rep_ABCDEFGHIJKLMNOP");

        assertThat(
                        transferComplete.handleCommand(
                                "transfer_complete",
                                new JSONObject().put("fileName", file).put("success", false)))
                .isTrue();
        assertThat(access.find("k1").getString("state")).isEqualTo("REPORTED");

        transferComplete.handleCommand(
                "transfer_complete", new JSONObject().put("fileName", file).put("success", true));

        assertThat(access.find("k1").getString("state")).isEqualTo("UPLOADED");
        verify(transport).onFileTransferConfirmation(file, true);
    }

    @Test
    public void transferCompleteForOtherFilesLeavesIncidentsAlone() throws Exception {
        access.createStored("k1", 100L, "d\n", "1\t1\t0\tt\n");
        access.markReported("k1", "rep_ABCDEFGHIJKLMNOP");
        new BesIncidentUploader(() -> access).prepare("k1", BesIncidentUploader.ARTIFACT_RELAY);

        transferComplete.handleCommand(
                "transfer_complete",
                new JSONObject().put("fileName", "photo.jpg").put("success", true));
        transferComplete.handleCommand(
                "transfer_complete",
                new JSONObject()
                        .put("fileName", "L" + BesIncidentUploader.relayFileBaseName("rep_ABCDEFGHIJKLMNOP").substring(1))
                        .put("success", true));

        assertThat(access.find("k1").getString("state")).isEqualTo("REPORTED");
    }
}
