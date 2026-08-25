package com.mentra.asg_client.audio;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public class PairingCodePcmStitcherTest {

    private static final int SAMPLE_RATE = 44100;

    @Test
    public void getPairingCharAsset_mapsDigitsAndLetters() {
        assertThat(AudioAssets.getPairingCharAsset('0')).isEqualTo("pairing/digit_0.wav");
        assertThat(AudioAssets.getPairingCharAsset('9')).isEqualTo("pairing/digit_9.wav");
        assertThat(AudioAssets.getPairingCharAsset('A')).isEqualTo("pairing/letter_a.wav");
        assertThat(AudioAssets.getPairingCharAsset('f')).isEqualTo("pairing/letter_f.wav");
        assertThat(AudioAssets.getPairingCharAsset('Z')).isEqualTo("pairing/letter_z.wav");
        assertThat(AudioAssets.getPairingCharAsset('-')).isNull();
    }

    @Test
    public void trimSilence_dropsLeadingAndTrailingPad() {
        short[] samples = new short[] {0, 40, 12000, 8000, 10, 0};
        short[] trimmed = PairingCodePcmStitcher.trimSilence(samples);
        assertThat(trimmed).containsExactly((short) 12000, (short) 8000);
    }

    @Test
    public void stitchWavs_crossfadesIntoOneShorterPhrase() throws Exception {
        int silence = PairingCodePcmStitcher.msToSamples(200, SAMPLE_RATE);
        int tone = PairingCodePcmStitcher.msToSamples(100, SAMPLE_RATE);
        byte[] left = toneWav(silence, tone, silence, (short) 8000);
        byte[] right = toneWav(silence, tone, silence, (short) 4000);

        byte[] stitched =
                PairingCodePcmStitcher.stitchWavs(List.of(left, right));
        PairingCodePcmStitcher.PcmClip clip = PairingCodePcmStitcher.decodePcmWav(stitched);

        int overlap = PairingCodePcmStitcher.msToSamples(PairingCodePcmStitcher.CROSSFADE_MS, SAMPLE_RATE);
        assertThat(clip.sampleRate).isEqualTo(SAMPLE_RATE);
        assertThat(clip.samples.length).isEqualTo(tone * 2 - overlap);
        assertThat(clip.samples.length)
                .isLessThan(PairingCodePcmStitcher.decodePcmWav(left).samples.length);
    }

    @Test
    public void stitchWavs_rejectsEmptyList() {
        assertThatThrownBy(() -> PairingCodePcmStitcher.stitchWavs(List.of()))
                .isInstanceOf(java.io.IOException.class);
    }

    private static byte[] toneWav(int lead, int tone, int trail, short amplitude) {
        short[] samples = new short[lead + tone + trail];
        Arrays.fill(samples, lead, lead + tone, amplitude);
        return PairingCodePcmStitcher.encodePcmWav(samples, SAMPLE_RATE);
    }
}
