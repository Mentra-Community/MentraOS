package com.mentra.asg_client.service.system.managers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.content.Intent;
import android.os.Looper;

import androidx.test.core.app.ApplicationProvider;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.time.Duration;
import java.util.List;

/** Verifies MentraLiveSystemController emits the expected forked-SystemUI broadcasts. */
@RunWith(RobolectricTestRunner.class)
@Config(
        application = Application.class,
        sdk = {30, 33})
public class MentraLiveSystemControllerTest {

    @Test
    public void setSystemTime_emitsSetTimeBroadcastWithMillis() {
        Application app = ApplicationProvider.getApplicationContext();
        MentraLiveSystemController controller = new MentraLiveSystemController(app);

        controller.setSystemTime(1_700_000_000_000L);

        Intent intent = lastBroadcast(app);
        assertThat(intent.getStringExtra("cmd")).isEqualTo("settime");
        assertThat(intent.getLongExtra("timemills", -1L)).isEqualTo(1_700_000_000_000L);
        assertThat(intent.getAction()).isEqualTo("com.xy.xsetting.action");
        assertThat(intent.getPackage()).isEqualTo("com.android.systemui");
    }

    @Test
    public void reboot_emitsRebootBroadcast() {
        Application app = ApplicationProvider.getApplicationContext();
        MentraLiveSystemController controller = new MentraLiveSystemController(app);

        controller.reboot();

        assertThat(lastBroadcast(app).getStringExtra("cmd")).isEqualTo("reboot");
    }

    @Test
    public void setWifiAdb_emitsWifiAdbBroadcast() {
        Application app = ApplicationProvider.getApplicationContext();
        MentraLiveSystemController controller = new MentraLiveSystemController(app);

        controller.setWifiAdb(true);

        Intent intent = lastBroadcast(app);
        assertThat(intent.getStringExtra("cmd")).isEqualTo("wifiadb");
        assertThat(intent.getBooleanExtra("enable", false)).isTrue();
        assertThat(intent.getAction()).isEqualTo("com.xy.xsetting.action");
        assertThat(intent.getPackage()).isEqualTo("com.android.systemui");
    }

    @Test
    public void wifiRefreshEmitsConnectForgetAndFreshConnect() {
        Application app = ApplicationProvider.getApplicationContext();
        MentraLiveSystemController controller = new MentraLiveSystemController(app);

        controller.connectToWifiWithCredentialRefresh("Test AP", "test-password");
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(800));

        assertThat(shadowOf(app).getBroadcastIntents())
                .extracting(intent -> intent.getStringExtra("cmd"))
                .containsExactly("connectwifi", "disconnectwifi", "connectwifi");
        assertThat(lastBroadcast(app).getStringExtra("ssid")).isEqualTo("Test AP");
        assertThat(lastBroadcast(app).getStringExtra("pwd")).isEqualTo("test-password");
    }

    @Test
    public void newerWifiRequestCancelsBothOldRefreshStages() {
        Application app = ApplicationProvider.getApplicationContext();
        MentraLiveSystemController controller = new MentraLiveSystemController(app);

        controller.connectToWifiWithCredentialRefresh("Old AP", "old-password");
        controller.connectToWifiWithCredentialRefresh("New AP", "new-password");
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1));

        assertThat(shadowOf(app).getBroadcastIntents())
                .extracting(intent -> intent.getStringExtra("ssid"))
                .containsExactly("Old AP", "New AP", "New AP", "New AP");
    }

    @Test
    public void cancellationBetweenRefreshStagesPreventsReconnect() {
        Application app = ApplicationProvider.getApplicationContext();
        MentraLiveSystemController controller = new MentraLiveSystemController(app);

        controller.connectToWifiWithCredentialRefresh("Test AP", "test-password");
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(300));
        controller.cancelPendingWifiConnection();
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1));

        assertThat(shadowOf(app).getBroadcastIntents())
                .extracting(intent -> intent.getStringExtra("cmd"))
                .containsExactly("connectwifi", "disconnectwifi");
    }

    @Test
    public void disconnectAndForgetCancelQueuedReconnects() {
        Application app = ApplicationProvider.getApplicationContext();
        MentraLiveSystemController controller = new MentraLiveSystemController(app);

        controller.connectToWifiWithCredentialRefresh("Test AP", "test-password");
        controller.disconnectFromWifi();
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1));
        controller.connectToWifiWithCredentialRefresh("Test AP", "new-password");
        controller.disconnectFromWifi("Test AP");
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1));

        assertThat(shadowOf(app).getBroadcastIntents())
                .extracting(intent -> intent.getStringExtra("cmd"))
                .containsExactly("connectwifi", "disconnectwifi", "connectwifi", "disconnectwifi");
    }

    private static Intent lastBroadcast(Application app) {
        List<Intent> intents = shadowOf(app).getBroadcastIntents();
        assertThat(intents).isNotEmpty();
        return intents.get(intents.size() - 1);
    }
}
