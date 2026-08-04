package com.mentra.asg_client.io.bes;

import static org.assertj.core.api.Assertions.assertThat;

import android.app.Application;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bes.events.BesOtaProgressEvent;
import com.mentra.asg_client.io.bes.protocol.BesProtocolConstants;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.Subscribe;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class BesOtaPostApplyVerificationTest {
    private final List<BesOtaProgressEvent> events = new ArrayList<>();
    private Application context;
    private BesOtaManager manager;
    private AtomicReference<String> bootId;

    @Subscribe
    public void onEvent(BesOtaProgressEvent event) {
        events.add(event);
    }

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences(AsgConstants.BES_OTA_AUTH_GATE_PREFS, 0)
                .edit()
                .clear()
                .commit();
        context.getSharedPreferences("ota_session", 0).edit().clear().commit();
        bootId = new AtomicReference<>("linux:test-boot-a");
        manager =
                new BesOtaManager(
                        null, null, context, new BesOtaAuthorizationGate(context, bootId::get));
        EventBus.getDefault().register(this);
    }

    @After
    public void tearDown() {
        manager.abortIfInProgress();
        EventBus.getDefault().unregister(this);
        BesOtaManager.isBesOtaInProgress = false;
        context.getSharedPreferences(AsgConstants.BES_OTA_AUTH_GATE_PREFS, 0)
                .edit()
                .clear()
                .commit();
        context.getSharedPreferences("ota_session", 0).edit().clear().commit();
    }

    @Test
    public void applyAckDoesNotFinishUntilRebootedTargetVersionIsReadBack() throws Exception {
        BesOtaAuthorizationGate gate = authorizationGate();
        assertThat(gate.tryReserveCurrentBoot("17.26.7.24", "ota-session-a")).isTrue();
        BesOtaManager.isBesOtaInProgress = true;

        BesOtaMessage apply = new BesOtaMessage();
        apply.cmd = BesProtocolConstants.RCMD_APPLY;
        apply.len = 1;
        apply.body = new byte[] {1};
        Method deal = BesOtaManager.class.getDeclaredMethod("dealOtaRecvCmd", BesOtaMessage.class);
        deal.setAccessible(true);
        deal.invoke(manager, apply);

        assertThat(events).isEmpty();
        assertThat(gate.isPostApplyVerificationPendingForCurrentBoot()).isTrue();
        assertThat(BesOtaManager.isBesOtaInProgress).isTrue();
        assertThat(new BesOtaHandoffStore(context).isApplyPending()).isTrue();

        assertThat(gate.verifyPostApplyVersion("17.26.7.24"))
                .isEqualTo(BesOtaAuthorizationGate.PostApplyVerification.NOT_PENDING);
        bootId.set("linux:test-boot-b");

        assertThat(gate.verifyPostApplyVersion("17.26.7.24"))
                .isEqualTo(BesOtaAuthorizationGate.PostApplyVerification.VERIFIED);
        BesOtaHandoffStore.TerminalOutcome outcome =
                new BesOtaHandoffStore(context).getPendingTerminalOutcome();
        assertThat(outcome).isNotNull();
        assertThat(outcome.getStatus()).isEqualTo("FINISHED");

        // Reproduce the high-severity ordering: the already-dispatched timeout runs after the
        // verifier commits success but before BesOtaManager receives its UART listener callback.
        Runnable timeout = (Runnable) field("postApplyVerificationRunnable").get(manager);
        assertThat(timeout).isNotNull();
        timeout.run();
        assertThat(events).isEmpty();
        assertThat(new BesOtaHandoffStore(context).getPendingTerminalOutcome().getStatus())
                .isEqualTo("FINISHED");

        manager.onBesPostApplyVerification(
                true, "17.26.7.24", "17.26.7.24", "BES target version verified");

        assertThat(events).hasSize(1);
        assertThat(events.get(0).getStatus()).isEqualTo(BesOtaProgressEvent.OtaStatus.FINISHED);
        assertThat(BesOtaManager.isBesOtaInProgress).isFalse();
    }

    @Test
    public void recoveredVersionMismatchReportsFailureNotSuccess() {
        manager.onBesPostApplyVerification(
                false,
                "17.26.7.24",
                "17.26.7.23",
                "BES rebooted with an unexpected firmware version");

        assertThat(events).hasSize(1);
        assertThat(events.get(0).getStatus()).isEqualTo(BesOtaProgressEvent.OtaStatus.FAILED);
        assertThat(events.get(0).getErrorMessage())
                .isEqualTo("BES rebooted with an unexpected firmware version");
    }

    private BesOtaAuthorizationGate authorizationGate() throws Exception {
        return (BesOtaAuthorizationGate) field("authorizationGate").get(manager);
    }

    private Field field(String name) throws Exception {
        Field field = BesOtaManager.class.getDeclaredField(name);
        field.setAccessible(true);
        return field;
    }
}
