package com.mentra.asg_client.io.ota.helpers;

import static org.junit.Assert.*;
import static org.mockito.Mockito.*;
import android.content.Context;
import android.os.Bundle;
import com.mentra.asg_client.RecoveryWorkerManager;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.ota.session.OtaSessionManager;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;
import java.lang.reflect.Field;
import org.junit.Before;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class OtaRecoveryOwnershipTest {
    OtaHelper helper;
    @Before public void setup() throws Exception {
        RuntimeEnvironment.getApplication().getSharedPreferences(AsgConstants.PENDING_DOWNGRADE_PREFS, Context.MODE_PRIVATE).edit().clear().commit();
        set("handoffOwner", null, null);
        helper = new OtaHelper(RuntimeEnvironment.getApplication(), mock(IBesOtaRegistry.class));
        set("handoffOwner", null, helper);
        set("isUpdating", null, true);
        set("mDowngradeRequestId", helper, "current");
        set("mDowngradeTarget", helper, 302010058L);
        set("mDowngradeSha", helper, "sha");
    }
    @After public void cleanup() throws Exception {
        android.os.Handler handler = (android.os.Handler) get("HANDOFF_HANDLER");
        handler.removeCallbacksAndMessages(null);
        set("handoffWatchdog", null, null);
        RuntimeEnvironment.getApplication().getSharedPreferences(AsgConstants.PENDING_DOWNGRADE_PREFS, Context.MODE_PRIVATE).edit().clear().commit();
        set("handoffOwner", null, null);
        set("isUpdating", null, false);
        helper.cleanup();
    }
    @Test public void lostReplyAndConflictingOwnershipDoNotReleaseAdmission() throws Exception {
        helper.applyRecoveryStatus(null);
        assertEquals(true, get("isUpdating"));
        Bundle active = new Bundle(); active.putBoolean("active", true);
        active.putLong("target_version", 999L); active.putString("sha256", "other");
        helper.applyRecoveryStatus(new RecoveryWorkerManager.DowngradeStatus(active));
        assertEquals(true, get("isUpdating"));
        assertSame(helper, get("handoffOwner"));
    }
    @Test public void idleQueryAfterLostVerdictReleasesAdmission() throws Exception {
        Bundle idle = new Bundle(); idle.putBoolean("active", false);
        helper.applyRecoveryStatus(new RecoveryWorkerManager.DowngradeStatus(idle));
        assertEquals(false, get("isUpdating"));
        assertNull(get("handoffOwner"));
    }
    @Test public void adoptionDoesNotDownloadAgainIfTransactionFinishesAfterSnapshot() throws Exception {
        OtaHelper original = helper;
        helper = spy(helper);
        original.cleanup();
        Bundle active = new Bundle(); active.putBoolean("active", true);
        active.putString("transaction_id", "recovery-owned");
        active.putLong("target_version", 302010058L); active.putString("sha256", "sha");
        assertTrue(helper.adoptExistingDowngrade(new RecoveryWorkerManager.DowngradeStatus(active)));
        verify(helper, never()).downloadApk(anyString(), any(), any(), anyString());
        assertEquals("recovery-owned", RuntimeEnvironment.getApplication()
                .getSharedPreferences(AsgConstants.PENDING_DOWNGRADE_PREFS, Context.MODE_PRIVATE).getString("request_id", ""));
    }

    @Test public void failedPendingCommitRefusesAdoptionBeforeInstallPresentation() throws Exception {
        OtaHelper original = helper;
        helper = spy(helper);
        original.cleanup();
        set("handoffOwner", null, null);
        doReturn(false).when(helper).persistPendingDowngrade();
        Bundle active = new Bundle(); active.putBoolean("active", true);
        active.putString("transaction_id", "recovery-owned");
        active.putLong("target_version", 302010058L); active.putString("sha256", "sha");
        assertFalse(helper.adoptExistingDowngrade(new RecoveryWorkerManager.DowngradeStatus(active)));
        assertEquals(false, get("isUpdating"));
        assertNull(get("handoffOwner"));
    }

    @Test public void processDeathRestoresPollingAndIdleUnblocksWithoutAnotherOtaStart() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        OtaSessionManager session = new OtaSessionManager(context);
        session.createSession(new String[]{"apk"}, "https://example.com/manifest.json");
        session.advanceStep(0, "install");
        set("sessionManager", helper, session);
        assertTrue(helper.persistPendingDowngrade());
        set("mDowngradeWaitStarted", helper, -31_000L);
        helper.applyRecoveryStatus(null);
        assertEquals("downgrade_status_unknown", session.getSessionState().getString("err"));

        // Simulate a fresh process: no static owner/flag survives, only disk state does.
        helper.cleanup();
        set("handoffOwner", null, null);
        set("isUpdating", null, false);
        helper = new OtaHelper(context, mock(IBesOtaRegistry.class));
        assertSame(helper, get("handoffOwner"));
        assertNotNull(get("handoffWatchdog"));
        assertEquals(true, get("isUpdating"));
        OtaHelper.PhoneConnectionProvider phone = mock(OtaHelper.PhoneConnectionProvider.class);
        when(phone.isPhoneConnected()).thenReturn(true);
        helper.setPhoneConnectionProvider(phone);
        clearInvocations(phone);
        Bundle idle = new Bundle(); idle.putBoolean("active", false);
        helper.applyRecoveryStatus(new RecoveryWorkerManager.DowngradeStatus(idle));
        assertEquals(false, get("isUpdating"));
        assertFalse(context.getSharedPreferences(AsgConstants.PENDING_DOWNGRADE_PREFS, Context.MODE_PRIVATE).contains("request_id"));
        verify(phone).sendOtaStatus(argThat(status -> "downgrade_not_owned".equals(status.optString("err"))));
        verify(phone, never()).sendOtaMessage(any());
    }

    @Test public void lateOrMismatchedVerdictCannotChangeCurrentAttempt() throws Exception {
        OtaHelper.onDowngradeHandoffResult(false, "rejected", "old", 302010058L);
        OtaHelper.onDowngradeHandoffResult(false, "rejected", "current", 999L);
        OtaHelper.onDowngradeHandoffResult(false, "legacy", null, 302010058L);
        assertEquals(true, get("isUpdating"));
        assertSame(helper, get("handoffOwner"));
    }
    private static void set(String name, Object target, Object value) throws Exception {
        Field field = OtaHelper.class.getDeclaredField(name); field.setAccessible(true); field.set(target, value);
    }
    private static Object get(String name) throws Exception {
        Field field = OtaHelper.class.getDeclaredField(name); field.setAccessible(true); return field.get(null);
    }
}
