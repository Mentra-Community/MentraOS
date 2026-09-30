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
        assertEquals("failed", context.getSharedPreferences(AsgConstants.PENDING_DOWNGRADE_PREFS, Context.MODE_PRIVATE).getString("terminal_status", ""));
        verify(phone).sendOtaStatus(argThat(status -> "downgrade_not_owned".equals(status.optString("err"))));
        verify(phone, never()).sendOtaMessage(any());
    }

    @Test public void expiredSessionAndDisconnectedIdleRemainQueryableAfterAnotherProcessDeath() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        OtaSessionManager session = helper.getSessionManager();
        session.createSession(new String[]{"apk"}, "https://example.com/manifest.json");
        session.advanceStep(0, "install");
        assertTrue(helper.persistPendingDowngrade());
        set("mDowngradeWaitStarted", helper, -31_000L);
        helper.applyRecoveryStatus(null);
        org.robolectric.shadows.ShadowSystemClock.advanceBy(java.time.Duration.ofMinutes(31));
        assertNull(session.getSessionState());

        // Recovery settles while there is no connected phone and no ordinary OTA session.
        helper.applyRecoveryStatus(new RecoveryWorkerManager.DowngradeStatus(new Bundle()));
        assertEquals("downgrade_not_owned", helper.getOtaSessionState().getString("err"));
        helper.cleanup();
        set("handoffOwner", null, null);
        set("isUpdating", null, false);
        helper = new OtaHelper(context, mock(IBesOtaRegistry.class));
        assertNull(get("handoffOwner"));
        assertNull(get("handoffWatchdog"));
        assertEquals(false, get("isUpdating"));
        assertEquals("downgrade_not_owned", helper.getOtaSessionState().getString("err"));
        assertEquals("current", context.getSharedPreferences(AsgConstants.PENDING_DOWNGRADE_PREFS, Context.MODE_PRIVATE).getString("request_id", ""));
        assertEquals(302010058L, context.getSharedPreferences(AsgConstants.PENDING_DOWNGRADE_PREFS, Context.MODE_PRIVATE).getLong("target_version", -1L));
        assertEquals("sha", context.getSharedPreferences(AsgConstants.PENDING_DOWNGRADE_PREFS, Context.MODE_PRIVATE).getString("sha256", ""));

        OtaHelper.PhoneConnectionProvider phone = mock(OtaHelper.PhoneConnectionProvider.class);
        when(phone.isPhoneConnected()).thenReturn(true);
        helper.setPhoneConnectionProvider(phone);
        clearInvocations(phone);
        helper.onPhoneConnected();
        helper.onPhoneConnected();
        verify(phone, times(2)).sendOtaStatus(argThat(status -> "downgrade_not_owned".equals(status.optString("err"))));
        assertEquals("downgrade_not_owned", helper.getOtaSessionState().getString("err"));
        verify(phone, never()).sendOtaMessage(any());
    }

    @Test public void terminalCommitFailureKeepsPendingOwnership() throws Exception {
        assertTrue(helper.persistPendingDowngrade());
        OtaHelper original = helper;
        helper = spy(helper);
        original.cleanup();
        set("handoffOwner", null, helper);
        doReturn(false).when(helper).persistDowngradeTerminal(false);
        helper.applyRecoveryStatus(new RecoveryWorkerManager.DowngradeStatus(new Bundle()));
        assertSame(helper, get("handoffOwner"));
        assertEquals(true, get("isUpdating"));
        assertFalse(RuntimeEnvironment.getApplication().getSharedPreferences(AsgConstants.PENDING_DOWNGRADE_PREFS, Context.MODE_PRIVATE).contains("terminal_status"));
    }

    @Test public void admittedRetryRetiresOutcomeBeforeManifestFailure() throws Exception {
        helper.applyRecoveryStatus(new RecoveryWorkerManager.DowngradeStatus(new Bundle()));
        OtaHelper.PhoneConnectionProvider phone = mock(OtaHelper.PhoneConnectionProvider.class);
        when(phone.isPhoneConnected()).thenReturn(true);
        helper.setPhoneConnectionProvider(phone);
        clearInvocations(phone);
        // Malformed URL fails locally, before createSession or any artifact download.
        assertTrue(helper.startVersionCheckWithUrl(RuntimeEnvironment.getApplication(), "invalid-url"));
        verify(phone, timeout(5000)).sendOtaStatus(argThat(status -> "download_failed".equals(status.optString("err"))));
        java.util.concurrent.Semaphore permit = (java.util.concurrent.Semaphore) get("otaAdmissionPermit");
        assertTrue(permit.tryAcquire(5, java.util.concurrent.TimeUnit.SECONDS));
        permit.release();
        assertFalse(RuntimeEnvironment.getApplication().getSharedPreferences(AsgConstants.PENDING_DOWNGRADE_PREFS, Context.MODE_PRIVATE).contains("terminal_status"));
        assertFalse("downgrade_not_owned".equals(helper.getOtaSessionState().optString("err")));
    }

    @Test public void exactVersionConvergenceRetainsCompletionWithoutRearmingPolling() throws Exception {
        long installed = RuntimeEnvironment.getApplication().getPackageManager()
                .getPackageInfo("com.mentra.asg_client", 0).getLongVersionCode();
        set("mDowngradeTarget", helper, installed);
        helper.applyRecoveryStatus(new RecoveryWorkerManager.DowngradeStatus(new Bundle()));
        assertEquals("complete", helper.getOtaSessionState().getString("status"));
        helper.cleanup();
        helper = new OtaHelper(RuntimeEnvironment.getApplication(), mock(IBesOtaRegistry.class));
        assertEquals("complete", helper.getOtaSessionState().getString("status"));
        assertNull(get("handoffOwner"));
    }

    @Test public void disconnectedRetryManifestFailureSurvivesRestartAndReplaysOnReconnect() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        helper.applyRecoveryStatus(new RecoveryWorkerManager.DowngradeStatus(new Bundle()));
        OtaHelper.PhoneConnectionProvider phone = mock(OtaHelper.PhoneConnectionProvider.class);
        helper.setPhoneConnectionProvider(phone);
        clearInvocations(phone);
        assertTrue(helper.startVersionCheckWithUrl(context, "invalid-url"));
        java.util.concurrent.Semaphore permit = (java.util.concurrent.Semaphore) get("otaAdmissionPermit");
        assertTrue(permit.tryAcquire(5, java.util.concurrent.TimeUnit.SECONDS));
        permit.release();
        verify(phone, never()).sendOtaStatus(any());

        // Only persistent state survives; the previous downgrade result must not return.
        helper.cleanup();
        helper = new OtaHelper(context, mock(IBesOtaRegistry.class));
        assertEquals("failed", helper.getOtaSessionState().getString("status"));
        assertEquals("download_failed", helper.getOtaSessionState().getString("err"));
        assertEquals("download", helper.getOtaSessionState().getString("phase"));
        when(phone.isPhoneConnected()).thenReturn(true);
        helper.setPhoneConnectionProvider(phone);
        clearInvocations(phone);
        helper.onPhoneConnected();
        verify(phone).sendOtaStatus(argThat(status -> "download_failed".equals(status.optString("err"))));
        assertNull(get("handoffOwner"));
        assertEquals(false, get("isUpdating"));
    }

    @Test public void disconnectedFirmwareContinuationRetainsManifestFailure() throws Exception {
        Context context = RuntimeEnvironment.getApplication();
        helper.applyRecoveryStatus(new RecoveryWorkerManager.DowngradeStatus(new Bundle()));
        assertTrue(helper.retireSettledDowngrade());
        OtaSessionManager session = new OtaSessionManager(context);
        assertTrue(session.createSession(new String[]{"mtk", "bes"}, "invalid-url"));
        session.advanceStep(0, "install");
        set("sessionManager", helper, session);
        OtaHelper.PhoneConnectionProvider phone = mock(OtaHelper.PhoneConnectionProvider.class);
        helper.setPhoneConnectionProvider(phone);
        clearInvocations(phone);

        assertTrue(helper.continueSessionAfterStepComplete(context));
        java.util.concurrent.Semaphore permit = (java.util.concurrent.Semaphore) get("otaAdmissionPermit");
        assertTrue(permit.tryAcquire(5, java.util.concurrent.TimeUnit.SECONDS));
        permit.release();
        verify(phone, never()).sendOtaStatus(any());
        assertEquals("failed", helper.getOtaSessionState().getString("status"));
        assertEquals("bes", helper.getOtaSessionState().getString("st"));

        helper.cleanup();
        helper = new OtaHelper(context, mock(IBesOtaRegistry.class));
        assertEquals("download_failed", helper.getOtaSessionState().getString("err"));
        assertEquals("bes", helper.getOtaSessionState().getString("st"));
        when(phone.isPhoneConnected()).thenReturn(true);
        helper.setPhoneConnectionProvider(phone);
        clearInvocations(phone);
        helper.onPhoneConnected();
        verify(phone).sendOtaStatus(argThat(status -> "failed".equals(status.optString("status"))
                && "bes".equals(status.optString("st"))));
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
