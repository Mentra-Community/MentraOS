package com.mentra.asg_client.io.bes;

import static org.assertj.core.api.Assertions.assertThat;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.os.Looper;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bes.events.BesOtaProgressEvent;
import java.lang.reflect.Field;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.Subscribe;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowSystemClock;

/**
 * Deterministic interleaving tests for the BES OTA dead-man response watchdog.
 *
 * <p>The race under test: the watchdog callback is dispatched on the main looper with an expired
 * deadline while a response arrives on the UART receive thread. The transfer gate makes the outcome
 * depend only on ORDER, never on torn state: whichever side wins the monitor either aborts (and the
 * late response sees the transfer inactive and stops) or re-arms (and the late callback re-checks
 * the deadline and stands down). These tests pin that decision table by controlling exactly when
 * the dispatched callback runs relative to a re-arm.
 */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class BesOtaResponseWatchdogTest {

    private BesOtaManager manager;
    private final List<BesOtaProgressEvent> events = new ArrayList<>();

    // The test class itself subscribes: EventBus reflection needs a public named class.
    @Subscribe
    public void onEvent(BesOtaProgressEvent event) {
        events.add(event);
    }

    @Before
    public void setUp() {
        manager = new BesOtaManager(null, null, ApplicationProvider.getApplicationContext());
        BesOtaManager.isBesOtaInProgress = false;
        events.clear();
        EventBus.getDefault().register(this);
    }

    @After
    public void tearDown() {
        EventBus.getDefault().unregister(this);
        BesOtaManager.isBesOtaInProgress = false;
        shadowOf(Looper.getMainLooper()).idle();
    }

    @Test
    public void timeoutWithNoResponse_abortsAndReportsFailure() throws Exception {
        BesOtaManager.isBesOtaInProgress = true;
        setBooleanField("authorizationAttempted", true);
        manager.rearmResponseWatchdog();

        // Pass the deadline, then let the dispatched callback run with no response racing it.
        ShadowSystemClock.advanceBy(Duration.ofSeconds(31));
        shadowOf(Looper.getMainLooper()).idle();

        assertThat(BesOtaManager.isBesOtaInProgress).isFalse();
        assertThat(events).hasSize(1);
        assertThat(events.get(0).getErrorMessage())
                .isEqualTo(AsgConstants.BES_OTA_REBOOT_REQUIRED_ERROR);
    }

    @Test
    public void responseRacingTheDispatchedCallback_standsDown() {
        BesOtaManager.isBesOtaInProgress = true;
        manager.rearmResponseWatchdog();

        // Deadline passes and the callback becomes due - but a response re-arms BEFORE the
        // main looper gets to run it (the exact interleaving from review: the callback would
        // have read the stale expired deadline).
        ShadowSystemClock.advanceBy(Duration.ofSeconds(31));
        manager.rearmResponseWatchdog();
        shadowOf(Looper.getMainLooper()).idle();

        assertThat(BesOtaManager.isBesOtaInProgress).isTrue();
        assertThat(events).isEmpty();
    }

    @Test
    public void rearmAfterCleanup_leavesNoTimerBehind() {
        // Transfer already ended: a stale response must not arm anything.
        BesOtaManager.isBesOtaInProgress = false;
        manager.rearmResponseWatchdog();

        ShadowSystemClock.advanceBy(Duration.ofSeconds(31));
        shadowOf(Looper.getMainLooper()).idle();

        assertThat(events).isEmpty();
    }

    @Test
    public void ambiguousAuthorizationWriteWaitsForBesResponseBeforeFailing() throws Exception {
        BesOtaManager.isBesOtaInProgress = true;
        setBooleanField("isWaitingForAuthorization", true);
        setBooleanField("authorizationAttempted", true);

        manager.onAuthorizationWriteComplete(true, false);

        assertThat(BesOtaManager.isBesOtaInProgress).isTrue();
        assertThat(events).isEmpty();

        ShadowSystemClock.advanceBy(Duration.ofSeconds(31));
        shadowOf(Looper.getMainLooper()).idle();

        assertThat(BesOtaManager.isBesOtaInProgress).isFalse();
        assertThat(events).hasSize(1);
        assertThat(events.get(0).getErrorMessage())
                .isEqualTo(AsgConstants.BES_OTA_REBOOT_REQUIRED_ERROR);
    }

    @Test
    public void authorizationNotAttemptedFailsImmediately() throws Exception {
        BesOtaManager.isBesOtaInProgress = true;
        setBooleanField("isWaitingForAuthorization", true);

        manager.onAuthorizationWriteComplete(false, false);

        assertThat(BesOtaManager.isBesOtaInProgress).isFalse();
        assertThat(events).hasSize(1);
        assertThat(events.get(0).getErrorMessage())
                .isEqualTo("BES UART was not ready for authorization");
    }

    @Test
    public void explicitAuthorizationDenialRemainsRetryable() throws Exception {
        BesOtaManager.isBesOtaInProgress = true;
        setBooleanField("isWaitingForAuthorization", true);
        setBooleanField("authorizationAttempted", true);

        manager.onAuthorizationDenied();

        assertThat(BesOtaManager.isBesOtaInProgress).isFalse();
        assertThat(events).hasSize(1);
        assertThat(events.get(0).getErrorMessage()).isEqualTo("BES chip denied OTA authorization");
    }

    private void setBooleanField(String name, boolean value) throws Exception {
        Field field = BesOtaManager.class.getDeclaredField(name);
        field.setAccessible(true);
        field.setBoolean(manager, value);
    }
}
