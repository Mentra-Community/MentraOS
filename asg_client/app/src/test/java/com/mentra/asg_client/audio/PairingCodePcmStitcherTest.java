package com.mentra.asg_client.audio;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.mentra.asg_client.AsgConstants;
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
    public void stitchWavs_insertsPauseBetweenTrimmedClips() throws Exception {
        int silence = PairingCodePcmStitcher.msToSamples(200, SAMPLE_RATE);
        int tone = PairingCodePcmStitcher.msToSamples(100, SAMPLE_RATE);
        byte[] left = toneWav(silence, tone, silence, (short) 8000);
        byte[] right = toneWav(silence, tone, silence, (short) 4000);

        byte[] stitched =
                PairingCodePcmStitcher.stitchWavs(List.of(left, right));
        PairingCodePcmStitcher.PcmClip clip = PairingCodePcmStitcher.decodePcmWav(stitched);

        int pause =
                PairingCodePcmStitcher.msToSamples(
                        AsgConstants.PAIRING_CODE_INTER_CHARACTER_PAUSE_MS, SAMPLE_RATE);
        assertThat(clip.sampleRate).isEqualTo(SAMPLE_RATE);
        assertThat(clip.samples.length).isEqualTo(tone * 2 + pause);
        assertThat(Arrays.copyOfRange(clip.samples, tone, tone + pause))
                .containsOnly((short) 0);
    }

    @Test
    public void stitchWavs_rejectsEmptyList() {
        assertThatThrownBy(() -> PairingCodePcmStitcher.stitchWavs(List.of()))
                .isInstanceOf(java.io.IOException.class);
    }

    @Test
    public void stitchPairingPhraseWavs_usesLongerPauseAfterIntro() throws Exception {
        int tone = PairingCodePcmStitcher.msToSamples(100, SAMPLE_RATE);
        byte[] intro = toneWav(0, tone, 0, (short) 8000);
        byte[] firstCode = toneWav(0, tone, 0, (short) 6000);
        byte[] secondCode = toneWav(0, tone, 0, (short) 4000);

        byte[] stitched =
                PairingCodePcmStitcher.stitchPairingPhraseWavs(
                        List.of(intro, firstCode, secondCode));
        PairingCodePcmStitcher.PcmClip clip = PairingCodePcmStitcher.decodePcmWav(stitched);

        int introPause =
                PairingCodePcmStitcher.msToSamples(
                        AsgConstants.PAIRING_INTRO_TO_CODE_PAUSE_MS, SAMPLE_RATE);
        int characterPause =
                PairingCodePcmStitcher.msToSamples(
                        AsgConstants.PAIRING_CODE_INTER_CHARACTER_PAUSE_MS, SAMPLE_RATE);
        assertThat(clip.samples.length).isEqualTo(tone * 3 + introPause + characterPause);
    }

    private static byte[] toneWav(int lead, int tone, int trail, short amplitude) {
        short[] samples = new short[lead + tone + trail];
        Arrays.fill(samples, lead, lead + tone, amplitude);
        return PairingCodePcmStitcher.encodePcmWav(samples, SAMPLE_RATE);
    }
}
