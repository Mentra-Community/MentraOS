package com.mentra.asg_client.audio;

import android.content.Context;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Build;
import android.util.Log;

import com.mentra.asg_client.service.core.AsgClientService;

import java.io.IOException;
import java.util.HashSet;
import java.util.Set;

/**
 * Handles I2S audio playback for devices that route speaker output through the MCU.
 * This controller opens the I2S path via the MCU, plays an asset, and then closes the path.
 */
public class I2SAudioController {

    private static final String TAG = "I2SAudioController";

    private final Context context;

    private MediaPlayer mediaPlayer;
    private final Set<MediaPlayer> overlayPlayers = new HashSet<>();
    private long playbackGeneration;

    // Track if WE are actively controlling I2S (to prevent receiver feedback loop)
    private static volatile boolean isControllingI2S = false;

    public I2SAudioController(Context context) {
        this.context = context.getApplicationContext();
    }

    public synchronized void playAsset(String assetName) {
        playAssetTracked(assetName);
    }

    /** Play a primary asset and return a token that owns that exact playback. */
    public synchronized long playAssetTracked(String assetName) {
        long playbackToken = ++playbackGeneration;
        playPrimaryAsset(assetName);
        return playbackToken;
    }

    /** Replace the primary asset only if the supplied token still owns it. */
    public synchronized boolean replaceAssetIfCurrent(long playbackToken, String assetName) {
        if (playbackToken <= 0L
                || playbackToken != playbackGeneration
                || mediaPlayer == null) {
            return false;
        }
        playAssetTracked(assetName);
        return true;
    }

    /** Play a short overlay without interrupting the current primary asset. */
    public synchronized void playOverlayAsset(String assetName) {
        Log.i(TAG, "Playing I2S overlay asset: " + assetName);
        isControllingI2S = true;

        if (!notifyI2SState(true)) {
            Log.w(TAG, "Failed to start I2S path; skipping overlay playback");
            refreshControlFlag();
            return;
        }

        MediaPlayer overlayPlayer = null;
        try (AssetFileDescriptor afd = context.getAssets().openFd(assetName)) {
            overlayPlayer = new MediaPlayer();
            configurePlayer(overlayPlayer, afd);

            final MediaPlayer trackedPlayer = overlayPlayer;
            overlayPlayers.add(trackedPlayer);
            trackedPlayer.setOnCompletionListener(
                    mp -> {
                        synchronized (I2SAudioController.this) {
                            if (!overlayPlayers.remove(mp)) {
                                return;
                            }
                            Log.d(TAG, "I2S overlay playback completed");
                            mp.release();
                            closeI2SIfIdle();
                            refreshControlFlag();
                        }
                    });
            trackedPlayer.setOnErrorListener(
                    (mp, what, extra) -> {
                        synchronized (I2SAudioController.this) {
                            if (!overlayPlayers.remove(mp)) {
                                return true;
                            }
                            Log.e(
                                    TAG,
                                    "Overlay MediaPlayer error - what="
                                            + what
                                            + ", extra="
                                            + extra);
                            mp.release();
                            closeI2SIfIdle();
                            refreshControlFlag();
                            return true;
                        }
                    });

            trackedPlayer.prepare();
            trackedPlayer.start();
            Log.d(TAG, "I2S overlay playback started");
        } catch (Exception e) {
            Log.e(TAG, "Unable to play overlay asset " + assetName, e);
            if (overlayPlayer != null) {
                overlayPlayers.remove(overlayPlayer);
                overlayPlayer.release();
            }
            closeI2SIfIdle();
            refreshControlFlag();
        }
    }

    private void playPrimaryAsset(String assetName) {
        Log.i(TAG, "Playing I2S asset: " + assetName);

        // Mark that WE are controlling I2S - prevents receiver from reacting to our broadcasts
        isControllingI2S = true;

        stopCurrentPlayer();

        if (!notifyI2SState(true)) {
            Log.w(TAG, "Failed to start I2S path; skipping playback");
            refreshControlFlag();
            return;
        }

        MediaPlayer nextPlayer = null;
        try (AssetFileDescriptor afd = context.getAssets().openFd(assetName)) {
            nextPlayer = new MediaPlayer();
            configurePlayer(nextPlayer, afd);

            final MediaPlayer trackedPlayer = nextPlayer;
            mediaPlayer = trackedPlayer;
            trackedPlayer.setOnCompletionListener(
                    mp -> {
                        synchronized (I2SAudioController.this) {
                            if (mediaPlayer != mp) {
                                return;
                            }
                            Log.d(TAG, "I2S audio playback completed");
                            mediaPlayer = null;
                            mp.release();
                            closeI2SIfIdle();
                            refreshControlFlag();
                        }
                    });
            trackedPlayer.setOnErrorListener(
                    (mp, what, extra) -> {
                        synchronized (I2SAudioController.this) {
                            if (mediaPlayer != mp) {
                                return true;
                            }
                            Log.e(
                                    TAG,
                                    "MediaPlayer error - what=" + what + ", extra=" + extra);
                            mediaPlayer = null;
                            mp.release();
                            closeI2SIfIdle();
                            refreshControlFlag();
                            return true;
                        }
                    });

            trackedPlayer.prepare();
            trackedPlayer.start();
            Log.d(TAG, "I2S audio playback started");
        } catch (Exception e) {
            Log.e(TAG, "Unable to play asset " + assetName, e);
            if (nextPlayer != null) {
                if (mediaPlayer == nextPlayer) {
                    mediaPlayer = null;
                }
                nextPlayer.release();
            }
            closeI2SIfIdle();
            refreshControlFlag();
        }
    }

    public synchronized void stopPlayback() {
        ++playbackGeneration;
        isControllingI2S = true;
        stopCurrentPlayer();
        stopOverlayPlayers();
        closeI2SIfIdle();
        refreshControlFlag();
    }

    /** Stop the primary asset only if the supplied token still owns it. */
    public synchronized boolean stopPlaybackIfCurrent(long playbackToken) {
        if (playbackToken <= 0L
                || playbackToken != playbackGeneration
                || mediaPlayer == null) {
            return false;
        }
        ++playbackGeneration;
        isControllingI2S = true;
        stopCurrentPlayer();
        refreshControlFlag();
        return true;
    }

    /**
     * Check if this controller is actively managing I2S state.
     * Used by I2SAudioBroadcastReceiver to avoid reacting to our own playback.
     */
    public static boolean isControllingI2S() {
        return isControllingI2S;
    }

    private void stopCurrentPlayer() {
        if (mediaPlayer != null) {
            MediaPlayer playerToStop = mediaPlayer;
            mediaPlayer = null;
            try {
                if (playerToStop.isPlaying()) {
                    playerToStop.stop();
                }
            } catch (IllegalStateException ignore) {
                // best-effort
            }
            playerToStop.release();
            closeI2SIfIdle();
        }
    }

    private void stopOverlayPlayers() {
        for (MediaPlayer overlayPlayer : new HashSet<>(overlayPlayers)) {
            overlayPlayers.remove(overlayPlayer);
            try {
                if (overlayPlayer.isPlaying()) {
                    overlayPlayer.stop();
                }
            } catch (IllegalStateException ignore) {
                // best-effort
            }
            overlayPlayer.release();
        }
    }

    private void configurePlayer(MediaPlayer player, AssetFileDescriptor afd) throws IOException {
        // STREAM_NOTIFICATION routes through system sounds which work with I2S.
        player.setAudioStreamType(AudioManager.STREAM_NOTIFICATION);
        player.setVolume(0.1f, 0.1f);
        player.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
    }

    private void closeI2SIfIdle() {
        if (mediaPlayer == null && overlayPlayers.isEmpty()) {
            notifyI2SState(false);
        }
    }

    private void refreshControlFlag() {
        isControllingI2S = mediaPlayer != null || !overlayPlayers.isEmpty();
    }

    private boolean notifyI2SState(boolean playing) {
        AsgClientService service = AsgClientService.getInstance();
        if (service != null) {
            service.handleI2SAudioState(playing);
            return true;
        }

        Intent intent = new Intent(context, AsgClientService.class);
        intent.setAction(AsgClientService.ACTION_I2S_AUDIO_STATE);
        intent.putExtra(AsgClientService.EXTRA_I2S_AUDIO_PLAYING, playing);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Failed to deliver I2S state intent", e);
            return false;
        }
    }
}
