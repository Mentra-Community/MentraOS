package com.mentra.asg_client.io.ota.helpers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaController;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;
import com.mentra.asg_client.service.utils.ProcessSessionId;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class OtaHelperActivitySnapshotTest {
    private OtaHelper helper;
    private IBesOtaController controller;
    private IBesOtaRegistry registry;
    private Semaphore admission;

    @Before
    public void setUp() throws Exception {
        Context context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("ota_session", Context.MODE_PRIVATE).edit().clear().commit();
        registry = mock(IBesOtaRegistry.class);
        controller = mock(IBesOtaController.class);
        when(registry.getInstance()).thenReturn(controller);
        helper = new OtaHelper(context, registry);
        Field field = OtaHelper.class.getDeclaredField("otaAdmissionPermit");
        field.setAccessible(true);
        admission = (Semaphore) field.get(null);
        admission.drainPermits();
        admission.release();
        setField("isUpdating", false);
        setField("isMtkOtaInProgress", false);
    }

    @After
    public void tearDown() throws Exception {
        helper.cleanup();
        admission.drainPermits();
        admission.release();
        setField("isUpdating", false);
        setField("isMtkOtaInProgress", false);
    }

    private void setField(String name, Object value) throws Exception {
        Field field = OtaHelper.class.getDeclaredField(name);
        field.setAccessible(true);
        field.set(helper, value);
    }

    @Test
    public void idleSnapshotReadsExistingOwnersWithoutTakingAdmissionOrStartingWork() throws Exception {
        JSONObject result = helper.getOtaActivitySnapshot("return-123");

        assertThat(result.getString("request_id")).isEqualTo("return-123");
        assertThat(result.getString("process_sid")).isEqualTo(ProcessSessionId.SID);
        assertThat(result.getInt("schema")).isEqualTo(1);
        assertThat(result.getLong("admission_generation")).isGreaterThanOrEqualTo(0);
        assertThat(result.getLong("elapsed_realtime_ms")).isGreaterThanOrEqualTo(0);
        assertThat(result.getBoolean("admission_held")).isFalse();
        assertThat(result.getBoolean("consistent")).isTrue();
        assertThat(result.getBoolean("updating")).isFalse();
        assertThat(result.getBoolean("mtk_in_progress")).isFalse();
        assertThat(result.getBoolean("bes_in_progress")).isFalse();
        assertThat(result.getJSONObject("session").getString("status")).isEqualTo("idle");
        assertThat(result.getJSONObject("session").getBoolean("restart_pending")).isFalse();
        assertThat(admission.availablePermits()).isEqualTo(1);
        verify(controller).isBesOtaInProgress();
        verifyNoMoreInteractions(controller);
    }

    @Test
    public void admissionAndEachInstallFlagRemainVisibleDespiteTerminalBesProjection() throws Exception {
        admission.acquire();
        setField("isUpdating", true);
        setField("isMtkOtaInProgress", true);
        when(controller.isBesOtaInProgress()).thenReturn(true);
        when(controller.getAuthoritativeStatus())
                .thenReturn(new JSONObject().put("status", "complete"));

        JSONObject result = helper.getOtaActivitySnapshot("return-busy");

        assertThat(result.getBoolean("admission_held")).isTrue();
        assertThat(result.getBoolean("updating")).isTrue();
        assertThat(result.getBoolean("mtk_in_progress")).isTrue();
        assertThat(result.getBoolean("bes_in_progress")).isTrue();
        assertThat(admission.availablePermits()).isZero();
    }

    @Test
    public void admissionStartingDuringOtherOwnerReadsCannotLookIdle() throws Exception {
        when(controller.isBesOtaInProgress()).thenAnswer(invocation -> {
            assertThat(admission.tryAcquire()).isTrue();
            return false;
        });

        assertThat(helper.getOtaActivitySnapshot("return-race").getBoolean("admission_held"))
                .isTrue();
        assertThat(admission.availablePermits()).isZero();
    }

    @Test
    public void completedAdmissionHandoffDuringSnapshotIsInconsistentEvenAfterPermitRelease()
            throws Exception {
        AtomicBoolean besActive = new AtomicBoolean(false);
        when(controller.isBesOtaInProgress()).thenAnswer(invocation -> {
            boolean observed = besActive.get();
            if (!observed) {
                Method reserve = OtaHelper.class.getDeclaredMethod("reserveOtaAdmission");
                reserve.setAccessible(true);
                assertThat(reserve.invoke(null)).isEqualTo(true);
                besActive.set(true);
                admission.release();
            }
            return observed;
        });

        JSONObject raced = helper.getOtaActivitySnapshot("return-handoff");
        assertThat(raced.getBoolean("admission_held")).isFalse();
        assertThat(raced.getBoolean("bes_in_progress")).isFalse();
        assertThat(raced.getBoolean("consistent")).isFalse();
        assertThat(admission.availablePermits()).isEqualTo(1);
        JSONObject fresh = helper.getOtaActivitySnapshot("return-after-handoff");
        assertThat(fresh.getLong("admission_generation"))
                .isEqualTo(raced.getLong("admission_generation") + 1);
        assertThat(fresh.getBoolean("consistent")).isTrue();
        assertThat(fresh.getBoolean("bes_in_progress")).isTrue();
    }

    @Test
    public void missingOwnersAreUnknownAndPendingRestartIsReadWithoutConsumption() throws Exception {
        helper.getSessionManager().createSession(new String[] {"apk"}, "https://example.com/ota.json");
        helper.getSessionManager().advanceStep(0, "install");
        assertThat(helper.getSessionManager().setRestarting()).isTrue();
        JSONObject result = helper.getOtaActivitySnapshot("return-restart");
        assertThat(result.getJSONObject("session").getBoolean("restart_pending")).isTrue();
        assertThat(helper.getSessionManager().isInRestartGuard()).isTrue();

        when(registry.getInstance()).thenReturn(null);
        setField("sessionManager", null);
        JSONObject unknown = helper.getOtaActivitySnapshot("return-unknown");
        assertThat(unknown.isNull("bes_in_progress")).isTrue();
        assertThat(unknown.isNull("session")).isTrue();
    }
}
