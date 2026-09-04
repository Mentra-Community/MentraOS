package com.mentra.asg_client.audio;

import android.content.Context;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.mentra.asg_client.service.core.AsgClientService;

import java.io.IOException;

/**
 * Handles I2S audio playback for devices that route speaker output through the MCU.
 * This controller opens the I2S path via the MCU, plays an asset, and then closes the path.
 *
 * The path is not closed immediately when a clip finishes: it lingers open for
 * {@link #I2S_HOLD_OPEN_MS} so closely spaced clips (e.g. the photo capture sequence of
 * button click, warm-up tone, then capture-synchronized shutter sound) don't each pay the
 * MCU UART round-trip and I2S DAC ramp-up before becoming audible. This keeps the
 * timing-critical shutter clip aligned with the actual capture moment.
 */
public class I2SAudioController {

    private static final String TAG = "I2SAudioController";

    /**
     * How long the MCU I2S path is held open after a clip finishes before sending
     * mh_stopi2s. Sized to span a cold camera/ISP warm-up (1-2s) plus AE settling so the
     * shutter sound that follows a button click starts on an already-open path.
     */
    private static final long I2S_HOLD_OPEN_MS = 4000;

    private final Context context;

    private final Handler holdOpenHandler = new Handler(Looper.getMainLooper());

    private MediaPlayer mediaPlayer;

    // Track if WE are actively controlling I2S (to prevent receiver feedback loop)
    private static volatile boolean isControllingI2S = false;

    private final Runnable closePathRunnable = this::closePathNow;

    public I2SAudioController(Context context) {
        this.context = context.getApplicationContext();
    }

    public synchronized void playAsset(String assetName) {
        Log.i(TAG, "Playing I2S asset: " + assetName);

        // Mark that WE are controlling I2S - prevents receiver from reacting to our broadcasts
        isControllingI2S = true;

        // A new clip keeps the path open; cancel any pending deferred close.
        holdOpenHandler.removeCallbacks(closePathRunnable);

        // Stop any current clip but keep the I2S path open for the incoming one.
        stopCurrentPlayer(false);

        if (!notifyI2SState(true)) {
            Log.w(TAG, "Failed to start I2S path; skipping playback");
            isControllingI2S = false;
            return;
        }

        try {
            AssetFileDescriptor afd = context.getAssets().openFd(assetName);

            mediaPlayer = new MediaPlayer();

            // Set audio stream type to NOTIFICATION for proper I2S routing
            // STREAM_NOTIFICATION routes through system sounds which work with I2S
            mediaPlayer.setAudioStreamType(AudioManager.STREAM_NOTIFICATION);

            // Set volume to maximum for this stream to ensure audio is audible
            mediaPlayer.setVolume(0.1f, 0.1f);

            mediaPlayer.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
            afd.close();

            mediaPlayer.setOnCompletionListener(mp -> {
                Log.d(TAG, "I2S audio playback completed");
                mp.release();
                synchronized (this) {
                    if (mediaPlayer == mp) {
                        mediaPlayer = null;
                    }
                }
                schedulePathClose();
            });
            mediaPlayer.setOnErrorListener((mp, what, extra) -> {
                Log.e(TAG, "MediaPlayer error - what=" + what + ", extra=" + extra);
                mp.release();
                synchronized (this) {
                    if (mediaPlayer == mp) {
                        mediaPlayer = null;
                    }
                }
                schedulePathClose();
                return true;
            });

            mediaPlayer.prepare();
            mediaPlayer.start();
            Log.d(TAG, "I2S audio playback started");
        } catch (IOException e) {
            Log.e(TAG, "IOException while playing asset " + assetName, e);
            schedulePathClose();
        } catch (Exception e) {
            Log.e(TAG, "Unexpected exception while playing asset " + assetName, e);
            schedulePathClose();
        }
    }

    public synchronized void stopPlayback() {
        isControllingI2S = true;  // Mark as controlling before stopping
        holdOpenHandler.removeCallbacks(closePathRunnable);
        stopCurrentPlayer(true);  // Explicit stop closes the I2S path immediately
        isControllingI2S = false;  // Release control
    }

    /**
     * Check if this controller is actively managing I2S state.
     * Used by I2SAudioBroadcastReceiver to avoid reacting to our own playback.
     */
    public static boolean isControllingI2S() {
        return isControllingI2S;
    }

    /**
     * Defer closing the I2S path so a follow-up clip (e.g. the capture-synchronized shutter
     * sound after a warm-up tone) starts without I2S startup latency. Control of the path is
     * kept until the deferred close actually runs.
     */
    private void schedulePathClose() {
        holdOpenHandler.removeCallbacks(closePathRunnable);
        holdOpenHandler.postDelayed(closePathRunnable, I2S_HOLD_OPEN_MS);
    }

    private synchronized void closePathNow() {
        if (mediaPlayer != null) {
            // A new clip started during the hold window; it owns the path now.
            return;
        }
        Log.d(TAG, "I2S hold-open window expired; closing path");
        notifyI2SState(false);
        isControllingI2S = false;  // Release control
    }

    private void stopCurrentPlayer(boolean closePath) {
        if (mediaPlayer != null) {
            try {
                if (mediaPlayer.isPlaying()) {
                    mediaPlayer.stop();
                }
            } catch (IllegalStateException ignore) {
                // best-effort
            }
            mediaPlayer.release();
            mediaPlayer = null;

            if (closePath) {
                // Close I2S path only if we had a player running
                // This ensures cleanup even if app is killed during playback
                notifyI2SState(false);
            }
        } else if (closePath) {
            // No player but the path may still be held open from a previous clip.
            notifyI2SState(false);
        }
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
