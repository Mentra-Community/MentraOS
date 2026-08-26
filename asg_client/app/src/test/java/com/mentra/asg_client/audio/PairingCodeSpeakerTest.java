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
    public void speak_repeatedCode_usesDistinctFiles() {
        when(hardware.supportsAudioPlayback()).thenReturn(true);
        when(hardware.playAudioFile(any(File.class))).thenReturn(true);

        assertThat(PairingCodeSpeaker.speak(app, hardware, "A12B")).isTrue();
        assertThat(PairingCodeSpeaker.speak(app, hardware, "A12B")).isTrue();

        ArgumentCaptor<File> files = ArgumentCaptor.forClass(File.class);
        verify(hardware, org.mockito.Mockito.times(2)).playAudioFile(files.capture());
        assertThat(files.getAllValues().get(0)).isNotEqualTo(files.getAllValues().get(1));
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
