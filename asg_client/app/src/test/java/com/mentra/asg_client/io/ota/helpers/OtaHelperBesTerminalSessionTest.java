package com.mentra.asg_client.io.ota.helpers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import com.mentra.asg_client.io.ota.interfaces.IBesOtaController;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;
import com.mentra.asg_client.io.ota.session.OtaSessionManager;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowSystemClock;

import java.time.Duration;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class OtaHelperBesTerminalSessionTest {
    private Context context;
    private IBesOtaController controller;
    private IBesOtaRegistry registry;
    private OtaHelper helper;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("ota_session", Context.MODE_PRIVATE).edit().clear().commit();
        controller = mock(IBesOtaController.class);
        registry = mock(IBesOtaRegistry.class);
        when(registry.getInstance()).thenReturn(controller);
        helper = new OtaHelper(context, registry);
    }

    @After
    public void tearDown() {
        helper.cleanup();
    }

    @Test
    public void disconnectedNativeCompletionSettlesAndPersistsOnlyTheOwningSession()
            throws Exception {
        OtaSessionManager session = begin("apk", "mtk", "bes");
        String owner = session.getSessionState().getString("sid");
        JSONObject complete = terminal("complete");
        when(controller.getAuthoritativeStatus()).thenReturn(complete);

        assertThat(helper.sendAuthoritativeBesStatusToPhone()).isTrue();

        JSONObject saved = new OtaSessionManager(context).getSessionState();
        assertThat(saved.getString("sid")).isEqualTo(owner);
        assertThat(saved.getString("status")).isEqualTo("complete");
        assertThat(saved.getInt("cs")).isEqualTo(3);
        assertThat(saved.getInt("sp")).isEqualTo(100);
        assertThat(saved.getInt("op")).isEqualTo(100);
        assertThat(saved.getString("phase")).isEqualTo("install");
        assertThat(session.getActivitySnapshot().getBoolean("restart_pending")).isFalse();

        // Duplicate native events must not refresh or rewrite an already terminal session.
        String persisted = persisted();
        ShadowSystemClock.advanceBy(Duration.ofSeconds(5));
        helper.sendAuthoritativeBesStatusToPhone();
        assertThat(persisted()).isEqualTo(persisted);
    }

    @Test
    public void startupReplayReconcilesWithoutTheOriginalFinishedEvent() throws Exception {
        begin("bes");
        when(controller.getAuthoritativeStatus()).thenReturn(terminal("complete"));
        helper.cleanup();
        helper = new OtaHelper(context, registry);

        helper.sendAuthoritativeBesStatusToPhone();

        assertThat(helper.getSessionManager().getStatus()).isEqualTo("complete");
    }

    @Test
    public void connectedPhoneStillReceivesTheUnchangedNativeProjection() throws Exception {
        begin("bes");
        JSONObject complete = terminal("complete");
        when(controller.getAuthoritativeStatus()).thenReturn(complete);
        OtaHelper.PhoneConnectionProvider provider = mock(OtaHelper.PhoneConnectionProvider.class);
        helper.setPhoneConnectionProvider(provider);
        when(provider.isPhoneConnected()).thenReturn(true);

        helper.sendAuthoritativeBesStatusToPhone();

        verify(provider).sendOtaStatus(complete);
        assertThat(helper.getSessionManager().getStatus()).isEqualTo("complete");
    }

    @Test
    public void ownedFailureSettlesTheSessionWithoutClaimingSuccess() throws Exception {
        begin("bes");
        when(controller.getAuthoritativeStatus())
                .thenReturn(terminal("failed").put("err", "install_failed"));

        helper.sendAuthoritativeBesStatusToPhone();

        JSONObject saved = new OtaSessionManager(context).getSessionState();
        assertThat(saved.getString("status")).isEqualTo("failed");
        assertThat(saved.getString("err")).isEqualTo("install_failed");
    }

    @Test
    public void absentOrActiveNativeStateDoesNotSettleTheSession() throws Exception {
        begin("bes");
        assertProjectionLeavesSession(null);
        assertProjectionLeavesSession(terminal("in_progress"));
    }

    @Test
    public void oldDebugAndMissingOwnersCannotFinishCurrentSession() throws Exception {
        begin("bes");
        assertProjectionLeavesSession(terminal("complete").put("sid", "previous"));
        assertProjectionLeavesSession(terminal("complete").put("sid", "adb-bes-debug"));
        assertProjectionLeavesSession(terminal("complete").put("sid", ""));
    }

    @Test
    public void wrongProjectionTypeOrPhaseCannotFinishCurrentSession() throws Exception {
        begin("bes");
        assertProjectionLeavesSession(terminal("complete").put("st", "mtk"));
        assertProjectionLeavesSession(terminal("complete").put("phase", "download"));
    }

    @Test
    public void earlierStepDownloadAndRestartGuardCannotBeSkipped() throws Exception {
        OtaSessionManager session = begin("apk", "mtk", "bes");
        JSONObject complete = terminal("complete");
        session.advanceStep(1, "install");
        assertProjectionLeavesSession(complete);
        session.advanceStep(2, "download");
        assertProjectionLeavesSession(complete);
        session.advanceStep(2, "install");
        assertThat(session.setRestarting()).isTrue();
        assertProjectionLeavesSession(complete);
    }

    @Test
    public void unexpectedNonFinalBesDoesNotCompleteOtherSteps() throws Exception {
        OtaSessionManager session = begin("bes", "apk");
        session.advanceStep(0, "install");
        assertProjectionLeavesSession(terminal("complete"));
    }

    @Test
    public void lateNativeSuccessPreservesExistingSessionFailure() throws Exception {
        OtaSessionManager session = begin("bes");
        JSONObject complete = terminal("complete");
        session.setFailed("original_failure");
        assertProjectionLeavesSession(complete);
        assertThat(session.getSessionState().getString("err")).isEqualTo("original_failure");
    }

    @Test
    public void noSessionIsNotCreatedByHistoricalNativeCompletion() throws Exception {
        assertProjectionLeavesSession(
                new JSONObject()
                        .put("sid", "old-owner")
                        .put("st", "bes")
                        .put("phase", "install")
                        .put("status", "complete"));
        assertThat(helper.getSessionManager().getSessionState()).isNull();
    }

    private OtaSessionManager begin(String... steps) {
        OtaSessionManager session = helper.getSessionManager();
        assertThat(session.createSession(steps, "https://example.invalid/firmware.json")).isTrue();
        session.advanceStep(steps.length - 1, "install");
        return session;
    }

    private JSONObject terminal(String status) throws Exception {
        return new JSONObject()
                .put("sid", helper.getSessionManager().getSessionState().getString("sid"))
                .put("st", "bes")
                .put("phase", "install")
                .put("status", status);
    }

    private String persisted() {
        return context.getSharedPreferences("ota_session", Context.MODE_PRIVATE)
                .getString("ota_session_data", null);
    }

    private void assertProjectionLeavesSession(JSONObject projection) {
        String before = persisted();
        when(controller.getAuthoritativeStatus()).thenReturn(projection);
        helper.sendAuthoritativeBesStatusToPhone();
        assertThat(persisted()).isEqualTo(before);
    }
}
