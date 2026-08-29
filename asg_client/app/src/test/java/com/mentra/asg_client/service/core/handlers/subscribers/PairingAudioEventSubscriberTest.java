package com.mentra.asg_client.service.core.handlers.subscribers;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.app.Application;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.audio.AudioAssets;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.peripheral.events.PairingModeExitEvent;
import com.mentra.asg_client.io.peripheral.events.ShutdownEvent;
import com.mentra.asg_client.io.peripheral.events.SpeakPairingCodeEvent;
import com.mentra.asg_client.utils.WakeLockManager;
import com.mentra.asg_client.utils.WakeLockManager.WakeOwner;
import java.io.File;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.ArgumentCaptor;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class PairingAudioEventSubscriberTest {

    private IHardwareManager hardware;
    private PairingAudioEventSubscriber subscriber;

    @Before
    public void setUp() {
        hardware = mock(IHardwareManager.class);
        subscriber =
                new PairingAudioEventSubscriber(
                        ApplicationProvider.getApplicationContext(), hardware);
        WakeLockManager.release(WakeOwner.PAIRING_CODE);
    }

    @After
    public void tearDown() {
        WakeLockManager.release(WakeOwner.PAIRING_CODE);
    }

    @Test
    public void nonSpeakEvent_isIgnored() {
        subscriber.onMcuEvent(new ShutdownEvent());
        verify(hardware, never()).playAudioFile(any());
    }

    @Test
    public void speakEvent_a12b_playsStitchedFile() {
        when(hardware.supportsAudioPlayback()).thenReturn(true);
        when(hardware.playAudioFile(any(File.class))).thenReturn(true);

        subscriber.onMcuEvent(new SpeakPairingCodeEvent("A12B"));

        ArgumentCaptor<File> file = ArgumentCaptor.forClass(File.class);
        verify(hardware).playAudioFile(file.capture());
        assertThat(file.getValue().getName()).startsWith("pairing_code_");
        assertThat(file.getValue().getName()).endsWith(".wav");
        assertThat(file.getValue()).exists();
    }

    @Test
    public void pairingExitEvent_playsEndedMessage() {
        when(hardware.supportsAudioPlayback()).thenReturn(true);

        subscriber.onMcuEvent(new PairingModeExitEvent("idle_timeout"));

        verify(hardware).playAudioAsset(AudioAssets.PAIRING_EXITED);
    }
}
