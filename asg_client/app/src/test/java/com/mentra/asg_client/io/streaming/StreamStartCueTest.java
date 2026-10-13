package com.mentra.asg_client.io.streaming;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.robolectric.Shadows.shadowOf;

import android.os.Handler;
import android.os.Looper;
import com.mentra.asg_client.audio.AudioAssets;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.LooperMode;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
@LooperMode(LooperMode.Mode.PAUSED)
public class StreamStartCueTest {
    @After
    public void resetWorker() {
        StreamStartCue.setWorkerForTest(null);
    }

    @Test
    public void handoffOnMain_schedulesWorkerAndDoesNotStartImmediately() {
        List<Runnable> tasks = new ArrayList<>();
        StreamStartCue.setWorkerForTest(tasks::add);
        IHardwareManager hardware = playbackHardware();
        AtomicBoolean started = new AtomicBoolean();
        Handler handler = new Handler(Looper.getMainLooper());

        StreamStartCue.handoff(handler, hardware, true, () -> true, () -> started.set(true));

        assertThat(tasks).hasSize(1);
        assertThat(started).isFalse();
        verify(hardware, never()).playAudioAssetAndAwait(anyString(), anyLong());

        tasks.get(0).run();
        verify(hardware).playAudioAssetAndAwait(
                eq(AudioAssets.VIDEO_RECORDING_START), anyLong());
        assertThat(started).isFalse();
        shadowOf(Looper.getMainLooper()).idle();
        assertThat(started).isTrue();
    }

    @Test
    public void soundDisabled_startsOnTheLifecycleHandlerWithoutWaiting() {
        IHardwareManager hardware = playbackHardware();
        AtomicBoolean started = new AtomicBoolean();
        StreamStartCue.handoff(
                new Handler(Looper.getMainLooper()),
                hardware,
                false,
                () -> true,
                () -> started.set(true));
        assertThat(started).isTrue();
        verify(hardware, never()).playAudioAssetAndAwait(anyString(), anyLong());
    }

    @Test
    public void playbackUnsupported_startsWithoutWaiting() {
        IHardwareManager hardware = mock(IHardwareManager.class);
        when(hardware.supportsAudioPlayback()).thenReturn(false);
        AtomicBoolean started = new AtomicBoolean();
        StreamStartCue.handoff(
                new Handler(Looper.getMainLooper()),
                hardware,
                true,
                () -> true,
                () -> started.set(true));
        assertThat(started).isTrue();
        verify(hardware, never()).playAudioAssetAndAwait(anyString(), anyLong());
    }

    @Test
    public void soundDisabledOffMain_postsStartStream() throws Exception {
        AtomicBoolean started = new AtomicBoolean();
        Handler handler = new Handler(Looper.getMainLooper());
        Thread caller = new Thread(() ->
                StreamStartCue.handoff(handler, null, false, () -> true, () -> started.set(true)));
        caller.start();
        caller.join(2_000L);
        assertThat(started).isFalse();
        shadowOf(Looper.getMainLooper()).idle();
        assertThat(started).isTrue();
    }

    @Test
    public void staleStart_skipsStartStreamAfterTheCue() {
        List<Runnable> tasks = new ArrayList<>();
        StreamStartCue.setWorkerForTest(tasks::add);
        IHardwareManager hardware = playbackHardware();
        AtomicBoolean stillStarting = new AtomicBoolean(true);
        doAnswer(invocation -> {
                    stillStarting.set(false);
                    return null;
                })
                .when(hardware)
                .playAudioAssetAndAwait(anyString(), anyLong());
        AtomicBoolean started = new AtomicBoolean();

        StreamStartCue.handoff(
                new Handler(Looper.getMainLooper()),
                hardware,
                true,
                stillStarting::get,
                () -> started.set(true));
        tasks.get(0).run();
        shadowOf(Looper.getMainLooper()).idle();
        assertThat(started).isFalse();
    }

    @Test
    public void alreadyStopped_doesNotPlayOrStart() {
        List<Runnable> tasks = new ArrayList<>();
        StreamStartCue.setWorkerForTest(tasks::add);
        IHardwareManager hardware = playbackHardware();
        AtomicBoolean started = new AtomicBoolean();

        StreamStartCue.handoff(
                new Handler(Looper.getMainLooper()),
                hardware,
                true,
                () -> false,
                () -> started.set(true));
        tasks.get(0).run();
        shadowOf(Looper.getMainLooper()).idle();

        verify(hardware, never()).playAudioAssetAndAwait(anyString(), anyLong());
        assertThat(started).isFalse();
    }

    private static IHardwareManager playbackHardware() {
        IHardwareManager hardware = mock(IHardwareManager.class);
        when(hardware.supportsAudioPlayback()).thenReturn(true);
        return hardware;
    }
}
