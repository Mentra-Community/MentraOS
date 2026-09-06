package com.mentra.asg_client.audio;

import android.content.Context;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.SystemClock;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.mentra.asg_client.service.core.AsgClientService;
import com.mentra.asg_client.AsgConstants;

import java.io.File;
import java.io.IOException;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Handles I2S audio playback for devices that route speaker output through the MCU. This controller
 * opens the I2S path via the MCU, plays an asset, and then closes the path.
 */
public class I2SAudioController {

    private static final String TAG = "I2SAudioController";

    /**
     * BES {@code app_play_I2S_onoff(true)} force-closes I2S, waits 20 ms, then reopens and arms
     * the PA. UART transit is extra. Starting MediaPlayer before that window dumps PCM into a
     * dead bridge — silent attack, then a pop that reads as clipping.
     */
    static final long I2S_START_SETTLE_MS = 60L;

    private final Context context;

    private MediaPlayer mediaPlayer;
    private final Map<Long, MediaPlayer> overlayPlayers = new HashMap<>();
    private final Handler cameraAudioHandler = new Handler(Looper.getMainLooper());
    private final Set<Long> prepOverlays = new HashSet<>();
    private final Set<Long> stoppingPrepOverlays = new HashSet<>();
    private final Set<Long> snapOverlays = new HashSet<>();
    private final Map<Long, Runnable> waitingCameraStarts = new HashMap<>();
    private long playbackGeneration;
    private long overlayPlaybackGeneration;

    // Track if WE are actively controlling I2S (to prevent receiver feedback loop)
    private static volatile boolean isControllingI2S = false;

    public I2SAudioController(Context context) {
        this.context = context.getApplicationContext();
    }

    public synchronized void playAsset(String assetName, float playbackVolume) {
        playAssetTracked(assetName, playbackVolume);
    }

    /** Play a primary asset and return a token that owns that exact playback. */
    public synchronized long playAssetTracked(String assetName, float playbackVolume) {
        long playbackToken = ++playbackGeneration;
        playPrimaryAsset(assetName, playbackVolume);
        return playbackToken;
    }

    /** Replace the primary asset only if the supplied token still owns it. */
    public synchronized boolean replaceAssetIfCurrent(
            long playbackToken, String assetName, float playbackVolume) {
        if (playbackToken <= 0L || playbackToken != playbackGeneration || mediaPlayer == null) {
            return false;
        }
        playAssetTracked(assetName, playbackVolume);
        return true;
    }

    /** Play a short overlay without interrupting the current primary asset. */
    public synchronized void playOverlayAsset(String assetName, float playbackVolume) {
        playOverlayAssetTracked(assetName, playbackVolume);
    }

    /** Play an independently stoppable overlay without interrupting primary audio. */
    public synchronized long playOverlayAssetTracked(String assetName, float playbackVolume) {
        Log.i(TAG, "Playing I2S overlay asset: " + assetName);
        isControllingI2S = true;

        long i2sRequestedAtMs = SystemClock.elapsedRealtime();
        // Do not restart the bridge underneath a loading beep that is still finishing.
        if (overlayPlayers.isEmpty() && mediaPlayer == null && !notifyI2SState(true, true)) {
            Log.w(TAG, "Failed to start I2S path; skipping overlay playback");
            refreshControlFlag();
            return 0L;
        }

        MediaPlayer overlayPlayer = null;
        long overlayToken = ++overlayPlaybackGeneration;
        try (AssetFileDescriptor afd = context.getAssets().openFd(assetName)) {
            overlayPlayer = new MediaPlayer();
            configurePlayer(overlayPlayer, playbackVolume);
            overlayPlayer.setDataSource(
                    afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());

            final MediaPlayer trackedPlayer = overlayPlayer;
            overlayPlayers.put(overlayToken, trackedPlayer);
            trackedPlayer.setOnCompletionListener(
                    mp -> {
                        synchronized (I2SAudioController.this) {
                            if (!overlayPlayers.remove(overlayToken, mp)) {
                                return;
                            }
                            Log.d(TAG, "I2S overlay playback completed");
                            mp.release();
                            finishCameraOverlay(overlayToken);
                            closeI2SIfIdle();
                            refreshControlFlag();
                        }
                    });
            trackedPlayer.setOnErrorListener(
                    (mp, what, extra) -> {
                        synchronized (I2SAudioController.this) {
                            if (!overlayPlayers.remove(overlayToken, mp)) {
                                return true;
                            }
                            Log.e(
                                    TAG,
                                    "Overlay MediaPlayer error - what="
                                            + what
                                            + ", extra="
                                            + extra);
                            mp.release();
                            finishCameraOverlay(overlayToken);
                            closeI2SIfIdle();
                            refreshControlFlag();
                            return true;
                        }
                    });

            trackedPlayer.prepare();
            boolean prep = AudioAssets.CAMERA_PREP_CLICK.equals(assetName);
            if (AudioAssets.CAMERA_SNAP.equals(assetName)) {
                snapOverlays.add(overlayToken);
            }
            if (prep && !snapOverlays.isEmpty()) {
                overlayPlayers.remove(overlayToken);
                trackedPlayer.release();
                return 0L;
            }
            if ((prep || AudioAssets.CAMERA_SNAP.equals(assetName))
                    && !stoppingPrepOverlays.isEmpty()) {
                waitingCameraStarts.put(overlayToken,
                        () -> startCameraOverlay(overlayToken, trackedPlayer, prep, i2sRequestedAtMs));
            } else {
                startPlayerAfterI2sSettle(trackedPlayer, i2sRequestedAtMs);
                if (prep) {
                    prepOverlays.add(overlayToken);
                }
            }
            Log.d(TAG, "I2S overlay playback started");
            return overlayToken;
        } catch (Exception e) {
            Log.e(TAG, "Unable to play overlay asset " + assetName, e);
            if (overlayPlayer != null) {
                overlayPlayers.remove(overlayToken, overlayPlayer);
                overlayPlayer.release();
                finishCameraOverlay(overlayToken);
            }
            closeI2SIfIdle();
            refreshControlFlag();
            return 0L;
        }
    }

    /** Stop one overlay only when its token still identifies an active player. */
    public synchronized boolean stopOverlayPlayback(long overlayToken) {
        MediaPlayer overlayPlayer = overlayPlayers.get(overlayToken);
        if (overlayPlayer == null) {
            return false;
        }
        if (stoppingPrepOverlays.contains(overlayToken)) {
            return true;
        }
        if (prepOverlays.contains(overlayToken)) {
            long delayMs = prepStopDelayMs(overlayPlayer.getCurrentPosition());
            if (delayMs > 0L) {
                stoppingPrepOverlays.add(overlayToken);
                cameraAudioHandler.postDelayed(() -> {
                    synchronized (I2SAudioController.this) {
                        stoppingPrepOverlays.remove(overlayToken);
                        // Re-read playback position: a late callback may land in the next beep.
                        stopOverlayPlayback(overlayToken);
                    }
                }, delayMs);
                return true;
            }
        }
        overlayPlayers.remove(overlayToken);
        isControllingI2S = true;
        stopAndRelease(overlayPlayer);
        finishCameraOverlay(overlayToken);
        closeI2SIfIdle();
        refreshControlFlag();
        return true;
    }

    static long prepStopDelayMs(long positionMs) {
        long phase = positionMs % AsgConstants.CAMERA_PREP_CLICK_INTERVAL_MS;
        if (phase < AsgConstants.CAMERA_PREP_STOP_AFTER_MS) {
            return AsgConstants.CAMERA_PREP_STOP_AFTER_MS - phase;
        }
        return phase < AsgConstants.CAMERA_PREP_STOP_BEFORE_MS ? 0L
                : AsgConstants.CAMERA_PREP_CLICK_INTERVAL_MS - phase
                        + AsgConstants.CAMERA_PREP_STOP_AFTER_MS;
    }

    private void startCameraOverlay(
            long token, MediaPlayer player, boolean prep, long i2sRequestedAtMs) {
        if (overlayPlayers.get(token) != player) {
            return;
        }
        if (prep && !snapOverlays.isEmpty()) {
            overlayPlayers.remove(token);
            player.release();
            return;
        }
        try {
            startPlayerAfterI2sSettle(player, i2sRequestedAtMs);
            if (prep) {
                prepOverlays.add(token);
            }
        } catch (IllegalStateException e) {
            Log.e(TAG, "Unable to start deferred camera sound", e);
            overlayPlayers.remove(token);
            snapOverlays.remove(token);
            player.release();
        }
    }

    private void finishCameraOverlay(long token) {
        prepOverlays.remove(token);
        snapOverlays.remove(token);
        stoppingPrepOverlays.remove(token);
        waitingCameraStarts.remove(token);
        if (stoppingPrepOverlays.isEmpty()) {
            Map<Long, Runnable> ready = new HashMap<>(waitingCameraStarts);
            waitingCameraStarts.clear();
            for (Runnable start : ready.values()) {
                start.run();
            }
        }
    }

    /** Play a local WAV/PCM file as a single primary I2S job. */
    public synchronized void playFile(File file, float playbackVolume) {
        if (file == null) {
            Log.w(TAG, "playFile skipped: file is null");
            return;
        }
        Log.i(TAG, "Playing I2S file: " + file.getAbsolutePath());
        playPrimary(
                file.getName(),
                playbackVolume,
                player -> player.setDataSource(file.getAbsolutePath()));
    }

    private void playPrimaryAsset(String assetName, float playbackVolume) {
        Log.i(TAG, "Playing I2S asset: " + assetName);
        try (AssetFileDescriptor afd = context.getAssets().openFd(assetName)) {
            playPrimary(
                    assetName,
                    playbackVolume,
                    player ->
                            player.setDataSource(
                                    afd.getFileDescriptor(),
                                    afd.getStartOffset(),
                                    afd.getLength()));
        } catch (IOException e) {
            Log.e(TAG, "Unable to open asset " + assetName, e);
        }
    }

    private interface PlayerDataSource {
        void apply(MediaPlayer player) throws IOException;
    }

    private void playPrimary(
            String logName, float playbackVolume, PlayerDataSource source) {
        // Mark that WE are controlling I2S - prevents receiver from reacting to our broadcasts
        isControllingI2S = true;

        stopCurrentPlayer();

        long i2sRequestedAtMs = SystemClock.elapsedRealtime();
        boolean i2sStarted = notifyI2SState(true, true);
        Log.i(TAG, "I2S start for " + logName + " notifyI2SState=" + i2sStarted);
        if (!i2sStarted) {
            Log.w(TAG, "Failed to start I2S path; skipping playback of " + logName);
            refreshControlFlag();
            return;
        }

        MediaPlayer nextPlayer = null;
        try {
            nextPlayer = new MediaPlayer();
            configurePlayer(nextPlayer, playbackVolume);
            source.apply(nextPlayer);

            final MediaPlayer trackedPlayer = nextPlayer;
            mediaPlayer = trackedPlayer;
            trackedPlayer.setOnCompletionListener(
                    mp -> {
                        synchronized (I2SAudioController.this) {
                            if (mediaPlayer != mp) {
                                return;
                            }
                            Log.d(TAG, "I2S audio playback completed: " + logName);
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
                                    "MediaPlayer error for "
                                            + logName
                                            + " - what="
                                            + what
                                            + ", extra="
                                            + extra);
                            mediaPlayer = null;
                            mp.release();
                            closeI2SIfIdle();
                            refreshControlFlag();
                            return true;
                        }
                    });

            trackedPlayer.prepare();
            startPlayerAfterI2sSettle(trackedPlayer, i2sRequestedAtMs);
            Log.d(TAG, "I2S audio playback started: " + logName);
        } catch (Exception e) {
            Log.e(TAG, "Unable to play " + logName, e);
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
        if (playbackToken <= 0L || playbackToken != playbackGeneration || mediaPlayer == null) {
            return false;
        }
        ++playbackGeneration;
        isControllingI2S = true;
        stopCurrentPlayer();
        refreshControlFlag();
        return true;
    }

    /**
     * Check if this controller is actively managing I2S state. Used by I2SAudioBroadcastReceiver to
     * avoid reacting to our own playback.
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
        cameraAudioHandler.removeCallbacksAndMessages(null);
        waitingCameraStarts.clear();
        prepOverlays.clear();
        snapOverlays.clear();
        stoppingPrepOverlays.clear();
        for (MediaPlayer overlayPlayer : overlayPlayers.values()) {
            stopAndRelease(overlayPlayer);
        }
        overlayPlayers.clear();
    }

    private void stopAndRelease(MediaPlayer player) {
        try {
            if (player.isPlaying()) {
                player.stop();
            }
        } catch (IllegalStateException ignore) {
            // best-effort
        }
        player.release();
    }

    private void startPlayerAfterI2sSettle(MediaPlayer player, long i2sRequestedAtMs) {
        long remaining = I2S_START_SETTLE_MS - (SystemClock.elapsedRealtime() - i2sRequestedAtMs);
        if (remaining > 0L) {
            try {
                Thread.sleep(remaining);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            Log.i(TAG, "[I2S-RATE] settled " + remaining + "ms before MediaPlayer.start");
        }
        player.start();
    }

    private void configurePlayer(MediaPlayer player, float playbackVolume) {
        // STREAM_NOTIFICATION routes through system sounds which work with I2S.
        player.setAudioStreamType(AudioManager.STREAM_NOTIFICATION);
        player.setVolume(playbackVolume, playbackVolume);
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
        return notifyI2SState(playing, false);
    }

    private boolean notifyI2SState(boolean playing, boolean forceRestart) {
        AsgClientService service = AsgClientService.getInstance();
        if (service != null) {
            service.handleI2SAudioState(playing, forceRestart);
            return true;
        }

        Intent intent = new Intent(context, AsgClientService.class);
        intent.setAction(AsgClientService.ACTION_I2S_AUDIO_STATE);
        intent.putExtra(AsgClientService.EXTRA_I2S_AUDIO_PLAYING, playing);
        intent.putExtra(AsgClientService.EXTRA_I2S_FORCE_RESTART, forceRestart);
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
