package com.mentra.asg_client.io.ota.session;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.os.SystemClock;
import android.provider.Settings;
import androidx.test.core.app.ApplicationProvider;
import java.time.Duration;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.shadows.ShadowSystemClock;

@RunWith(RobolectricTestRunner.class)
public class OtaSessionManagerTest {
    private Context context;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("ota_session", Context.MODE_PRIVATE).edit().clear().commit();
        Settings.Global.putInt(context.getContentResolver(), Settings.Global.BOOT_COUNT, 100);
    }

    @Test
    public void ageSinceUsesElapsedRealtimeWithinSameBoot() {
        assertEquals(4_000L, OtaSessionManager.ageSince(9_000L, 5_000L, 100_000L, 1_000L));
    }

    @Test
    public void ageSinceUsesWallClockAfterReboot() {
        assertEquals(20_000L, OtaSessionManager.ageSince(2_000L, 50_000L, 120_000L, 100_000L));
    }

    @Test
    public void ageSincePreservesLegacySessionAfterReboot() {
        assertEquals(0L, OtaSessionManager.ageSince(2_000L, 50_000L, 120_000L, 0L));
    }

    @Test
    public void ageSincePreservesSessionWhenWallClockMovesBackward() {
        assertEquals(0L, OtaSessionManager.ageSince(2_000L, 50_000L, 90_000L, 100_000L));
    }

    @Test
    public void activeFirmwareSessionSurvivesElapsedRealtimeReset() throws Exception {
        persistSession(System.currentTimeMillis() - 10_000L);

        assertTrue(new OtaSessionManager(context).hasActiveSession());
    }

    @Test
    public void staleFirmwareSessionStillExpiresAfterElapsedRealtimeReset() throws Exception {
        persistSession(System.currentTimeMillis() - (31L * 60L * 1000L));

        assertFalse(new OtaSessionManager(context).hasActiveSession());
    }

    @Test
    public void legacySessionGetsOneBoundedRecoveryWindowAfterReboot() throws Exception {
        persistSession(0L);
        OtaSessionManager manager = new OtaSessionManager(context);

        assertTrue(manager.hasActiveSession());
        ShadowSystemClock.advanceBy(Duration.ofMinutes(31));
        assertFalse(manager.hasActiveSession());
    }

    @Test
    public void firmwareResumeRequiresAnExplicitMarkerAndDifferentBootCount() {
        OtaSessionManager manager = new OtaSessionManager(context);
        assertTrue(manager.createSession(new String[] {"bes", "apk"}, "https://example.test/v2"));

        Settings.Global.putInt(context.getContentResolver(), Settings.Global.BOOT_COUNT, 101);
        assertFalse(manager.hasExpectedFirmwareRebootOccurred());
        Settings.Global.putInt(context.getContentResolver(), Settings.Global.BOOT_COUNT, 100);
        manager.expectFirmwareReboot();

        assertFalse(manager.hasExpectedFirmwareRebootOccurred());
        Settings.Global.putInt(context.getContentResolver(), Settings.Global.BOOT_COUNT, 101);

        OtaSessionManager reloaded = new OtaSessionManager(context);
        assertTrue(reloaded.hasExpectedFirmwareRebootOccurred());
        assertTrue(reloaded.consumeExpectedFirmwareReboot());
        assertFalse(reloaded.consumeExpectedFirmwareReboot());
    }

    @Test
    public void expectedFirmwareRebootExpiresWithTheSessionWindow() {
        OtaSessionManager manager = new OtaSessionManager(context);
        assertTrue(manager.createSession(new String[] {"mtk", "apk"}, "https://example.test/v2"));
        manager.expectFirmwareReboot();
        Settings.Global.putInt(context.getContentResolver(), Settings.Global.BOOT_COUNT, 101);
        ShadowSystemClock.advanceBy(Duration.ofMinutes(31));

        assertFalse(manager.hasExpectedFirmwareRebootOccurred());
        assertFalse(manager.consumeExpectedFirmwareReboot());
    }

    @Test
    public void packageRestartPersistsExactAsgTargetAndFailureDisarmsIt() {
        OtaSessionManager manager = new OtaSessionManager(context);
        assertTrue(manager.createSession(new String[] {"apk"}, "https://example.test/v2"));
        manager.setRestarting(48_500_123L);

        OtaSessionManager reloaded = new OtaSessionManager(context);
        assertEquals(48_500_123L, reloaded.getExpectedAsgVersion());
        assertTrue(reloaded.isInRestartGuard());

        reloaded.setFailed("recovery_handoff_failed");
        assertEquals(-1L, reloaded.getExpectedAsgVersion());
        assertFalse(reloaded.isInRestartGuard());
        assertFalse(reloaded.hasActiveSession());
    }

    private void persistSession(long lastActivityWallClock) throws Exception {
        JSONObject session = new JSONObject();
        session.put("session_id", "firmware");
        session.put("total_steps", 1);
        session.put("step_sequence", new JSONArray().put("mtk"));
        session.put("current_step_index", 0);
        session.put("current_phase", "install");
        session.put("step_percent", 50);
        session.put("status", "in_progress");
        session.put("last_activity_at_elapsed", SystemClock.elapsedRealtime() + 60_000L);
        session.put("last_activity_at_wall_clock", lastActivityWallClock);
        session.put("restarting_since_elapsed", -1L);
        session.put("restarting_since_wall_clock", -1L);
        context.getSharedPreferences("ota_session", Context.MODE_PRIVATE)
                .edit()
                .putString("ota_session_data", session.toString())
                .commit();
    }
}
