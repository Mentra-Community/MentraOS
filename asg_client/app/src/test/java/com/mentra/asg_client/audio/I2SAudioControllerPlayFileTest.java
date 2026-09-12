package com.mentra.asg_client.audio;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mockConstruction;
import static org.mockito.Mockito.mock;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.content.Intent;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.res.AssetManager;
import android.content.res.AssetFileDescriptor;
import android.media.MediaPlayer;
import android.media.AudioManager;
import android.os.Looper;
import androidx.test.core.app.ApplicationProvider;
import com.mentra.asg_client.service.core.AsgClientService;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.List;
import java.time.Duration;
import org.mockito.MockedConstruction;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowApplication;

/**
 * {@link I2SAudioController#playFile} opens I2S via a service intent when AsgClientService is
 * not running. A leaked path would leave {@code EXTRA_I2S_AUDIO_PLAYING=true} with no close.
 */
@RunWith(RobolectricTestRunner.class)
@Config(application = Application.class, sdk = 33)
public class I2SAudioControllerPlayFileTest {

    private Application app;
    private I2SAudioController controller;
    private ShadowApplication shadowApp;

    @Before
    public void setUp() {
        app = ApplicationProvider.getApplicationContext();
        controller = new I2SAudioController(app);
        shadowApp = shadowOf(app);
        // Both bridge-ownership flags are static, so clear them between tests.
        I2SAudioController.setExternalAudioPlaying(false);
        controller.stopPlayback();
        drainStartedServices();
    }

    @After
    public void tearDown() {
        controller.stopPlayback();
        I2SAudioController.setExternalAudioPlaying(false);
        drainStartedServices();
    }

    @Test
    public void playFile_null_doesNotOpenI2s() {
        controller.playFile(null, 0.1f);
        assertThat(drainStartedServices()).isEmpty();
    }

    @Test
    public void playFile_missingFile_stillClosesI2s() {
        controller.playFile(new File(app.getCacheDir(), "missing-pairing.wav"), 0.1f);

        List<Boolean> playing = playingFlags(drainStartedServices());
        assertThat(playing).containsExactly(true, false);
    }

    @Test
    public void playFile_startIntent_requestsForceRestart() throws Exception {
        File wav = writeToneWav();
        controller.playFile(wav, 0.1f);

        List<Intent> i2sIntents = new ArrayList<>();
        for (Intent intent : drainStartedServices()) {
            if (AsgClientService.ACTION_I2S_AUDIO_STATE.equals(intent.getAction())) {
                i2sIntents.add(intent);
            }
        }
        assertThat(i2sIntents).isNotEmpty();
        Intent first = i2sIntents.get(0);
        assertThat(first.getBooleanExtra(AsgClientService.EXTRA_I2S_AUDIO_PLAYING, false))
                .isTrue();
        assertThat(first.getBooleanExtra(AsgClientService.EXTRA_I2S_FORCE_RESTART, false))
                .isTrue();
        controller.stopPlayback();
        drainStartedServices();
    }

    @Test
    public void playFile_validWav_opensI2s() throws Exception {
        File wav = writeToneWav();
        controller.playFile(wav, 0.1f);

        List<Boolean> playing = playingFlags(drainStartedServices());
        assertThat(playing).isNotEmpty();
        assertThat(playing.get(0)).isTrue();
        controller.stopPlayback();
        List<Boolean> afterStop = playingFlags(drainStartedServices());
        assertThat(afterStop).contains(false);
    }

    @Test
    public void prepStop_usesSilenceAndRechecksLateCallbackBeforeStartingSnap() throws Exception {
        useMockAssetSource();
        try (MockedConstruction<MediaPlayer> players = mockConstruction(MediaPlayer.class)) {
            long prep = controller.playOverlayAssetTracked(AudioAssets.CAMERA_PREP_CLICK, 0.1f);
            MediaPlayer beep = players.constructed().get(0);
            when(beep.getCurrentPosition()).thenReturn(100, 1000, 1200);
            controller.stopOverlayPlayback(prep);
            controller.playOverlayAssetTracked(AudioAssets.CAMERA_SNAP, 0.1f);
            MediaPlayer snap = players.constructed().get(1);
            verify(beep, never()).release();
            verify(snap, never()).start();

            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(140));
            verify(beep, never()).release();
            verify(snap, never()).start();
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(140));
            verify(beep).release();
            verify(snap).start();
            controller.stopPlayback();
        }
    }

    @Test
    public void cancelledQueuedSnap_doesNotPlayWhenBeepFinishes() throws Exception {
        useMockAssetSource();
        try (MockedConstruction<MediaPlayer> players = mockConstruction(MediaPlayer.class)) {
            long prep = controller.playOverlayAssetTracked(AudioAssets.CAMERA_PREP_CLICK, 0.1f);
            MediaPlayer beep = players.constructed().get(0);
            when(beep.getCurrentPosition()).thenReturn(100, 300);
            controller.stopOverlayPlayback(prep);
            long snapToken = controller.playOverlayAssetTracked(AudioAssets.CAMERA_SNAP, 0.1f);
            MediaPlayer snap = players.constructed().get(1);
            controller.stopOverlayPlayback(snapToken);
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(140));
            verify(snap, never()).start();
            controller.stopPlayback();
        }
    }

    /**
     * A song streaming through the MCU bridge is not ours to restart or close. Before this, every
     * shutter sent {@code mh_starti2s} and then {@code mh_stopi2s} underneath the music, so a
     * burst of photos cut the track out and back in once per shot.
     */
    @Test
    public void snapDuringExternalAudio_leavesTheBridgeAlone() throws Exception {
        controller = controllerWithStubAssets();
        I2SAudioController.setExternalAudioPlaying(true);
        try (MockedConstruction<MediaPlayer> players = mockConstruction(MediaPlayer.class)) {
            long snap = controller.playOverlayAssetTracked(AudioAssets.CAMERA_SNAP, 0.1f);

            assertThat(snap).isGreaterThan(0L);
            verify(players.constructed().get(0)).start();
            assertThat(playingFlags(drainStartedServices())).isEmpty();

            controller.stopOverlayPlayback(snap);
            assertThat(playingFlags(drainStartedServices())).isEmpty();
        }
    }

    /** With nothing else on the bridge, the snap still owns opening and closing it. */
    @Test
    public void snapWithoutExternalAudio_opensAndClosesTheBridge() throws Exception {
        controller = controllerWithStubAssets();
        try (MockedConstruction<MediaPlayer> players = mockConstruction(MediaPlayer.class)) {
            long snap = controller.playOverlayAssetTracked(AudioAssets.CAMERA_SNAP, 0.1f);
            assertThat(playingFlags(drainStartedServices())).containsExactly(true);

            controller.stopOverlayPlayback(snap);
            assertThat(playingFlags(drainStartedServices())).containsExactly(false);
        }
    }

    @Test
    public void firmwareBroadcastOutsideOurPlayback_holdsTheBridgeForTheSong() {
        new I2SAudioBroadcastReceiver().onReceive(app, playStateIntent("start"));
        assertThat(I2SAudioController.isExternalAudioPlaying()).isTrue();

        new I2SAudioBroadcastReceiver().onReceive(app, playStateIntent("stop"));
        assertThat(I2SAudioController.isExternalAudioPlaying()).isFalse();
    }

    /**
     * Our own MediaPlayer also makes the firmware announce playback. Recording that as external
     * would pin the flag true and leave the bridge open with nothing left to close it.
     */
    @Test
    public void firmwareBroadcastDuringOurPlayback_isNotRecordedAsExternal() throws Exception {
        controller = controllerWithStubAssets();
        try (MockedConstruction<MediaPlayer> players = mockConstruction(MediaPlayer.class)) {
            long snap = controller.playOverlayAssetTracked(AudioAssets.CAMERA_SNAP, 0.1f);
            drainStartedServices();

            new I2SAudioBroadcastReceiver().onReceive(app, playStateIntent("start"));
            assertThat(I2SAudioController.isExternalAudioPlaying()).isFalse();

            controller.stopOverlayPlayback(snap);
            assertThat(playingFlags(drainStartedServices())).containsExactly(false);
        }
    }

    @Test
    public void externalMusicEndingDuringCue_releasesBridgeAfterCueAndReopensNextCue() throws Exception {
        controller = controllerWithStubAssets();
        I2SAudioController.setExternalAudioPlaying(true);
        try (MockedConstruction<MediaPlayer> players = mockConstruction(MediaPlayer.class)) {
            long snap = controller.playOverlayAssetTracked(AudioAssets.CAMERA_SNAP, 0.1f);
            drainStartedServices();
            receiveDuringMusic("stop", false);
            assertThat(I2SAudioController.isExternalAudioPlaying()).isFalse();
            assertThat(drainStartedServices()).isEmpty(); // Never cut off the cue itself.
            controller.stopOverlayPlayback(snap);
            assertThat(playingFlags(drainStartedServices())).containsExactly(false);
            controller.playOverlayAssetTracked(AudioAssets.CAMERA_SNAP, 0.1f);
            assertThat(playingFlags(drainStartedServices())).containsExactly(true);
        }
    }

    @Test
    public void cueStopBroadcast_doesNotReleaseMusicThatIsStillPlaying() throws Exception {
        controller = controllerWithStubAssets();
        I2SAudioController.setExternalAudioPlaying(true);
        try (MockedConstruction<MediaPlayer> players = mockConstruction(MediaPlayer.class)) {
            long snap = controller.playOverlayAssetTracked(AudioAssets.CAMERA_SNAP, 0.1f);
            drainStartedServices();
            receiveDuringMusic("stop", true);
            controller.stopOverlayPlayback(snap);
            assertThat(I2SAudioController.isExternalAudioPlaying()).isTrue();
            assertThat(drainStartedServices()).isEmpty();
        }
    }

    @Test
    public void musicStartingDuringCue_keepsBridgeOpenWhenCueEnds() throws Exception {
        controller = controllerWithStubAssets();
        try (MockedConstruction<MediaPlayer> players = mockConstruction(MediaPlayer.class)) {
            long snap = controller.playOverlayAssetTracked(AudioAssets.CAMERA_SNAP, 0.1f);
            drainStartedServices();
            receiveDuringMusic("start", true);
            controller.stopOverlayPlayback(snap);
            assertThat(I2SAudioController.isExternalAudioPlaying()).isTrue();
            assertThat(drainStartedServices()).isEmpty();
        }
    }

    private void receiveDuringMusic(String state, boolean playing) {
        AudioManager audio = mock(AudioManager.class);
        when(audio.isMusicActive()).thenReturn(playing);
        Context context = new ContextWrapper(app) {
            @Override public Object getSystemService(String name) {
                return Context.AUDIO_SERVICE.equals(name) ? audio : super.getSystemService(name);
            }
        };
        new I2SAudioBroadcastReceiver().onReceive(context, playStateIntent(state));
    }

    private static Intent playStateIntent(String state) {
        Intent intent = new Intent(I2SAudioBroadcastReceiver.ACTION_PLAYSTATE_CHANGE);
        intent.putExtra("state", state);
        return intent;
    }

    @Test
    public void prepStop_delayTargetsSafeSilentWindow() {
        assertThat(I2SAudioController.prepStopDelayMs(100)).isEqualTo(140);
        assertThat(I2SAudioController.prepStopDelayMs(240)).isZero();
        assertThat(I2SAudioController.prepStopDelayMs(700)).isZero();
        assertThat(I2SAudioController.prepStopDelayMs(899)).isEqualTo(241);
        assertThat(I2SAudioController.prepStopDelayMs(1000)).isEqualTo(140);
    }

    /**
     * Robolectric cannot {@code openFd} the packaged cue assets, so stub the asset source while
     * keeping the real application context — started services still land in the shadow, which is
     * how these tests observe the I2S open/close commands.
     */
    private I2SAudioController controllerWithStubAssets() throws Exception {
        AssetManager assets = mock(AssetManager.class);
        AssetFileDescriptor descriptor = mock(AssetFileDescriptor.class);
        when(assets.openFd(anyString())).thenReturn(descriptor);
        when(descriptor.getFileDescriptor()).thenReturn(new FileDescriptor());
        Context context =
                new ContextWrapper(app) {
                    @Override
                    public Context getApplicationContext() {
                        return this;
                    }

                    @Override
                    public AssetManager getAssets() {
                        return assets;
                    }
                };
        return new I2SAudioController(context);
    }

    private void useMockAssetSource() throws Exception {
        // Exercise handoff logic independently of Robolectric's packaged FLAC handling.
        Context context = mock(Context.class);
        AssetManager assets = mock(AssetManager.class);
        AssetFileDescriptor descriptor = mock(AssetFileDescriptor.class);
        when(context.getApplicationContext()).thenReturn(context);
        when(context.getAssets()).thenReturn(assets);
        when(assets.openFd(anyString())).thenReturn(descriptor);
        when(descriptor.getFileDescriptor()).thenReturn(new FileDescriptor());
        controller = new I2SAudioController(context);
    }

    private File writeToneWav() throws Exception {
        short[] samples = new short[4410];
        for (int i = 0; i < samples.length; i++) {
            samples[i] = (short) ((i % 20) * 100);
        }
        byte[] wav = PairingCodePcmStitcher.encodePcmWav(samples, 44100);
        File out = new File(app.getCacheDir(), "i2s-tone.wav");
        try (FileOutputStream fos = new FileOutputStream(out)) {
            fos.write(wav);
        }
        return out;
    }

    private List<Intent> drainStartedServices() {
        List<Intent> intents = new ArrayList<>();
        Intent next;
        while ((next = shadowApp.getNextStartedService()) != null) {
            intents.add(next);
        }
        return intents;
    }

    private static List<Boolean> playingFlags(List<Intent> intents) {
        List<Boolean> flags = new ArrayList<>();
        for (Intent intent : intents) {
            if (AsgClientService.ACTION_I2S_AUDIO_STATE.equals(intent.getAction())) {
                flags.add(intent.getBooleanExtra(AsgClientService.EXTRA_I2S_AUDIO_PLAYING, false));
            }
        }
        return flags;
    }
}
