package com.mentra.asg_client.camera.policy;

import static org.assertj.core.api.Assertions.assertThat;

import android.media.MediaRecorder;

import com.mentra.asg_client.settings.VideoSettings;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class VideoRecorderPolicyTest {

    @Test
    public void videoEncodingBitRate_1080pClass() {
        assertThat(VideoRecorderPolicy.videoEncodingBitRateForWidth(1920)).isEqualTo(16_000_000);
        assertThat(VideoRecorderPolicy.videoEncodingBitRateForWidth(3840)).isEqualTo(16_000_000);
    }

    @Test
    public void videoEncodingBitRate_below1080pWidth() {
        assertThat(VideoRecorderPolicy.videoEncodingBitRateForWidth(1280)).isEqualTo(8_000_000);
        assertThat(VideoRecorderPolicy.videoEncodingBitRateForWidth(1919)).isEqualTo(8_000_000);
    }

    @Test
    public void videoFrameRate_defaultsTo30() {
        assertThat(VideoRecorderPolicy.videoFrameRate(null)).isEqualTo(30);
    }

    @Test
    public void videoFrameRate_fromSettings() {
        assertThat(VideoRecorderPolicy.videoFrameRate(new VideoSettings(1280, 720, 24))).isEqualTo(24);
    }

    @Test
    public void recorderSurfaceWarmup_preservesHistoricalDelay() {
        assertThat(VideoRecorderPolicy.RECORDER_SURFACE_WARMUP_MS).isEqualTo(900);
    }

    @Test
    public void mediaRecorderErrorMessage_serverDied() {
        assertThat(VideoRecorderPolicy.mediaRecorderErrorMessage(MediaRecorder.MEDIA_ERROR_SERVER_DIED))
                .contains("Media server died");
    }

    @Test
    public void mediaRecorderErrorMessage_unknown() {
        assertThat(VideoRecorderPolicy.mediaRecorderErrorMessage(MediaRecorder.MEDIA_RECORDER_ERROR_UNKNOWN))
                .contains("Unknown");
    }

    @Test
    public void mediaRecorderErrorMessage_other() {
        assertThat(VideoRecorderPolicy.mediaRecorderErrorMessage(999))
                .isEqualTo("Recording error: 999");
    }

    @Test
    public void infoFlags_matchMediaRecorderConstants() {
        assertThat(VideoRecorderPolicy.isInfoMaxDurationReached(
                MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED)).isTrue();
        assertThat(VideoRecorderPolicy.isInfoMaxFileSizeReached(
                MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED)).isTrue();
        assertThat(VideoRecorderPolicy.isInfoMaxFileSizeApproaching(
                MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_APPROACHING)).isTrue();
    }
}
