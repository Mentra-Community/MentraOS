package com.mentra.asg_client.service.system.managers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.content.Intent;
import androidx.test.core.app.ApplicationProvider;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/** Verifies MentraLiveSystemController emits the expected forked-SystemUI broadcasts. */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
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

    private static Intent lastBroadcast(Application app) {
        List<Intent> intents = shadowOf(app).getBroadcastIntents();
        assertThat(intents).isNotEmpty();
        return intents.get(intents.size() - 1);
    }
}
