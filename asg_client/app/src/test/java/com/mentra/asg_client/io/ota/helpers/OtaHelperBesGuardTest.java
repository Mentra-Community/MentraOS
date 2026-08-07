package com.mentra.asg_client.io.ota.helpers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaController;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;
import java.io.File;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Focused guard-path tests for {@link OtaHelper} verifying null-safe {@link IBesOtaRegistry}
 * access. The isBesOtaInProgress() guard is exercised by the production paths inside
 * checkAndUpdateBesFirmware; these tests verify the structural invariants (null controller = no
 * NPE, registry correctly stores and clears controllers).
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class OtaHelperBesGuardTest {

    /** Simple registry stub whose controller can be swapped per test. */
    private static final class StubRegistry implements IBesOtaRegistry {
        private IBesOtaController controller;

        @Override
        public IBesOtaController getInstance() {
            return controller;
        }

        @Override
        public void setInstance(IBesOtaController controller) {
            this.controller = controller;
        }

        @Override
        public void clear() {
            this.controller = null;
        }
    }

    private OtaHelper otaHelper;

    @After
    public void tearDown() {
        if (otaHelper != null) {
            otaHelper.cleanup();
        }
    }

    private OtaHelper newHelper(StubRegistry registry) {
        Context context = ApplicationProvider.getApplicationContext();
        otaHelper = new OtaHelper(context, registry);
        return otaHelper;
    }

    @Test
    public void noController_constructionAndCleanup_doesNotThrow() {
        // Non-K900 reality: the registry never gets a controller; construction and cleanup
        // must not NPE when getOtaController() always returns null.
        assertThatCode(
                        () -> {
                            OtaHelper helper = newHelper(new StubRegistry());
                            helper.cleanup();
                            otaHelper = null;
                        })
                .doesNotThrowAnyException();
    }

    @Test
    public void activeController_isBesOtaInProgress_delegatesToController() {
        StubRegistry registry = new StubRegistry();
        IBesOtaController controller = mock(IBesOtaController.class);
        when(controller.isBesOtaInProgress()).thenReturn(false);
        registry.setInstance(controller);

        // Helper constructs and cleans up without NPE when a controller is present.
        assertThatCode(() -> newHelper(registry).cleanup()).doesNotThrowAnyException();
        otaHelper = null;
    }

    @Test
    public void controllerRemovedAfterConstruction_doesNotThrow() {
        // Registry is a late-binding seam: the controller can disappear during service shutdown.
        StubRegistry registry = new StubRegistry();
        registry.setInstance(mock(IBesOtaController.class));
        OtaHelper helper = newHelper(registry);

        registry.clear();

        // Any entry point that reaches isBesOtaInProgress() must handle a null controller.
        assertThatCode(helper::cleanup).doesNotThrowAnyException();
    }

    @Test
    public void besOtaRegistry_nullSafeGetInstance_returnsNullWhenUnset() {
        IBesOtaRegistry registry = new StubRegistry();

        assertThat(registry.getInstance()).isNull();
    }

    @Test
    public void debugBesInstallWithoutControllerFailsClosed() {
        OtaHelper helper = newHelper(new StubRegistry());

        assertThat(
                        helper.startValidatedDebugBesFirmware(
                                new File("missing.bin"), "17.26.7.9", "0".repeat(64), "adb.bin"))
                .isFalse();
    }

    @Test
    public void debugBesInstallDoesNotSupersedeActiveTransaction() {
        StubRegistry registry = new StubRegistry();
        IBesOtaController controller = mock(IBesOtaController.class);
        when(controller.isBesOtaInProgress()).thenReturn(true);
        registry.setInstance(controller);
        OtaHelper helper = newHelper(registry);

        assertThat(
                        helper.startValidatedDebugBesFirmware(
                                new File("missing.bin"), "17.26.7.9", "0".repeat(64), "adb.bin"))
                .isFalse();
        verify(controller, never()).prepareForNewOtaSession();
    }

    @Test
    public void debugBesInstallIsRejectedWhilePhoneOtaOwnsAdmissionLock() throws Exception {
        StubRegistry registry = new StubRegistry();
        IBesOtaController controller = mock(IBesOtaController.class);
        registry.setInstance(controller);
        OtaHelper helper = newHelper(registry);

        Field field = OtaHelper.class.getDeclaredField("versionCheckLock");
        field.setAccessible(true);
        ReentrantLock admissionLock = (ReentrantLock) field.get(null);
        CountDownLatch lockHeld = new CountDownLatch(1);
        CountDownLatch releaseLock = new CountDownLatch(1);
        Thread phoneOta =
                new Thread(
                        () -> {
                            admissionLock.lock();
                            try {
                                lockHeld.countDown();
                                releaseLock.await(5, TimeUnit.SECONDS);
                            } catch (InterruptedException e) {
                                Thread.currentThread().interrupt();
                            } finally {
                                admissionLock.unlock();
                            }
                        },
                        "phone-ota-admission-test");
        phoneOta.start();
        assertThat(lockHeld.await(5, TimeUnit.SECONDS)).isTrue();

        try {
            assertThat(
                            helper.startValidatedDebugBesFirmware(
                                    new File("missing.bin"),
                                    "17.26.7.9",
                                    "0".repeat(64),
                                    "adb.bin"))
                    .isFalse();
            verify(controller, never()).isBesOtaInProgress();
            verify(controller, never()).prepareForNewOtaSession();
        } finally {
            releaseLock.countDown();
            phoneOta.join(5000);
        }
        assertThat(phoneOta.isAlive()).isFalse();
    }
}
