package com.mentra.asg_client.io.streaming;

import android.media.AudioAttributes;
import android.media.MediaRecorder;

import com.mentra.asg_client.io.streaming.config.WhipStreamConfig;

/**
 * Send-only capture settings for the WHIP audio device. A voice-call playout track shares the
 * Mentra Live speaker with the recording-started cue, so capture stays on the media route and
 * speaker playout stays muted.
 */
public final class WhipCaptureAudio {
    public final int audioSource;
    public final int usage;
    public final int contentType;
    public final boolean hardwareAcousticEchoCanceler;
    public final boolean hardwareNoiseSuppressor;
    public final boolean speakerMuted;

    public WhipCaptureAudio(
            int audioSource,
            int usage,
            int contentType,
            boolean hardwareAcousticEchoCanceler,
            boolean hardwareNoiseSuppressor,
            boolean speakerMuted) {
        this.audioSource = audioSource;
        this.usage = usage;
        this.contentType = contentType;
        this.hardwareAcousticEchoCanceler = hardwareAcousticEchoCanceler;
        this.hardwareNoiseSuppressor = hardwareNoiseSuppressor;
        this.speakerMuted = speakerMuted;
    }

    /** Media-route microphone capture. Hardware AEC and NS follow the stream config. */
    public static WhipCaptureAudio fromConfig(WhipStreamConfig config) {
        return new WhipCaptureAudio(
                MediaRecorder.AudioSource.MIC,
                AudioAttributes.USAGE_MEDIA,
                AudioAttributes.CONTENT_TYPE_MUSIC,
                config != null && config.isEchoCancellation(),
                config != null && config.isNoiseSuppression(),
                true);
    }
}
