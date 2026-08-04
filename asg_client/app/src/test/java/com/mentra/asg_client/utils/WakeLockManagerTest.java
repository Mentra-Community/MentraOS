package com.mentra.asg_client.utils;

import static org.assertj.core.api.Assertions.assertThat;

import android.app.Application;
import android.os.PowerManager;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.utils.WakeLockManager.WakeOwner;
import java.time.Duration;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowPowerManager;
import org.robolectric.shadows.ShadowSystemClock;

/**
 * Pins the owner-keyed lease contract of {@link WakeLockManager}:
 *
 * <p>1. Extend-only per owner ("longest deadline wins"): a shorter acquire never shortens a
 * longer lease the same owner already holds; only a later deadline swaps the lock. The shared
 * static lock used to be replaced on every acquire, letting a short acquire cut a 10-min OTA
 * short and put the MTK SoC to sleep mid-update.
 *
 * <p>2. Ownership isolation: release(owner) ends ONLY that owner's leases. The historical
 * releaseAllWakeLocks() let camera close / stream cleanup revoke every other subsystem's
 * protection (BES OTA mid-transfer, W:1 command windows, in-flight uploads).
 */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class WakeLockManagerTest {

    private Application app;

    @Before
    public void setUp() {
        app = ApplicationProvider.getApplicationContext();
        releaseEveryOwner();
    }

    @After
    public void tearDown() {
        releaseEveryOwner();
    }

    // WakeLockManager keeps process-static state that Robolectric does not reset between
    // tests; clear every owner so each test starts with no held lease.
    private static void releaseEveryOwner() {
        for (WakeOwner owner : WakeOwner.values()) {
            WakeLockManager.release(owner);
        }
    }

    @Test
    public void shorterAcquire_doesNotReplaceLongerHeldCpuLease() {
        assertThat(WakeLockManager.acquireCpu(app, WakeOwner.MTK_OTA, 600_000)).isTrue(); // 10 min
        PowerManager.WakeLock first = ShadowPowerManager.getLatestWakeLock();
        assertThat(first.isHeld()).isTrue();

        // 1 minute later, a 2-minute acquire must be ignored — the original lease still outlives it.
        ShadowSystemClock.advanceBy(Duration.ofMinutes(1));
        assertThat(WakeLockManager.acquireCpu(app, WakeOwner.MTK_OTA, 120_000)).isTrue(); // 2 min

        // No new lock was created; the original 10-min lease is still the active one.
        assertThat(ShadowPowerManager.getLatestWakeLock()).isSameAs(first);
        assertThat(first.isHeld()).isTrue();
    }

    @Test
    public void longerAcquire_extendsCpuLease() {
        assertThat(WakeLockManager.acquireCpu(app, WakeOwner.MTK_OTA, 120_000)).isTrue(); // 2 min
        PowerManager.WakeLock first = ShadowPowerManager.getLatestWakeLock();

        assertThat(WakeLockManager.acquireCpu(app, WakeOwner.MTK_OTA, 600_000)).isTrue(); // 10 min
        PowerManager.WakeLock second = ShadowPowerManager.getLatestWakeLock();

        // Extending to a later deadline swaps in a fresh, longer lock and releases the old one.
        assertThat(second).isNotSameAs(first);
        assertThat(second.isHeld()).isTrue();
        assertThat(first.isHeld()).isFalse();
    }

    @Test
    public void release_thenShorterAcquire_startsFreshLease() {
        assertThat(WakeLockManager.acquireCpu(app, WakeOwner.MTK_OTA, 600_000)).isTrue();
        PowerManager.WakeLock first = ShadowPowerManager.getLatestWakeLock();

        WakeLockManager.release(WakeOwner.MTK_OTA);
        assertThat(first.isHeld()).isFalse();

        // An explicit release clears the tracked deadline, so a short acquire is honored again.
        assertThat(WakeLockManager.acquireCpu(app, WakeOwner.MTK_OTA, 60_000)).isTrue();
        PowerManager.WakeLock second = ShadowPowerManager.getLatestWakeLock();
        assertThat(second).isNotSameAs(first);
        assertThat(second.isHeld()).isTrue();
    }

    @Test
    public void screenLease_isExtendOnlyToo() {
        assertThat(WakeLockManager.acquireScreen(app, WakeOwner.CAMERA, 60_000)).isTrue();
        PowerManager.WakeLock first = ShadowPowerManager.getLatestWakeLock();

        ShadowSystemClock.advanceBy(Duration.ofSeconds(1));
        assertThat(WakeLockManager.acquireScreen(app, WakeOwner.CAMERA, 5_000)).isTrue(); // shorter

        assertThat(ShadowPowerManager.getLatestWakeLock()).isSameAs(first);
        assertThat(first.isHeld()).isTrue();
    }

    @Test
    public void releaseOfOneOwner_doesNotTouchAnotherOwnersLease() {
        // The collision this rework exists to prevent: camera close releasing its leases
        // must not revoke a concurrent BES OTA transfer's protection.
        assertThat(WakeLockManager.acquireCpu(app, WakeOwner.BES_OTA, 300_000)).isTrue();
        PowerManager.WakeLock otaLock = ShadowPowerManager.getLatestWakeLock();
        assertThat(WakeLockManager.acquireFull(app, WakeOwner.CAMERA, 180_000, 5_000)).isTrue();

        WakeLockManager.release(WakeOwner.CAMERA);

        assertThat(otaLock.isHeld()).isTrue();

        WakeLockManager.release(WakeOwner.BES_OTA);
        assertThat(otaLock.isHeld()).isFalse();
    }

    @Test
    public void sameKindLeases_areIndependentPerOwner() {
        assertThat(WakeLockManager.acquireCpu(app, WakeOwner.PHONE_COMMAND, 15_000)).isTrue();
        PowerManager.WakeLock commandLock = ShadowPowerManager.getLatestWakeLock();
        assertThat(WakeLockManager.acquireCpu(app, WakeOwner.STREAMING, 2_180_000)).isTrue();
        PowerManager.WakeLock streamingLock = ShadowPowerManager.getLatestWakeLock();

        // Two owners hold two distinct kernel locks concurrently; the extend-only rule is
        // scoped per owner, so the streaming acquire did not touch the command lease.
        assertThat(streamingLock).isNotSameAs(commandLock);
        assertThat(commandLock.isHeld()).isTrue();
        assertThat(streamingLock.isHeld()).isTrue();
    }
}
