package com.mentra.asg_client;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

import android.content.Intent;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class RecoveryWorkerManagerTest {

    @Test
    public void missingAndDisabledWorkersHaveSpecificPreDownloadFailures() throws Exception {
        android.content.Context context = org.mockito.Mockito.mock(android.content.Context.class);
        android.content.pm.PackageManager pm = org.mockito.Mockito.mock(android.content.pm.PackageManager.class);
        org.mockito.Mockito.when(context.getPackageManager()).thenReturn(pm);
        org.mockito.Mockito.when(pm.getPackageInfo("com.mentra.recovery", 0))
                .thenThrow(new android.content.pm.PackageManager.NameNotFoundException());
        assertEquals("downgrade_recovery_unavailable", RecoveryWorkerManager.recoveryAvailabilityError(context));
        android.content.pm.PackageInfo info = new android.content.pm.PackageInfo();
        info.applicationInfo = new android.content.pm.ApplicationInfo();
        info.applicationInfo.enabled = false;
        org.mockito.Mockito.doReturn(info).when(pm).getPackageInfo("com.mentra.recovery", 0);
        assertEquals("downgrade_recovery_disabled", RecoveryWorkerManager.recoveryAvailabilityError(context));
    }

    @Test
    public void healthyWorkerGetsAnotherQueryAfterTransientTimeout() throws Exception {
        android.content.Context context = org.mockito.Mockito.mock(android.content.Context.class);
        android.os.Bundle idle = new android.os.Bundle();
        RecoveryWorkerManager.DowngradeStatus ready = new RecoveryWorkerManager.DowngradeStatus(idle);
        try (org.mockito.MockedStatic<RecoveryWorkerManager> manager = org.mockito.Mockito.mockStatic(
                RecoveryWorkerManager.class, org.mockito.Mockito.CALLS_REAL_METHODS)) {
            manager.when(() -> RecoveryWorkerManager.recoveryAvailabilityError(context)).thenReturn(null);
            manager.when(() -> RecoveryWorkerManager.queryDowngradeStatus(context)).thenReturn(null, ready);
            assertEquals(ready, RecoveryWorkerManager.awaitDowngradeReady(context));
            manager.verify(() -> RecoveryWorkerManager.queryDowngradeStatus(context), org.mockito.Mockito.times(2));
        }
    }

    @Test
    public void newRecoveryIntent_targetsWorkerPackageWithAction() {
        Intent intent = RecoveryWorkerManager.newRecoveryIntent("com.mentra.recovery.ACTION_X");
        assertEquals("com.mentra.recovery.ACTION_X", intent.getAction());
        assertEquals("com.mentra.recovery", intent.getPackage());
    }

    @Test
    public void newRecoveryIntent_reachesStoppedPackages() {
        // A freshly OEM-installed worker is in Android's stopped state until one of its
        // components runs; broadcasts without this flag are dropped before delivery.
        Intent intent = RecoveryWorkerManager.newRecoveryIntent("com.mentra.recovery.ACTION_X");
        assertNotEquals(0, intent.getFlags() & Intent.FLAG_INCLUDE_STOPPED_PACKAGES);
    }
}
