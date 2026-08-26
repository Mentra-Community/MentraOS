package com.mentra.asg_client.audio;

import static org.assertj.core.api.Assertions.assertThat;

import com.mentra.asg_client.AsgConstants;

import org.junit.Test;

public class I2SAudioControllerVolumeTest {

    @Test
    public void playbackVolumeForAsset_cameraPrepClick_isSlightlyBelowDefault() {
        assertThat(I2SAudioController.playbackVolumeForAsset(AudioAssets.CAMERA_PREP_CLICK))
                .isEqualTo(AsgConstants.CAMERA_PREP_CLICK_PLAYBACK_VOLUME)
                .isLessThan(AsgConstants.AUDIO_PLAYBACK_VOLUME);
    }

    @Test
    public void playbackVolumeForAsset_cameraSnap_isSignificantlyAboveDefault() {
        assertThat(I2SAudioController.playbackVolumeForAsset(AudioAssets.CAMERA_SNAP))
                .isEqualTo(AsgConstants.CAMERA_SNAP_PLAYBACK_VOLUME)
                .isGreaterThan(AsgConstants.AUDIO_PLAYBACK_VOLUME * 2.0f);
    }

    @Test
    public void playbackVolumeForAsset_otherAsset_usesDefault() {
        assertThat(I2SAudioController.playbackVolumeForAsset(AudioAssets.BATTERY_LOW))
                .isEqualTo(AsgConstants.AUDIO_PLAYBACK_VOLUME);
        assertThat(I2SAudioController.playbackVolumeForAsset(null))
                .isEqualTo(AsgConstants.AUDIO_PLAYBACK_VOLUME);
    }
}
