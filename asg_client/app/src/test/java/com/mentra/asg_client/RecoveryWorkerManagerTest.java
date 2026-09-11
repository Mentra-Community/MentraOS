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
