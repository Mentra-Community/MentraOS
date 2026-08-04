package com.mentra.asg_client.io.bes;

import static org.assertj.core.api.Assertions.assertThat;

import android.app.Application;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaController;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;
import com.mentra.asg_client.io.ota.session.OtaSessionManager;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class BesOtaStartupHandoffTest {
    private Application context;
    private OtaHelper helper;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("ota_session", 0).edit().clear().commit();
        context.getSharedPreferences(AsgConstants.BES_OTA_AUTH_GATE_PREFS, 0)
                .edit()
                .clear()
                .commit();
    }

    @After
    public void tearDown() {
        if (helper != null) {
            helper.cleanup();
        }
        context.getSharedPreferences("ota_session", 0).edit().clear().commit();
        context.getSharedPreferences(AsgConstants.BES_OTA_AUTH_GATE_PREFS, 0)
                .edit()
                .clear()
                .commit();
    }

    @Test
    public void bootBVerificationBeforeOtaConsumerIsReplayedWhenConsumerStarts() {
        OtaSessionManager session = new OtaSessionManager(context);
        assertThat(session.createSession(new String[] {"bes"}, "https://example.test/v.json"))
                .isTrue();
        session.advanceStep(0, "install");

        AtomicReference<String> bootId = new AtomicReference<>("linux:boot-a");
        BesOtaAuthorizationGate gate = new BesOtaAuthorizationGate(context, bootId::get);
        assertThat(gate.tryReserveCurrentBoot("17.26.7.24")).isTrue();
        assertThat(gate.markApplyPending()).isTrue();
        bootId.set("linux:boot-b");

        // No OtaService/OtaHelper consumer exists when the one boot-B proof is consumed.
        assertThat(gate.verifyPostApplyVersion("17.26.7.24"))
                .isEqualTo(BesOtaAuthorizationGate.PostApplyVerification.VERIFIED);

        helper = new OtaHelper(context, new EmptyBesRegistry());
        RecordingPhone phone = new RecordingPhone();
        helper.setPhoneConnectionProvider(phone);
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();

        assertThat(helper.getSessionManager().getStatus()).isEqualTo("complete");
        assertThat(phone.statuses).isNotEmpty();
        assertThat(phone.statuses.get(phone.statuses.size() - 1).optString("status"))
                .isEqualTo("complete");
    }

    private static final class EmptyBesRegistry implements IBesOtaRegistry {
        @Override
        public IBesOtaController getInstance() {
            return null;
        }

        @Override
        public void setInstance(IBesOtaController controller) {}

        @Override
        public void clear() {}
    }

    private static final class RecordingPhone implements OtaHelper.PhoneConnectionProvider {
        private final List<JSONObject> statuses = new ArrayList<>();

        @Override
        public boolean isPhoneConnected() {
            return true;
        }

        @Override
        public void sendOtaMessage(JSONObject message) {}

        @Override
        public void sendOtaStatus(JSONObject status) {
            statuses.add(status);
        }
    }
}
