package com.mentra.asg_client.audio;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.app.Application;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.utils.WakeLockManager;
import com.mentra.asg_client.utils.WakeLockManager.WakeOwner;
import java.io.File;
import java.io.IOException;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.ArgumentCaptor;
import org.mockito.MockedStatic;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class PairingCodeSpeakerTest {

    private Application app;
    private IHardwareManager hardware;

    @Before
    public void setUp() {
        app = ApplicationProvider.getApplicationContext();
        hardware = mock(IHardwareManager.class);
        WakeLockManager.release(WakeOwner.PAIRING_CODE);
        deletePairingCacheFiles();
    }

    @After
    public void tearDown() {
        WakeLockManager.release(WakeOwner.PAIRING_CODE);
        deletePairingCacheFiles();
    }

    @Test
    public void speak_blankCode_returnsFalseWithoutPlayback() {
        assertThat(PairingCodeSpeaker.speak(app, hardware, "   ")).isFalse();
        verify(hardware, never()).supportsAudioPlayback();
        verify(hardware, never()).playAudioFile(any());
    }

    @Test
    public void speak_nullCode_returnsFalse() {
        assertThat(PairingCodeSpeaker.speak(app, hardware, null)).isFalse();
        verify(hardware, never()).playAudioFile(any());
    }

    @Test
    public void speak_malformedCode_returnsFalse() {
        assertThat(PairingCodeSpeaker.speak(app, hardware, "A-B")).isFalse();
        assertThat(PairingCodeSpeaker.speak(app, hardware, "12345")).isFalse();
        assertThat(PairingCodeSpeaker.speak(app, hardware, "12G4")).isFalse();
        verify(hardware, never()).playAudioFile(any());
    }

    @Test
    public void speak_playbackUnsupported_skipsStitching() {
        when(hardware.supportsAudioPlayback()).thenReturn(false);

        assertThat(PairingCodeSpeaker.speak(app, hardware, "A12B")).isFalse();
        verify(hardware, never()).playAudioFile(any());
        File[] cache =
                app.getCacheDir().listFiles((dir, name) -> name.startsWith("pairing_code_"));
        assertThat(cache).isEmpty();
    }

    @Test
    public void speak_stitcherThrows_returnsFalse() {
        when(hardware.supportsAudioPlayback()).thenReturn(true);
        try (MockedStatic<PairingCodePcmStitcher> stitcher =
                org.mockito.Mockito.mockStatic(PairingCodePcmStitcher.class)) {
            stitcher
                    .when(() -> PairingCodePcmStitcher.stitchCodeToCache(any(), any()))
                    .thenThrow(new IOException("boom"));

            assertThat(PairingCodeSpeaker.speak(app, hardware, "A12B")).isFalse();
        }
        verify(hardware, never()).playAudioFile(any());
    }

    @Test
    public void speak_a12b_playsStitchedCacheFile() {
        when(hardware.supportsAudioPlayback()).thenReturn(true);
        when(hardware.playAudioFile(any(File.class))).thenReturn(true);

        assertThat(PairingCodeSpeaker.speak(app, hardware, "  A12B  ")).isTrue();

        ArgumentCaptor<File> file = ArgumentCaptor.forClass(File.class);
        verify(hardware).playAudioFile(file.capture());
        assertThat(file.getValue().getName()).startsWith("pairing_code_");
        assertThat(file.getValue().getName()).endsWith(".wav");
        assertThat(file.getValue()).exists();
    }

    @Test
    public void speak_holdsWakeLeaseForFullInstructionAndCode() throws Exception {
        when(hardware.supportsAudioPlayback()).thenReturn(true);
        when(hardware.playAudioFile(any(File.class))).thenReturn(true);
        File stitched = new File(app.getCacheDir(), "pairing_code_test.wav");

        try (MockedStatic<WakeLockManager> wakeLocks =
                        org.mockito.Mockito.mockStatic(WakeLockManager.class);
                MockedStatic<PairingCodePcmStitcher> stitcher =
                        org.mockito.Mockito.mockStatic(PairingCodePcmStitcher.class)) {
            stitcher
                    .when(() -> PairingCodePcmStitcher.stitchCodeToCache(app, "A12B"))
                    .thenReturn(stitched);

            assertThat(PairingCodeSpeaker.speak(app, hardware, "A12B")).isTrue();

            wakeLocks.verify(
                    () ->
                            WakeLockManager.acquireScreen(
                                    app, WakeOwner.PAIRING_CODE, 15_000L));
        }
    }

    @Test
    public void speak_repeatedCode_usesDistinctFiles() {
        when(hardware.supportsAudioPlayback()).thenReturn(true);
        when(hardware.playAudioFile(any(File.class))).thenReturn(true);

        assertThat(PairingCodeSpeaker.speak(app, hardware, "A12B")).isTrue();
        assertThat(PairingCodeSpeaker.speak(app, hardware, "A12B")).isTrue();

        ArgumentCaptor<File> files = ArgumentCaptor.forClass(File.class);
        verify(hardware, org.mockito.Mockito.times(2)).playAudioFile(files.capture());
        assertThat(files.getAllValues().get(0)).isNotEqualTo(files.getAllValues().get(1));
    }

    @Test
    public void speakPairingEnded_playsExitAsset() {
        when(hardware.supportsAudioPlayback()).thenReturn(true);

        assertThat(PairingCodeSpeaker.speakPairingEnded(app, hardware)).isTrue();

        verify(hardware).playAudioAsset(AudioAssets.PAIRING_EXITED);
    }

    @Test
    public void chooseEndedAsset_timeout_usesNoPhoneClip() {
        assertThat(PairingCodeSpeaker.chooseEndedAsset("timeout", name -> true))
                .isEqualTo(AudioAssets.AUDIO_PAIRING_ENDED_NO_PHONE);
        assertThat(AudioAssets.AUDIO_PAIRING_ENDED_NO_PHONE)
                .isEqualTo("pairing/pairing_ended_no_phone.wav");
    }

    @Test
    public void chooseEndedAsset_cancelled_usesCancelledClip() {
        assertThat(PairingCodeSpeaker.chooseEndedAsset("cancelled", name -> true))
                .isEqualTo(AudioAssets.AUDIO_PAIRING_CANCELLED);
        assertThat(AudioAssets.AUDIO_PAIRING_CANCELLED).isEqualTo("pairing/pairing_cancelled.wav");
    }

    @Test
    public void chooseEndedAsset_pairedUnknownOrMissing_usesGenericClip() {
        for (String reason : new String[] {"paired", "unknown", "idle_timeout", "", null}) {
            assertThat(PairingCodeSpeaker.chooseEndedAsset(reason, name -> true))
                    .as("reason=%s", reason)
                    .isEqualTo(AudioAssets.PAIRING_EXITED);
        }
    }

    @Test
    public void chooseEndedAsset_missingAsset_fallsBackToGenericClip() {
        assertThat(PairingCodeSpeaker.chooseEndedAsset("timeout", name -> false))
                .isEqualTo(AudioAssets.PAIRING_EXITED);
        assertThat(PairingCodeSpeaker.chooseEndedAsset("cancelled", name -> false))
                .isEqualTo(AudioAssets.PAIRING_EXITED);
        assertThat(
                        PairingCodeSpeaker.chooseEndedAsset(
                                "timeout",
                                name -> {
                                    throw new IllegalStateException("boom");
                                }))
                .isEqualTo(AudioAssets.PAIRING_EXITED);
        assertThat(PairingCodeSpeaker.chooseEndedAsset("timeout", null))
                .isEqualTo(AudioAssets.PAIRING_EXITED);
    }

    @Test
    public void chooseEndedAsset_isCaseAndWhitespaceTolerant() {
        assertThat(PairingCodeSpeaker.chooseEndedAsset(" TimeOut ", name -> true))
                .isEqualTo(AudioAssets.AUDIO_PAIRING_ENDED_NO_PHONE);
    }

    @Test
    public void speakPairingEnded_withReasons_playsClipOrFallsBackWhenAssetNotPackaged() {
        when(hardware.supportsAudioPlayback()).thenReturn(true);

        assertThat(PairingCodeSpeaker.speakPairingEnded(app, hardware, "timeout")).isTrue();
        assertThat(PairingCodeSpeaker.speakPairingEnded(app, hardware, "cancelled")).isTrue();
        assertThat(PairingCodeSpeaker.speakPairingEnded(app, hardware, "paired")).isTrue();
        assertThat(PairingCodeSpeaker.speakPairingEnded(app, hardware, null)).isTrue();

        ArgumentCaptor<String> played = ArgumentCaptor.forClass(String.class);
        verify(hardware, org.mockito.Mockito.times(4)).playAudioAsset(played.capture());
        assertThat(played.getAllValues().get(0))
                .isEqualTo(packagedOrGeneric(AudioAssets.AUDIO_PAIRING_ENDED_NO_PHONE));
        assertThat(played.getAllValues().get(1))
                .isEqualTo(packagedOrGeneric(AudioAssets.AUDIO_PAIRING_CANCELLED));
        assertThat(played.getAllValues().get(2)).isEqualTo(AudioAssets.PAIRING_EXITED);
        assertThat(played.getAllValues().get(3)).isEqualTo(AudioAssets.PAIRING_EXITED);
    }

    @Test
    public void speakPairingEnded_audioUnavailable_doesNothing() {
        when(hardware.supportsAudioPlayback()).thenReturn(false);

        assertThat(PairingCodeSpeaker.speakPairingEnded(app, hardware, "timeout")).isFalse();
        verify(hardware, never()).playAudioAsset(any());
    }

    /** The WAVs are generated separately; until they are packaged the generic clip must play. */
    private String packagedOrGeneric(String asset) {
        try (java.io.InputStream ignored = app.getAssets().open(asset)) {
            return asset;
        } catch (IOException e) {
            return AudioAssets.PAIRING_EXITED;
        }
    }

    private void deletePairingCacheFiles() {
        File[] files =
                app.getCacheDir().listFiles((dir, name) -> name.startsWith("pairing_code_"));
        if (files == null) {
            return;
        }
        for (File file : files) {
            file.delete();
        }
    }
}
