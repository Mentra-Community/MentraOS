package com.mentra.asg_client.io.ota.helpers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.verify;

import android.app.Application;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaController;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;
import com.mentra.asg_client.io.ota.session.OtaSessionManager;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class OtaHelperBesTerminalTest {
    private Application context;
    private OtaHelper helper;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("ota_session", 0).edit().clear().commit();
        context.getSharedPreferences(AsgConstants.BES_OTA_AUTH_GATE_PREFS, 0)
                .edit()
                .clear()
                .commit();
        helper = new OtaHelper(context, new EmptyBesRegistry());
    }

    @After
    public void tearDown() {
        helper.cleanup();
        context.getSharedPreferences("ota_session", 0).edit().clear().commit();
        context.getSharedPreferences(AsgConstants.BES_OTA_AUTH_GATE_PREFS, 0)
                .edit()
                .clear()
                .commit();
    }

    @Test
    public void verifiedBesSuccessPersistsAndResendsTerminalSessionStatus() {
        assertThat(
                        helper.getSessionManager()
                                .createSession(new String[] {"bes"}, "https://example.test/v.json"))
                .isTrue();
        helper.getSessionManager().advanceStep(0, "install");
        context.getSharedPreferences(AsgConstants.BES_OTA_AUTH_GATE_PREFS, 0)
                .edit()
                .putString(
                        AsgConstants.BES_OTA_HANDOFF_SESSION_ID_KEY,
                        helper.getSessionManager().getSessionId())
                .putString(AsgConstants.BES_OTA_HANDOFF_TERMINAL_STATUS_KEY, "FINISHED")
                .commit();
        RecordingPhone phone = new RecordingPhone();
        helper.setPhoneConnectionProvider(phone);

        assertThat(helper.replayPendingBesTerminalOutcome("test startup")).isTrue();
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();

        assertThat(helper.getSessionManager().getStatus()).isEqualTo("complete");
        assertThat(helper.getSessionManager().isBesTerminalDeliveryPending()).isTrue();
        assertThat(phone.statuses).isNotEmpty();
        assertThat(phone.statuses.get(phone.statuses.size() - 1).optString("status"))
                .isEqualTo("complete");
    }

    @Test
    public void supersededTerminalCannotCompleteNewSessionOrResendIntoIt() {
        assertThat(
                        helper.getSessionManager()
                                .createSession(new String[] {"bes"}, "https://example.test/a.json"))
                .isTrue();
        String firstSessionId = helper.getSessionManager().getSessionId();
        context.getSharedPreferences(AsgConstants.BES_OTA_AUTH_GATE_PREFS, 0)
                .edit()
                .putString(AsgConstants.BES_OTA_HANDOFF_SESSION_ID_KEY, firstSessionId)
                .putString(AsgConstants.BES_OTA_HANDOFF_TERMINAL_STATUS_KEY, "FINISHED")
                .commit();

        RecordingPhone phone = new RecordingPhone();
        helper.setPhoneConnectionProvider(phone);
        assertThat(helper.getSessionManager().getStatus()).isEqualTo("complete");
        assertThat(phone.statuses).hasSize(1);

        assertThat(
                        helper.getSessionManager()
                                .admitOrContinueSession(
                                        new String[] {"bes"}, "https://example.test/b.json"))
                .isEqualTo(OtaSessionManager.SessionAdmission.CREATED);
        String secondSessionId = helper.getSessionManager().getSessionId();
        assertThat(secondSessionId).isNotEqualTo(firstSessionId);
        assertThat(helper.getSessionManager().applyBesTerminalOutcome(firstSessionId, true, null))
                .isFalse();

        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();

        assertThat(helper.getSessionManager().getSessionId()).isEqualTo(secondSessionId);
        assertThat(helper.getSessionManager().getStatus()).isEqualTo("in_progress");
        assertThat(phone.statuses).hasSize(1);
    }

    @Test
    public void sessionOwnedFailureIgnoresStaleEventAndSupersedesOrphanedHandoff() {
        helper = spy(helper);
        assertThat(
                        helper.getSessionManager()
                                .createSession(new String[] {"bes"}, "https://example.test/a.json"))
                .isTrue();
        String firstSessionId = helper.getSessionManager().getSessionId();
        helper.getSessionManager().setComplete();

        assertThat(
                        helper.getSessionManager()
                                .createSession(new String[] {"bes"}, "https://example.test/b.json"))
                .isTrue();
        String secondSessionId = helper.getSessionManager().getSessionId();
        RecordingPhone phone = new RecordingPhone();
        helper.setPhoneConnectionProvider(phone);

        // Simulate a cleanup failure leaving A's handoff visible after B became current.
        context.getSharedPreferences(AsgConstants.BES_OTA_AUTH_GATE_PREFS, 0)
                .edit()
                .putString(AsgConstants.BES_OTA_HANDOFF_SESSION_ID_KEY, firstSessionId)
                .putString(AsgConstants.BES_OTA_HANDOFF_TERMINAL_STATUS_KEY, "FAILED")
                .commit();

        helper.handleBesTerminalEvent(
                firstSessionId, "FAILED", 0, "delayed session A failure");

        assertThat(helper.getSessionManager().getSessionId()).isEqualTo(secondSessionId);
        assertThat(helper.getSessionManager().getStatus()).isEqualTo("in_progress");
        assertThat(phone.statuses).isEmpty();
        verify(helper, never()).deleteDownloadedArtifactForType("bes");

        helper.handleBesTerminalEvent(
                secondSessionId, "FAILED", 0, "current session B failure");

        assertThat(helper.getSessionManager().getStatus()).isEqualTo("failed");
        assertThat(phone.statuses).isNotEmpty();
        assertThat(phone.statuses.get(phone.statuses.size() - 1).optString("status"))
                .isEqualTo("failed");
        verify(helper).deleteDownloadedArtifactForType("bes");
    }

    private static final class EmptyBesRegistry implements IBesOtaRegistry {
        @Override
        public IBesOtaController getInstance() {
            return null;
        }

        @Override
        public void setInstance(IBesOtaController controller) {}

        @Override
        public void clear() {}
    }

    private static final class RecordingPhone implements OtaHelper.PhoneConnectionProvider {
        private final List<JSONObject> statuses = new ArrayList<>();

        @Override
        public boolean isPhoneConnected() {
            return true;
        }

        @Override
        public void sendOtaMessage(JSONObject message) {}

        @Override
        public void sendOtaStatus(JSONObject status) {
            statuses.add(status);
        }
    }
}
