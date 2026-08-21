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
public class OtaSessionManagerHotspotLeaseTest {
    private Context context;

    @Before
    public void setUp() {
        context = ApplicationProvider.getApplicationContext();
        context.getSharedPreferences("ota_session", Context.MODE_PRIVATE).edit().clear().commit();
    }

    @Test
    public void wifiSessionNeverArmsHotspotLease() {
        OtaSessionManager manager = new OtaSessionManager(context);
        assertThat(
                        manager.createSession(
                                new String[] {"apk", "mtk"},
                                "https://example.com/version.json",
                                "wifi"))
                .isTrue();

        assertThat(manager.armHotspotRestartLease()).isFalse();
        assertThat(manager.shouldPreserveHotspotOnShutdown()).isFalse();
    }

    @Test
    public void hotspotLeasePersistsAndCanBeAdoptedOnlyOnce() {
        OtaSessionManager manager = new OtaSessionManager(context);
        assertThat(
                        manager.createSession(
                                new String[] {"apk", "mtk", "bes"},
                                "http://192.168.43.2:8791/manifest.json",
                                "hotspot"))
                .isTrue();
        assertThat(manager.armHotspotRestartLease()).isTrue();
        assertThat(manager.setRestarting()).isTrue();

        OtaSessionManager replacement = new OtaSessionManager(context);
        assertThat(replacement.getTransport()).isEqualTo("hotspot");
        assertThat(replacement.shouldPreserveHotspotOnShutdown()).isTrue();
        assertThat(replacement.adoptHotspotRestartLease()).isTrue();
        assertThat(replacement.hasAdoptedHotspotRestartLease()).isTrue();
        assertThat(replacement.hasArmedHotspotRestartLease()).isFalse();
        assertThat(replacement.shouldPreserveHotspotOnShutdown()).isFalse();
        assertThat(replacement.adoptHotspotRestartLease()).isFalse();

        OtaSessionManager reloadedAfterAdoption = new OtaSessionManager(context);
        assertThat(reloadedAfterAdoption.hasAdoptedHotspotRestartLease()).isTrue();
        assertThat(reloadedAfterAdoption.shouldPreserveHotspotOnShutdown()).isFalse();
    }

    @Test
    public void hotspotApkOnlySessionDoesNotArmLease() {
        OtaSessionManager manager = new OtaSessionManager(context);
        assertThat(
                        manager.createSession(
                                new String[] {"apk"},
                                "http://192.168.43.2:8791/manifest.json",
                                "hotspot"))
                .isTrue();

        assertThat(manager.armHotspotRestartLease()).isFalse();
        assertThat(manager.getCurrentStepIndex() + 1).isEqualTo(manager.getTotalSteps());
    }

    @Test
    public void leaseRejectsAChangedCurrentStep() {
        OtaSessionManager manager = new OtaSessionManager(context);
        assertThat(
                        manager.createSession(
                                new String[] {"apk", "mtk"},
                                "http://192.168.43.2:8791/manifest.json",
                                "hotspot"))
                .isTrue();
        assertThat(manager.armHotspotRestartLease()).isTrue();

        manager.advanceStep(1, "download");

        OtaSessionManager replacement = new OtaSessionManager(context);
        assertThat(replacement.shouldPreserveHotspotOnShutdown()).isFalse();
        assertThat(replacement.adoptHotspotRestartLease()).isFalse();
    }

    @Test
    public void terminalSessionClearsLease() {
        OtaSessionManager manager = new OtaSessionManager(context);
        assertThat(
                        manager.createSession(
                                new String[] {"apk", "bes"},
                                "http://192.168.43.2:8791/manifest.json",
                                "hotspot"))
                .isTrue();
        assertThat(manager.armHotspotRestartLease()).isTrue();

        manager.setFailed("test failure");

        OtaSessionManager replacement = new OtaSessionManager(context);
        assertThat(replacement.shouldPreserveHotspotOnShutdown()).isFalse();
        assertThat(replacement.hasArmedHotspotRestartLease()).isFalse();
    }
}
