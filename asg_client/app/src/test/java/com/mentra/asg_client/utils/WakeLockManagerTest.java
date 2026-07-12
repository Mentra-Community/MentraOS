package com.mentra.asg_client.utils;

import static org.assertj.core.api.Assertions.assertThat;

import android.app.Application;
import android.os.PowerManager;
import androidx.test.core.app.ApplicationProvider;
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
 * Verifies the extend-only ("longest deadline wins") behavior of {@link WakeLockManager}.
 *
 * <p>The shared static CPU wake lock used to be replaced on every acquire, so a short acquire
 * (e.g. a 60s camera/util lock) could cut an in-flight long operation (e.g. a 10-min OTA) short
 * and let the CPU — and the MTK SoC — sleep mid-update. These tests pin the new contract: a
 * shorter acquire never shortens a longer lock that is already held; only a later deadline
 * swaps the lock.
 */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class WakeLockManagerTest {

    private Application app;

    @Before
    public void setUp() {
        app = ApplicationProvider.getApplicationContext();
        // WakeLockManager keeps process-static state that Robolectric does not reset between
        // tests; clear it so each test starts with no held lock and no tracked deadline.
        WakeLockManager.releaseAllWakeLocks();
    }

    @After
    public void tearDown() {
        WakeLockManager.releaseAllWakeLocks();
    }

    @Test
    public void shorterAcquire_doesNotReplaceLongerHeldCpuLock() {
        assertThat(WakeLockManager.acquireCpuWakeLock(app, 600_000)).isTrue(); // 10 min
        PowerManager.WakeLock first = ShadowPowerManager.getLatestWakeLock();
        assertThat(first.isHeld()).isTrue();

        // 1 minute later, a 2-minute acquire must be ignored — the original lock still outlives it.
        ShadowSystemClock.advanceBy(Duration.ofMinutes(1));
        assertThat(WakeLockManager.acquireCpuWakeLock(app, 120_000)).isTrue(); // 2 min

        // No new lock was created; the original 10-min lock is still the active one.
        assertThat(ShadowPowerManager.getLatestWakeLock()).isSameAs(first);
        assertThat(first.isHeld()).isTrue();
    }

    @Test
    public void longerAcquire_extendsCpuLock() {
        assertThat(WakeLockManager.acquireCpuWakeLock(app, 120_000)).isTrue(); // 2 min
        PowerManager.WakeLock first = ShadowPowerManager.getLatestWakeLock();

        assertThat(WakeLockManager.acquireCpuWakeLock(app, 600_000)).isTrue(); // 10 min
        PowerManager.WakeLock second = ShadowPowerManager.getLatestWakeLock();

        // Extending to a later deadline swaps in a fresh, longer lock and releases the old one.
        assertThat(second).isNotSameAs(first);
        assertThat(second.isHeld()).isTrue();
        assertThat(first.isHeld()).isFalse();
    }

    @Test
    public void release_thenShorterAcquire_startsFreshLock() {
        assertThat(WakeLockManager.acquireCpuWakeLock(app, 600_000)).isTrue();
        PowerManager.WakeLock first = ShadowPowerManager.getLatestWakeLock();

        WakeLockManager.releaseCpuWakeLock();
        assertThat(first.isHeld()).isFalse();

        // An explicit release clears the tracked deadline, so a short acquire is honored again.
        assertThat(WakeLockManager.acquireCpuWakeLock(app, 60_000)).isTrue();
        PowerManager.WakeLock second = ShadowPowerManager.getLatestWakeLock();
        assertThat(second).isNotSameAs(first);
        assertThat(second.isHeld()).isTrue();
    }

    @Test
    public void screenLock_isExtendOnlyToo() {
        assertThat(WakeLockManager.acquireScreenWakeLock(app, 60_000)).isTrue();
        PowerManager.WakeLock first = ShadowPowerManager.getLatestWakeLock();

        ShadowSystemClock.advanceBy(Duration.ofSeconds(1));
        assertThat(WakeLockManager.acquireScreenWakeLock(app, 5_000)).isTrue(); // shorter

        assertThat(ShadowPowerManager.getLatestWakeLock()).isSameAs(first);
        assertThat(first.isHeld()).isTrue();
    }
}
