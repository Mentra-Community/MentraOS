package com.mentra.asg_client.io.ota.helpers;

import static org.junit.Assert.*;
import static org.mockito.Mockito.*;
import android.content.Context;
import android.os.Bundle;
import com.mentra.asg_client.RecoveryWorkerManager;
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
        set("handoffOwner", null, null);
        helper = new OtaHelper(RuntimeEnvironment.getApplication(), mock(IBesOtaRegistry.class));
        set("handoffOwner", null, helper);
        set("isUpdating", null, true);
        set("mDowngradeRequestId", helper, "current");
        set("mDowngradeTarget", helper, 302010058L);
        set("mDowngradeSha", helper, "sha");
    }
    @After public void cleanup() throws Exception {
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
