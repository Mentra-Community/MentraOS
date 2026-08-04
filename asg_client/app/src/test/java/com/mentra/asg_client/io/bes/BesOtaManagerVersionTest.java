package com.mentra.asg_client.io.bes;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaController;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Exercises the version-comparison methods of {@code BesOtaManager} through the core {@link
 * IBesOtaController} interface (these were previously statics consumed directly by {@code
 * OtaHelper}).
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class BesOtaManagerVersionTest {

    private IBesOtaController controller;
    private Context context;
    private boolean previousInProgressFlag;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences(AsgConstants.BES_OTA_AUTH_GATE_PREFS, 0)
                .edit()
                .clear()
                .commit();
        controller = new BesOtaManager(null, mock(K900BluetoothManager.class), context);
        previousInProgressFlag = BesOtaManager.isBesOtaInProgress;
    }

    @After
    public void tearDown() {
        // The in-progress flag is static — restore it so state never leaks across tests.
        BesOtaManager.isBesOtaInProgress = previousInProgressFlag;
        context.getSharedPreferences(AsgConstants.BES_OTA_AUTH_GATE_PREFS, 0)
                .edit()
                .clear()
                .commit();
    }

    @Test
    public void parseServerVersionCode_splitsMajorMinorPatch() {
        // XYYYZZZ format: 17026001 -> major 17, minor 26, patch 1, build 0
        byte[] version = controller.parseServerVersionCode(17026001L);

        assertThat(version).containsExactly((byte) 17, (byte) 26, (byte) 1, (byte) 0);
    }

    @Test
    public void parseServerVersionCode_zero_isAllZero() {
        assertThat(controller.parseServerVersionCode(0L))
                .containsExactly((byte) 0, (byte) 0, (byte) 0, (byte) 0);
    }

    @Test
    public void isNewerVersion_newerMajor_true() {
        byte[] v1 = {2, 0, 0, 0};
        byte[] v2 = {1, 9, 9, 9};

        assertThat(controller.isNewerVersion(v1, v2)).isTrue();
    }

    @Test
    public void isNewerVersion_olderPatch_false() {
        byte[] v1 = {1, 2, 3, 0};
        byte[] v2 = {1, 2, 4, 0};

        assertThat(controller.isNewerVersion(v1, v2)).isFalse();
    }

    @Test
    public void isNewerVersion_equalVersions_false() {
        byte[] v = {1, 2, 3, 4};

        assertThat(controller.isNewerVersion(v, v)).isFalse();
    }

    @Test
    public void isNewerVersion_newerBuild_true() {
        byte[] v1 = {1, 2, 3, 5};
        byte[] v2 = {1, 2, 3, 4};

        assertThat(controller.isNewerVersion(v1, v2)).isTrue();
    }

    @Test
    public void isNewerVersion_nullOrShortInput_false() {
        byte[] valid = {1, 2, 3, 4};

        assertThat(controller.isNewerVersion(null, valid)).isFalse();
        assertThat(controller.isNewerVersion(valid, null)).isFalse();
        assertThat(controller.isNewerVersion(new byte[] {1, 2}, valid)).isFalse();
    }

    @Test
    public void isBesOtaInProgress_reflectsStaticFlag() {
        BesOtaManager.isBesOtaInProgress = false;
        assertThat(controller.isBesOtaInProgress()).isFalse();

        BesOtaManager.isBesOtaInProgress = true;
        assertThat(controller.isBesOtaInProgress()).isTrue();
    }

    @Test
    public void rejectedStartPersistsFailureWithTheRequestingSessionOwner() {
        BesOtaManager.isBesOtaInProgress = false;

        assertThat(controller.startFirmwareUpdate(
                        "/does/not/matter.bin", null, "session-b"))
                .isFalse();

        BesOtaHandoffStore.TerminalOutcome outcome =
                new BesOtaHandoffStore(context).getPendingTerminalOutcome();
        assertThat(outcome).isNotNull();
        assertThat(outcome.getSessionId()).isEqualTo("session-b");
        assertThat(outcome.getStatus()).isEqualTo("FAILED");
    }
}
