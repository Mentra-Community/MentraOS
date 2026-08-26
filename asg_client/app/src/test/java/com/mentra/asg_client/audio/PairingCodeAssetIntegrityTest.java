package com.mentra.asg_client.audio;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import android.app.Application;
import androidx.test.core.app.ApplicationProvider;
import java.io.File;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Pins the new ASG spoken-code path against the real pairing WAV assets: {@code hm_spkcode}
 * "A12B" must stitch into one cache WAV, and a bad character must fail before playback.
 */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class PairingCodeAssetIntegrityTest {

    @Test
    public void stitchCodeToCache_a12b_writesOneSpacedPhrase() throws Exception {
        Application app = ApplicationProvider.getApplicationContext();
        File wav = PairingCodePcmStitcher.stitchCodeToCache(app, "A12B");

        assertThat(wav.getName()).startsWith("pairing_code_");
        assertThat(wav.getName()).endsWith(".wav");
        assertThat(wav).exists();

        PairingCodePcmStitcher.PcmClip stitched =
                PairingCodePcmStitcher.decodePcmWav(java.nio.file.Files.readAllBytes(wav.toPath()));
        int rate = stitched.sampleRate;
        assertThat(rate).isGreaterThan(0);

        int trimmedSum = 0;
        for (char c : "A12B".toCharArray()) {
            String asset = AudioAssets.getPairingCharAsset(c);
            assertThat(asset).isNotNull();
            try (java.io.InputStream in = app.getAssets().open(asset)) {
                byte[] raw = in.readAllBytes();
                PairingCodePcmStitcher.PcmClip clip = PairingCodePcmStitcher.decodePcmWav(raw);
                assertThat(clip.sampleRate).isEqualTo(rate);
                trimmedSum += PairingCodePcmStitcher.trimSilence(clip.samples).length;
            }
        }
        int pauseSamples =
                PairingCodePcmStitcher.msToSamples(
                        PairingCodePcmStitcher.INTER_CHARACTER_PAUSE_MS, rate);
        assertThat(stitched.samples.length).isEqualTo(trimmedSum + pauseSamples * 3);
    }

    @Test
    public void stitchCodeToCache_unsupportedChar_throws() {
        Application app = ApplicationProvider.getApplicationContext();
        assertThatThrownBy(() -> PairingCodePcmStitcher.stitchCodeToCache(app, "A-B"))
                .isInstanceOf(java.io.IOException.class)
                .hasMessageContaining("unsupported pairing character '-'");
    }
}
