package com.mentra.asg_client.io.bes;

import static org.assertj.core.api.Assertions.assertThat;

import android.app.Application;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.AsgConstants;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class BesOtaAuthorizationGateTest {
    private Application context;
    private AtomicReference<String> bootId;
    private BesOtaAuthorizationGate gate;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences(AsgConstants.BES_OTA_AUTH_GATE_PREFS, 0)
                .edit()
                .clear()
                .commit();
        bootId = new AtomicReference<>("linux:boot-a");
        gate = new BesOtaAuthorizationGate(context, bootId::get);
    }

    @After
    public void tearDown() {
        context.getSharedPreferences(AsgConstants.BES_OTA_AUTH_GATE_PREFS, 0)
                .edit()
                .clear()
                .commit();
    }

    @Test
    public void authorizationCanBeAttemptedOnlyOncePerGlassesBoot() {
        assertThat(gate.isRetryBlockedThisBoot()).isFalse();
        assertThat(gate.tryReserveCurrentBoot("17.26.7.24")).isTrue();
        assertThat(gate.isRetryBlockedThisBoot()).isTrue();
        assertThat(gate.tryReserveCurrentBoot("17.26.7.24")).isFalse();

        BesOtaAuthorizationGate afterProcessRestart =
                new BesOtaAuthorizationGate(context, bootId::get);
        assertThat(afterProcessRestart.isRetryBlockedThisBoot()).isTrue();
    }

    @Test
    public void newGlassesBootAllowsOneFreshAttempt() {
        assertThat(gate.tryReserveCurrentBoot("17.26.7.24")).isTrue();

        bootId.set("linux:boot-b");

        assertThat(gate.isRetryBlockedThisBoot()).isFalse();
    }

    @Test
    public void explicitResolutionClearsTheGate() {
        assertThat(gate.tryReserveCurrentBoot("17.26.7.24")).isTrue();

        assertThat(gate.clear()).isTrue();

        assertThat(gate.isRetryBlockedThisBoot()).isFalse();
    }

    @Test
    public void missingBootIdentityFailsClosed() {
        bootId.set(null);

        assertThat(gate.isRetryBlockedThisBoot()).isTrue();
        assertThat(gate.tryReserveCurrentBoot("17.26.7.24")).isFalse();
    }

    @Test
    public void concurrentReservationsAllowExactlyOneAuthorization() throws Exception {
        BesOtaAuthorizationGate secondGate = new BesOtaAuthorizationGate(context, bootId::get);
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            Future<Boolean> first =
                    executor.submit(
                            () -> {
                                start.await();
                                return gate.tryReserveCurrentBoot("17.26.7.24");
                            });
            Future<Boolean> second =
                    executor.submit(
                            () -> {
                                start.await();
                                return secondGate.tryReserveCurrentBoot("17.26.7.24");
                            });
            start.countDown();

            assertThat(first.get() ^ second.get()).isTrue();
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    public void persistedReservationRestoresQuarantineOnlyForSameBoot() {
        assertThat(gate.tryReserveCurrentBoot("17.26.7.24")).isTrue();
        BesOtaAuthorizationGate afterProcessRestart =
                new BesOtaAuthorizationGate(context, bootId::get);

        assertThat(afterProcessRestart.isQuarantinedForCurrentBoot()).isTrue();

        bootId.set("linux:boot-b");
        assertThat(afterProcessRestart.isQuarantinedForCurrentBoot()).isFalse();
    }

    @Test
    public void applyPendingSurvivesProcessRestartUntilExactVersionReadback() {
        assertThat(gate.tryReserveCurrentBoot("17.26.7.24")).isTrue();
        assertThat(gate.markApplyPending()).isTrue();

        BesOtaAuthorizationGate afterProcessRestart =
                new BesOtaAuthorizationGate(context, bootId::get);
        assertThat(afterProcessRestart.isPostApplyVerificationPendingForCurrentBoot()).isTrue();
        assertThat(afterProcessRestart.getExpectedTargetVersion()).isEqualTo("17.26.7.24");
        assertThat(afterProcessRestart.verifyPostApplyVersion("17.26.7.24"))
                .isEqualTo(BesOtaAuthorizationGate.PostApplyVerification.VERIFIED);
        assertThat(afterProcessRestart.isQuarantinedForCurrentBoot()).isFalse();
    }

    @Test
    public void unexpectedPostApplyVersionIsSafeButDoesNotReportSuccess() {
        assertThat(gate.tryReserveCurrentBoot("17.26.7.24")).isTrue();
        assertThat(gate.markApplyPending()).isTrue();

        assertThat(gate.verifyPostApplyVersion("17.26.7.23"))
                .isEqualTo(BesOtaAuthorizationGate.PostApplyVerification.VERSION_MISMATCH);
        assertThat(gate.isQuarantinedForCurrentBoot()).isFalse();
    }

}
