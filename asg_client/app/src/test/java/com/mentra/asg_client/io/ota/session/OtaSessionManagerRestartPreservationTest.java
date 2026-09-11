package com.mentra.asg_client.io.ota.session;

import static org.assertj.core.api.Assertions.assertThat;

import android.content.Context;
import androidx.test.core.app.ApplicationProvider;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class OtaSessionManagerRestartPreservationTest {
    private Context context;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("ota_session", Context.MODE_PRIVATE).edit().clear().commit();
    }

    @Test
    public void activeSessionBeforeApkInstallDoesNotPreserveHotspot() {
        OtaSessionManager manager = new OtaSessionManager(context);
        assertThat(
                        manager.createSession(
                                new String[] {"apk", "mtk"},
                                "https://example.com/version.json"))
                .isTrue();

        assertThat(manager.shouldPreserveHotspotOnShutdown()).isFalse();
    }

    @Test
    public void apkInstallRestartPersistsAsPreservationWindow() {
        OtaSessionManager manager = new OtaSessionManager(context);
        assertThat(
                        manager.createSession(
                                new String[] {"apk", "mtk", "bes"},
                                "http://192.168.43.2:8791/manifest.json"))
                .isTrue();
        manager.advanceStep(0, "install");
        assertThat(manager.setRestarting()).isTrue();

        OtaSessionManager replacement = new OtaSessionManager(context);
        assertThat(replacement.shouldPreserveHotspotOnShutdown()).isTrue();

        replacement.clearRestartGuard();
        assertThat(new OtaSessionManager(context).shouldPreserveHotspotOnShutdown()).isFalse();
    }

    @Test
    public void apkOnlyRestartAlsoPreservesAnyActiveHotspot() {
        OtaSessionManager manager = new OtaSessionManager(context);
        assertThat(
                        manager.createSession(
                                new String[] {"apk"},
                                "http://192.168.43.2:8791/manifest.json"))
                .isTrue();
        manager.advanceStep(0, "install");
        assertThat(manager.setRestarting()).isTrue();

        assertThat(new OtaSessionManager(context).shouldPreserveHotspotOnShutdown()).isTrue();
    }

    @Test
    public void nonApkRestartDoesNotPreserveHotspot() {
        OtaSessionManager manager = new OtaSessionManager(context);
        assertThat(
                        manager.createSession(
                                new String[] {"mtk", "bes"},
                                "https://example.com/version.json"))
                .isTrue();
        manager.advanceStep(0, "install");
        assertThat(manager.setRestarting()).isTrue();

        assertThat(new OtaSessionManager(context).shouldPreserveHotspotOnShutdown()).isFalse();
    }

    @Test
    public void terminalSessionDoesNotPreserveHotspot() {
        OtaSessionManager manager = new OtaSessionManager(context);
        assertThat(
                        manager.createSession(
                                new String[] {"apk", "bes"},
                                "http://192.168.43.2:8791/manifest.json"))
                .isTrue();
        manager.advanceStep(0, "install");
        assertThat(manager.setRestarting()).isTrue();

        manager.setFailed("test failure");

        assertThat(new OtaSessionManager(context).shouldPreserveHotspotOnShutdown()).isFalse();
    }
}
