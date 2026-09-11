package com.mentra.asg_client.audio;

import static org.assertj.core.api.Assertions.assertThat;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.content.Intent;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.service.core.AsgClientService;
import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowApplication;

/**
 * {@link I2SAudioController#playFile} opens I2S via a service intent when AsgClientService is
 * not running. A leaked path would leave {@code EXTRA_I2S_AUDIO_PLAYING=true} with no close.
 */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class I2SAudioControllerPlayFileTest {

    private Application app;
    private I2SAudioController controller;
    private ShadowApplication shadowApp;

    @Before
    public void setUp() {
        app = ApplicationProvider.getApplicationContext();
        controller = new I2SAudioController(app);
        shadowApp = shadowOf(app);
        drainStartedServices();
    }

    @After
    public void tearDown() {
        controller.stopPlayback();
        drainStartedServices();
    }

    @Test
    public void playFile_null_doesNotOpenI2s() {
        controller.playFile(null, 0.1f);
        assertThat(drainStartedServices()).isEmpty();
    }

    @Test
    public void playFile_missingFile_stillClosesI2s() {
        controller.playFile(new File(app.getCacheDir(), "missing-pairing.wav"), 0.1f);

        List<Boolean> playing = playingFlags(drainStartedServices());
        assertThat(playing).containsExactly(true, false);
    }

    @Test
    public void playFile_validWav_opensI2s() throws Exception {
        File wav = writeToneWav();
        controller.playFile(wav, 0.1f);

        List<Boolean> playing = playingFlags(drainStartedServices());
        assertThat(playing).isNotEmpty();
        assertThat(playing.get(0)).isTrue();
        controller.stopPlayback();
        List<Boolean> afterStop = playingFlags(drainStartedServices());
        assertThat(afterStop).contains(false);
    }

    private File writeToneWav() throws Exception {
        short[] samples = new short[4410];
        for (int i = 0; i < samples.length; i++) {
            samples[i] = (short) ((i % 20) * 100);
        }
        byte[] wav = PairingCodePcmStitcher.encodePcmWav(samples, 44100);
        File out = new File(app.getCacheDir(), "i2s-tone.wav");
        try (FileOutputStream fos = new FileOutputStream(out)) {
            fos.write(wav);
        }
        return out;
    }

    private List<Intent> drainStartedServices() {
        List<Intent> intents = new ArrayList<>();
        Intent next;
        while ((next = shadowApp.getNextStartedService()) != null) {
            intents.add(next);
        }
        return intents;
    }

    private static List<Boolean> playingFlags(List<Intent> intents) {
        List<Boolean> flags = new ArrayList<>();
        for (Intent intent : intents) {
            if (AsgClientService.ACTION_I2S_AUDIO_STATE.equals(intent.getAction())) {
                flags.add(intent.getBooleanExtra(AsgClientService.EXTRA_I2S_AUDIO_PLAYING, false));
            }
        }
        return flags;
    }
}
