package com.mentra.asg_client.audio;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.Assert.assertThrows;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.content.res.AssetManager;
import android.media.AudioTrack;
import android.media.MediaPlayer;
import android.os.Handler;
import android.os.Looper;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.service.core.AsgClientService;
import java.io.ByteArrayInputStream;
import java.io.FileDescriptor;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mockito.ArgumentCaptor;
import org.mockito.MockedConstruction;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class CameraCuePlayerTest {
    private I2SAudioController controller;

    @After public void cleanup() {
        if (controller != null) controller.stopPlayback();
        I2SAudioController.setExternalAudioPlaying(false);
        I2sReadyGate.invalidateLink();
        shadowOf(Looper.getMainLooper()).idle();
        intents();
    }

    private byte[] wav() {
        ByteBuffer b = ByteBuffer.allocate(44 + 480 * 4).order(ByteOrder.LITTLE_ENDIAN);
        b.putInt(0x46464952).putInt(b.capacity()-8).putInt(0x45564157);
        b.putInt(0x20746d66).putInt(16).putShort((short)1).putShort((short)2);
        b.putInt(48000).putInt(192000).putShort((short)4).putShort((short)16);
        b.putInt(0x61746164).putInt(480*4);
        while(b.hasRemaining()) b.putShort((short)321);
        return b.array();
    }

    private Context context() throws Exception {
        Application app = ApplicationProvider.getApplicationContext();
        AssetManager assets = mock(AssetManager.class);
        when(assets.open(anyString())).thenAnswer(call -> new ByteArrayInputStream(wav()));
        AssetFileDescriptor afd = mock(AssetFileDescriptor.class);
        when(afd.getFileDescriptor()).thenReturn(new FileDescriptor());
        when(assets.openFd(anyString())).thenReturn(afd);
        return new ContextWrapper(app) {
            @Override public Context getApplicationContext() { return this; }
            @Override public AssetManager getAssets() { return assets; }
        };
    }

    private MockedConstruction<AudioTrack> tracks() {
        return mockConstruction(AudioTrack.class, (track, ignored) -> {
            when(track.getState()).thenReturn(AudioTrack.STATE_INITIALIZED);
            when(track.write(any(byte[].class), anyInt(), anyInt())).thenAnswer(call -> call.getArgument(2));
        });
    }

    private List<Intent> intents() {
        Application app = ApplicationProvider.getApplicationContext();
        List<Intent> result = new ArrayList<>();
        Intent intent;
        while ((intent = shadowOf(app).getNextStartedService()) != null) result.add(intent);
        return result;
    }

    private void ready() {
        int id = intents().get(0).getIntExtra(AsgConstants.EXTRA_I2S_REQUEST_ID, 0);
        assertThat(id).isNotZero();
        I2sReadyGate.onResponse(id, true);
        shadowOf(Looper.getMainLooper()).idle();
    }

    @Test public void preloadsSilencePaddedPeriodAndReusesTrackWithoutMediaPlayer() throws Exception {
        try (MockedConstruction<AudioTrack> tracks = tracks();
                MockedConstruction<MediaPlayer> media = mockConstruction(MediaPlayer.class)) {
            CameraCuePlayer.Pool pool = new CameraCuePlayer.Pool(context(), new Handler(Looper.getMainLooper()));
            assertThat(tracks.constructed()).hasSize(2);
            AudioTrack prep = tracks.constructed().get(0);
            ArgumentCaptor<byte[]> pcm = ArgumentCaptor.forClass(byte[].class);
            verify(prep).write(pcm.capture(), eq(0), eq(172800));
            assertThat(pcm.getValue()[1920]).isZero();
            CameraCuePlayer first = new CameraCuePlayer(pool, AudioAssets.CAMERA_PREP_CLICK, .09f);
            first.prepare();first.start();
            verify(prep).setLoopPoints(0, 43200, 49);
            verify(prep).setVolume(.09f);
            first.release();
            CameraCuePlayer second = new CameraCuePlayer(pool, AudioAssets.CAMERA_PREP_CLICK, .09f);
            second.prepare();second.start();second.release();
            verify(prep, times(2)).play();
            assertThat(tracks.constructed()).hasSize(2);
            assertThat(media.constructed()).isEmpty();
            pool.clear();verify(prep).release();
        }
    }

    @Test public void staticFailureFallsBackAndBusyTrackDoesNotStealPlayback() throws Exception {
        try (MockedConstruction<AudioTrack> tracks = tracks();
                MockedConstruction<MediaPlayer> media = mockConstruction(MediaPlayer.class)) {
            CameraCuePlayer.Pool pool = new CameraCuePlayer.Pool(context(), new Handler(Looper.getMainLooper()));
            CameraCuePlayer first = new CameraCuePlayer(pool, AudioAssets.CAMERA_SNAP, .3f);
            first.prepare();first.start();
            CameraCuePlayer overlapping = new CameraCuePlayer(pool, AudioAssets.CAMERA_SNAP, .3f);
            overlapping.prepare();overlapping.start();
            assertThat(media.constructed()).hasSize(1);
            verify(tracks.constructed().get(1), never()).stop();
            overlapping.release();first.release();
            doThrow(new IllegalStateException("dead track")).when(tracks.constructed().get(1)).play();
            CameraCuePlayer failed = new CameraCuePlayer(pool, AudioAssets.CAMERA_SNAP, .3f);
            failed.prepare();failed.start();
            assertThat(media.constructed()).hasSize(2);
            verify(media.constructed().get(1)).start();
            verify(tracks.constructed().get(1)).release();
            failed.release();pool.clear();
        }
    }

    @Test public void cancelledStaticCueCannotStartOnLateReady() throws Exception {
        I2sReadyGate.setSupported(true);
        try (MockedConstruction<AudioTrack> tracks = tracks()) {
            controller = new I2SAudioController(context());
            long token = controller.playOverlayAssetTracked(AudioAssets.CAMERA_SNAP, .3f);
            controller.stopOverlayPlayback(token);
            ready();
            verify(tracks.constructed().get(1), never()).play();
            controller.stopPlayback();
        }
    }

    @Test public void staticPrepStopsInSilenceThenStartsSnapAndPreservesExternalMusic() throws Exception {
        I2sReadyGate.setSupported(true);
        try (MockedConstruction<AudioTrack> tracks = tracks()) {
            controller = new I2SAudioController(context());
            long prep = controller.playOverlayAssetTracked(AudioAssets.CAMERA_PREP_CLICK, .09f);
            ready();
            AudioTrack beep = tracks.constructed().get(0);
            when(beep.getPlaybackHeadPosition()).thenReturn(4800, 14400);
            controller.stopOverlayPlayback(prep);
            controller.playOverlayAssetTracked(AudioAssets.CAMERA_SNAP, .3f);
            verify(tracks.constructed().get(1), never()).play();
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(140));
            verify(beep).stop();verify(tracks.constructed().get(1)).play();
            I2SAudioController.setExternalAudioPlaying(true);
            controller.stopPlayback();
            assertThat(intents()).noneMatch(i -> !i.getBooleanExtra(AsgClientService.EXTRA_I2S_AUDIO_PLAYING, true));
        }
    }

    @Test public void completionClosesIdleBridgeAndStaleMarkerCannotCompleteReusedTrack() throws Exception {
        I2sReadyGate.setSupported(true);
        try (MockedConstruction<AudioTrack> tracks = tracks()) {
            controller = new I2SAudioController(context());
            controller.playOverlayAssetTracked(AudioAssets.CAMERA_SNAP, .3f);
            ready();
            AudioTrack snap = tracks.constructed().get(1);
            ArgumentCaptor<AudioTrack.OnPlaybackPositionUpdateListener> listener = ArgumentCaptor.forClass(AudioTrack.OnPlaybackPositionUpdateListener.class);
            verify(snap).setPlaybackPositionUpdateListener(listener.capture(), any(Handler.class));
            when(snap.getPlaybackHeadPosition()).thenReturn(480);
            listener.getValue().onMarkerReached(snap);
            when(snap.getPlaybackHeadPosition()).thenReturn(0);
            long second = controller.playOverlayAssetTracked(AudioAssets.CAMERA_SNAP, .3f);
            shadowOf(Looper.getMainLooper()).idle();
            listener.getValue().onMarkerReached(snap);
            verify(snap, times(2)).setPlaybackPositionUpdateListener(listener.capture(), any(Handler.class));
            listener.getValue().onMarkerReached(snap);
            assertThat(controller.stopOverlayPlayback(second)).isTrue();
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(AsgConstants.I2S_IDLE_CLOSE_MS));
            assertThat(intents()).anyMatch(i -> !i.getBooleanExtra(AsgClientService.EXTRA_I2S_AUDIO_PLAYING, true));
            controller.stopPlayback();
        }
    }

    @Test public void failedStaticLoadReleasesTrackAndFallsBack() throws Exception {
        try (MockedConstruction<AudioTrack> tracks = mockConstruction(AudioTrack.class, (track, ignored) -> {
                    when(track.getState()).thenReturn(AudioTrack.STATE_INITIALIZED);
                    when(track.write(any(byte[].class), anyInt(), anyInt())).thenReturn(AudioTrack.ERROR);
                }); MockedConstruction<MediaPlayer> media = mockConstruction(MediaPlayer.class)) {
            CameraCuePlayer.Pool pool = new CameraCuePlayer.Pool(context(), new Handler(Looper.getMainLooper()));
            for (AudioTrack track : tracks.constructed()) verify(track).release();
            CameraCuePlayer cue = new CameraCuePlayer(pool, AudioAssets.CAMERA_SNAP, .3f);
            cue.prepare();cue.start();
            assertThat(media.constructed()).hasSize(1);
            verify(media.constructed().get(0)).start();
            cue.release();pool.clear();
        }
    }

    @Test public void malformedOrWrongFormatPcmIsRejected() throws Exception {
        byte[] good = wav();
        assertThat(CameraCuePlayer.decodeStereoPcm(good)).hasSize(1920);
        assertThrows(IOException.class, () -> CameraCuePlayer.decodeStereoPcm(new byte[8]));
        good[22]=1;
        assertThrows(IOException.class, () -> CameraCuePlayer.decodeStereoPcm(good));
        byte[] truncated = wav();truncated[40]=(byte)0xff;truncated[41]=(byte)0xff;
        assertThrows(IOException.class, () -> CameraCuePlayer.decodeStereoPcm(truncated));
    }
}
