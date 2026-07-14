package com.mentra.asg_client.io.ota.session;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.os.SystemClock;
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
