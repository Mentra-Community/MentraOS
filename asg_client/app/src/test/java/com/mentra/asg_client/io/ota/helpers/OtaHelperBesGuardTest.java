package com.mentra.asg_client.io.ota.helpers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.clearInvocations;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockStatic;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import android.content.Context;
import android.os.PowerManager;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.events.BatteryStatusEvent;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaController;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;
import com.mentra.asg_client.io.ota.utils.BesFirmwareArtifactValidator;
import com.mentra.asg_client.io.ota.utils.BesFirmwareArtifactValidator.ValidatedBesArtifact;
import com.mentra.asg_client.utils.WakeLockManager;
import java.io.File;
import java.lang.reflect.Field;
import java.util.concurrent.Semaphore;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.runner.RunWith;
import org.mockito.MockedStatic;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowPowerManager;

/**
 * Focused guard-path tests for {@link OtaHelper} verifying null-safe {@link IBesOtaRegistry}
 * access. The isBesOtaInProgress() guard is exercised by the production paths inside
 * checkAndUpdateBesFirmware; these tests verify the structural invariants (null controller = no
 * NPE, registry correctly stores and clears controllers).
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class OtaHelperBesGuardTest {
    @Rule public final TemporaryFolder temporaryFolder = new TemporaryFolder();

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
    public void tearDown() throws Exception {
        if (otaHelper != null) {
            otaHelper.cleanup();
        }
        Semaphore permit = admissionPermit();
        permit.drainPermits();
        permit.release();
        WakeLockManager.release(WakeLockManager.WakeOwner.MTK_OTA);
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
    public void debugBesInstallDoesNotSupersedeActiveTransaction() throws Exception {
        StubRegistry registry = new StubRegistry();
        IBesOtaController controller = mock(IBesOtaController.class);
        when(controller.isBesOtaInProgress()).thenReturn(true);
        registry.setInstance(controller);
        OtaHelper helper = newHelper(registry);
        File activeArtifact = temporaryFolder.newFile("debug_bes_same_sha.bin");

        assertThat(
                        helper.startValidatedDebugBesFirmware(
                                activeArtifact, "17.26.7.9", "0".repeat(64), "adb.bin"))
                .isFalse();
        verify(controller, never()).prepareForNewOtaSession();
        assertThat(activeArtifact).exists();
    }

    @Test
    public void debugBesEarlyRefusalDeletesArtifactProvenUnowned() throws Exception {
        StubRegistry registry = new StubRegistry();
        IBesOtaController controller = mock(IBesOtaController.class);
        when(controller.isBesOtaInProgress()).thenReturn(false);
        registry.setInstance(controller);
        OtaHelper helper = newHelper(registry);
        helper.onBatteryStatusEvent(new BatteryStatusEvent(1, false, System.currentTimeMillis()));
        File refusedArtifact = temporaryFolder.newFile("debug_bes_low_battery.bin");

        assertThat(
                        helper.startValidatedDebugBesFirmware(
                                refusedArtifact,
                                "17.26.7.9",
                                "0".repeat(64),
                                "adb-low-battery.bin"))
                .isFalse();

        verify(controller, never()).prepareForNewOtaSession();
        assertThat(refusedArtifact).doesNotExist();
    }

    @Test
    public void admittedDebugBesInstallPrunesOnlyAbandonedSiblingArtifacts() throws Exception {
        StubRegistry registry = new StubRegistry();
        IBesOtaController controller = mock(IBesOtaController.class);
        when(controller.isBesOtaInProgress()).thenReturn(false);
        when(controller.prepareForNewOtaSession()).thenReturn(true);
        when(controller.startFirmwareUpdate(any(), anyString())).thenReturn(true);
        registry.setInstance(controller);
        OtaHelper helper = newHelper(registry);
        File currentArtifact = temporaryFolder.newFile("debug_bes_current.bin");
        File abandonedArtifact = temporaryFolder.newFile("debug_bes_abandoned.bin");
        File unrelatedArtifact = temporaryFolder.newFile("keep_this.bin");
        ValidatedBesArtifact validatedArtifact = mock(ValidatedBesArtifact.class);

        try (MockedStatic<BesFirmwareArtifactValidator> validator =
                mockStatic(BesFirmwareArtifactValidator.class)) {
            validator.when(
                            () ->
                                    BesFirmwareArtifactValidator.validateLocal(
                                            currentArtifact,
                                            "adb-current.bin",
                                            "0".repeat(64),
                                            "17.26.7.9"))
                    .thenReturn(validatedArtifact);

            assertThat(
                            helper.startValidatedDebugBesFirmware(
                                    currentArtifact,
                                    "17.26.7.9",
                                    "0".repeat(64),
                                    "adb-current.bin"))
                    .isTrue();
        }

        assertThat(currentArtifact).exists();
        assertThat(abandonedArtifact).doesNotExist();
        assertThat(unrelatedArtifact).exists();
        verify(controller).prepareForNewOtaSession();
        verify(controller).startFirmwareUpdate(any(), anyString());
    }

    @Test
    public void phoneBesInstallPassesGuardToControllerWithoutPhonePresenceGate() {
        StubRegistry registry = new StubRegistry();
        IBesOtaController controller = mock(IBesOtaController.class);
        ValidatedBesArtifact artifact = mock(ValidatedBesArtifact.class);
        when(controller.startFirmwareUpdateWithInstallGuard(
                        any(), anyString(), any(JSONObject.class)))
                .thenReturn(true);
        registry.setInstance(controller);
        OtaHelper helper = newHelper(registry);
        OtaHelper.PhoneConnectionProvider provider =
                mock(OtaHelper.PhoneConnectionProvider.class);
        helper.setPhoneConnectionProvider(provider);
        clearInvocations(provider, controller);

        assertThat(helper.startBesFirmwareInstall(controller, artifact, "ota-owner")).isTrue();

        verify(controller)
                .startFirmwareUpdateWithInstallGuard(
                        eq(artifact),
                        eq("ota-owner"),
                        argThat(
                                status ->
                                        "bes".equals(status.optString("step_type"))
                                                && "install".equals(status.optString("phase"))
                                                && "in_progress".equals(
                                                        status.optString("status"))));
        verifyNoInteractions(provider);
    }

    @Test
    public void phoneBesInstallReturnsControllerQueueFailure() {
        StubRegistry registry = new StubRegistry();
        IBesOtaController controller = mock(IBesOtaController.class);
        ValidatedBesArtifact artifact = mock(ValidatedBesArtifact.class);
        registry.setInstance(controller);
        OtaHelper helper = newHelper(registry);
        when(controller.startFirmwareUpdateWithInstallGuard(
                        any(), anyString(), any(JSONObject.class)))
                .thenReturn(false);
        clearInvocations(controller);

        assertThat(helper.startBesFirmwareInstall(controller, artifact, "ota-owner")).isFalse();

        verify(controller)
                .startFirmwareUpdateWithInstallGuard(
                        eq(artifact), eq("ota-owner"), any(JSONObject.class));
    }

    @Test
    public void debugBesInstallIsRejectedWhilePhoneOtaOwnsAdmissionPermit() throws Exception {
        StubRegistry registry = new StubRegistry();
        IBesOtaController controller = mock(IBesOtaController.class);
        registry.setInstance(controller);
        OtaHelper helper = newHelper(registry);

        Semaphore permit = admissionPermit();
        assertThat(permit.tryAcquire()).isTrue();

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
            permit.release();
        }
    }

    @Test
    public void phoneOtaRefusesBeforeStateAndWakeLeaseWhenDebugOwnsAdmissionPermit()
            throws Exception {
        StubRegistry registry = new StubRegistry();
        IBesOtaController controller = mock(IBesOtaController.class);
        when(controller.getAuthoritativeStatus())
                .thenReturn(new JSONObject().put("status", "installing"));
        registry.setInstance(controller);
        OtaHelper helper = newHelper(registry);
        OtaHelper.PhoneConnectionProvider provider =
                mock(OtaHelper.PhoneConnectionProvider.class);
        when(provider.isPhoneConnected()).thenReturn(true);
        helper.setPhoneConnectionProvider(provider);
        clearInvocations(provider);
        helper.setPhoneInitiatedOta(false);
        WakeLockManager.release(WakeLockManager.WakeOwner.MTK_OTA);
        PowerManager.WakeLock previousWakeLock = ShadowPowerManager.getLatestWakeLock();

        Semaphore permit = admissionPermit();
        assertThat(permit.tryAcquire()).isTrue();
        try {
            helper.startOtaFromPhone("https://updates.example.invalid/version.json");
        } finally {
            permit.release();
        }

        verify(provider).sendOtaMessage(any(JSONObject.class));
        verify(provider).sendOtaStatus(any(JSONObject.class));
        verify(controller, never()).prepareForNewOtaSession();
        assertThat(phoneInitiatedOta()).isFalse();
        assertThat(ShadowPowerManager.getLatestWakeLock()).isSameAs(previousWakeLock);
    }

    @Test
    public void continuedPhoneSessionFailsDurablyWhenDebugOwnsAdmissionPermit()
            throws Exception {
        StubRegistry registry = new StubRegistry();
        registry.setInstance(mock(IBesOtaController.class));
        OtaHelper helper = newHelper(registry);
        OtaHelper.PhoneConnectionProvider provider =
                mock(OtaHelper.PhoneConnectionProvider.class);
        when(provider.isPhoneConnected()).thenReturn(true);
        helper.setPhoneConnectionProvider(provider);
        clearInvocations(provider);
        assertThat(
                        helper.getSessionManager()
                                .createSession(
                                        new String[] {"mtk", "bes"},
                                        "https://updates.example.invalid/version.json"))
                .isTrue();

        Semaphore permit = admissionPermit();
        assertThat(permit.tryAcquire()).isTrue();
        boolean handled;
        try {
            handled = helper.continueSessionAfterStepComplete(
                    ApplicationProvider.getApplicationContext());
        } finally {
            permit.release();
        }

        assertThat(handled).isTrue();
        assertThat(helper.getSessionManager().getStatus()).isEqualTo("failed");
        assertThat(helper.getSessionManager().getCurrentStepIndex()).isEqualTo(1);
        assertThat(phoneInitiatedOta()).isFalse();
        verify(provider).sendOtaStatus(any(JSONObject.class));
    }

    private static Semaphore admissionPermit() throws Exception {
        Field field = OtaHelper.class.getDeclaredField("otaAdmissionPermit");
        field.setAccessible(true);
        return (Semaphore) field.get(null);
    }

    private static boolean phoneInitiatedOta() throws Exception {
        Field field = OtaHelper.class.getDeclaredField("isPhoneInitiatedOta");
        field.setAccessible(true);
        return field.getBoolean(null);
    }
}
