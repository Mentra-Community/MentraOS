package com.mentra.asg_client.io.ota.session;

import static org.assertj.core.api.Assertions.assertThat;

import android.app.Application;
import android.content.SharedPreferences;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.AsgConstants;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class OtaSessionManagerBesRebootTest {
    private Application context;
    private SharedPreferences preferences;
    private SharedPreferences handoffPreferences;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        preferences = context.getSharedPreferences("ota_session", 0);
        preferences.edit().clear().commit();
        handoffPreferences =
                context.getSharedPreferences(AsgConstants.BES_OTA_AUTH_GATE_PREFS, 0);
        handoffPreferences.edit().clear().commit();
    }

    @After
    public void tearDown() {
        preferences.edit().clear().commit();
        handoffPreferences.edit().clear().commit();
    }

    @Test
    public void activeBesSessionSurvivesElapsedRealtimeReset() throws Exception {
        OtaSessionManager beforeReboot = new OtaSessionManager(context);
        assertThat(beforeReboot.createSession(new String[] {"bes"}, "https://example.test/v.json"))
                .isTrue();
        beforeReboot.advanceStep(0, "install");
        handoffPreferences
                .edit()
                .putBoolean(AsgConstants.BES_OTA_AUTH_GATE_APPLY_PENDING_KEY, true)
                .commit();
        // A later write from the live session owner must not erase gate-owned reboot state.
        beforeReboot.updateProgress(50);
        assertThat(
                        handoffPreferences.getBoolean(
                                AsgConstants.BES_OTA_AUTH_GATE_APPLY_PENDING_KEY, false))
                .isTrue();
        emulateElapsedRealtimeReset();

        OtaSessionManager afterReboot = new OtaSessionManager(context);

        assertThat(afterReboot.hasActiveSession()).isTrue();
        assertThat(afterReboot.getSessionState().optString("sid")).isNotEmpty();
        assertThat(afterReboot.getSessionState().optString("st")).isEqualTo("bes");
    }

    @Test
    public void elapsedRealtimeResetExpiresSessionWithoutDurableBesHandoff() throws Exception {
        OtaSessionManager beforeReboot = new OtaSessionManager(context);
        assertThat(beforeReboot.createSession(new String[] {"bes"}, "https://example.test/v.json"))
                .isTrue();
        beforeReboot.advanceStep(0, "install");
        emulateElapsedRealtimeReset();

        OtaSessionManager afterReboot = new OtaSessionManager(context);

        assertThat(afterReboot.hasActiveSession()).isFalse();
    }

    @Test
    public void pendingBesTerminalSurvivesManualRecoveryReboot() throws Exception {
        OtaSessionManager beforeReboot = new OtaSessionManager(context);
        assertThat(beforeReboot.createSession(new String[] {"bes"}, "https://example.test/v.json"))
                .isTrue();
        beforeReboot.advanceStep(0, "install");
        handoffPreferences
                .edit()
                .putString(AsgConstants.BES_OTA_HANDOFF_TERMINAL_STATUS_KEY, "FAILED")
                .putString(AsgConstants.BES_OTA_HANDOFF_TERMINAL_ERROR_KEY, "install_failed")
                .commit();
        assertThat(beforeReboot.applyBesTerminalOutcome(false, "install_failed")).isTrue();
        emulateElapsedRealtimeReset();

        OtaSessionManager afterReboot = new OtaSessionManager(context);
        JSONObject state = afterReboot.getSessionState();

        assertThat(afterReboot.isBesTerminalDeliveryPending()).isTrue();
        assertThat(state).isNotNull();
        assertThat(state.optString("status")).isEqualTo("failed");
        assertThat(state.optString("err")).isEqualTo("install_failed");
    }

    private void emulateElapsedRealtimeReset() throws Exception {
        JSONObject persisted = new JSONObject(preferences.getString("ota_session_data", "{}"));
        persisted.put("last_activity_at_elapsed", Long.MAX_VALUE);
        preferences.edit().putString("ota_session_data", persisted.toString()).commit();
    }
}
