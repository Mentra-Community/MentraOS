package com.mentra.asg_client.io.bes;

import static org.assertj.core.api.Assertions.assertThat;

import android.app.Application;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.AsgConstants;
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
        assertThat(gate.markAttemptedThisBoot()).isTrue();
        assertThat(gate.isRetryBlockedThisBoot()).isTrue();

        BesOtaAuthorizationGate afterProcessRestart =
                new BesOtaAuthorizationGate(context, bootId::get);
        assertThat(afterProcessRestart.isRetryBlockedThisBoot()).isTrue();
    }

    @Test
    public void newGlassesBootAllowsOneFreshAttempt() {
        assertThat(gate.markAttemptedThisBoot()).isTrue();

        bootId.set("linux:boot-b");

        assertThat(gate.isRetryBlockedThisBoot()).isFalse();
    }

    @Test
    public void explicitResolutionClearsTheGate() {
        assertThat(gate.markAttemptedThisBoot()).isTrue();

        gate.clear();

        assertThat(gate.isRetryBlockedThisBoot()).isFalse();
    }

    @Test
    public void missingBootIdentityFailsClosed() {
        bootId.set(null);

        assertThat(gate.isRetryBlockedThisBoot()).isTrue();
        assertThat(gate.markAttemptedThisBoot()).isFalse();
    }
}
