package com.mentra.asg_client.io.ota.helpers;

import static org.assertj.core.api.Assertions.assertThat;

import android.app.Application;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaController;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;
import java.util.ArrayList;
import java.util.List;
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
public class OtaHelperBesTerminalTest {
    private Application context;
    private OtaHelper helper;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("ota_session", 0).edit().clear().commit();
        helper = new OtaHelper(context, new EmptyBesRegistry());
    }

    @After
    public void tearDown() {
        helper.cleanup();
        context.getSharedPreferences("ota_session", 0).edit().clear().commit();
    }

    @Test
    public void verifiedBesSuccessPersistsAndResendsTerminalSessionStatus() {
        assertThat(
                        helper.getSessionManager()
                                .createSession(
                                        new String[] {"bes"}, "https://example.test/v.json"))
                .isTrue();
        helper.getSessionManager().advanceStep(0, "install");
        helper.getSessionManager().setBesInstallPendingAcrossReboot(true);
        RecordingPhone phone = new RecordingPhone();
        helper.setPhoneConnectionProvider(phone);

        helper.sendBesInstallProgressToPhone("FINISHED", 100, null);
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();

        assertThat(helper.getSessionManager().getStatus()).isEqualTo("complete");
        assertThat(helper.getSessionManager().isBesTerminalDeliveryPending()).isTrue();
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
