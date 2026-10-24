package com.mentra.asg_client.io.streaming;

import static org.assertj.core.api.Assertions.assertThat;

import android.media.AudioAttributes;
import android.media.MediaRecorder;
import com.mentra.asg_client.io.streaming.config.WhipStreamConfig;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class WhipCaptureAudioTest {
    @Test
    public void defaultsAreMediaRouteWithSpeakerMuted() {
        WhipCaptureAudio audio = WhipCaptureAudio.fromConfig(new WhipStreamConfig());

        assertThat(audio.audioSource).isEqualTo(MediaRecorder.AudioSource.MIC);
        assertThat(audio.usage).isEqualTo(AudioAttributes.USAGE_MEDIA);
        assertThat(audio.contentType).isEqualTo(AudioAttributes.CONTENT_TYPE_MUSIC);
        assertThat(audio.hardwareAcousticEchoCanceler).isFalse();
        assertThat(audio.hardwareNoiseSuppressor).isFalse();
        assertThat(audio.speakerMuted).isTrue();
    }

    @Test
    public void hardwareProcessingFollowsConfig() throws Exception {
        JSONObject audioJson = new JSONObject()
                .put("echoCancellation", true)
                .put("noiseSuppression", true);
        WhipStreamConfig config = WhipStreamConfig.fromJson(null, audioJson, null);

        WhipCaptureAudio audio = WhipCaptureAudio.fromConfig(config);

        assertThat(audio.hardwareAcousticEchoCanceler).isTrue();
        assertThat(audio.hardwareNoiseSuppressor).isTrue();
    }

    @Test
    public void nullConfigStaysSafe() {
        WhipCaptureAudio audio = WhipCaptureAudio.fromConfig(null);
        assertThat(audio.hardwareAcousticEchoCanceler).isFalse();
        assertThat(audio.hardwareNoiseSuppressor).isFalse();
        assertThat(audio.speakerMuted).isTrue();
    }
}
