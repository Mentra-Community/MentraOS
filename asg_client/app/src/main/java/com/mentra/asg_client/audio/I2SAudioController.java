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

/**
 * Handles I2S audio playback for devices that route speaker output through the MCU.
 * This controller opens the I2S path via the MCU, plays an asset, and then closes the path.
 */
public class I2SAudioController {

    private static final String TAG = "I2SAudioController";

    private final Context context;

    private MediaPlayer mediaPlayer;

    // Track if WE are actively controlling I2S (to prevent receiver feedback loop)
    private static volatile boolean isControllingI2S = false;

    public I2SAudioController(Context context) {
        this.context = context.getApplicationContext();
    }

    public synchronized void playAsset(String assetName) {
        Log.i(TAG, "Playing I2S asset: " + assetName);

        // Mark that WE are controlling I2S - prevents receiver from reacting to our broadcasts
        isControllingI2S = true;

        stopCurrentPlayer();

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
                mediaPlayer = null;
                notifyI2SState(false);
                isControllingI2S = false;  // Release control
            });
            mediaPlayer.setOnErrorListener((mp, what, extra) -> {
                Log.e(TAG, "MediaPlayer error - what=" + what + ", extra=" + extra);
                mp.release();
                mediaPlayer = null;
                notifyI2SState(false);
                isControllingI2S = false;  // Release control
                return true;
            });

            mediaPlayer.prepare();
            mediaPlayer.start();
            Log.d(TAG, "I2S audio playback started");
        } catch (IOException e) {
            Log.e(TAG, "IOException while playing asset " + assetName, e);
            notifyI2SState(false);
            isControllingI2S = false;  // Release control on error
        } catch (Exception e) {
            Log.e(TAG, "Unexpected exception while playing asset " + assetName, e);
            notifyI2SState(false);
            isControllingI2S = false;  // Release control on error
        }
    }

    public synchronized void stopPlayback() {
        isControllingI2S = true;  // Mark as controlling before stopping
        stopCurrentPlayer();  // Now handles I2S path closing
        isControllingI2S = false;  // Release control
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
            try {
                if (mediaPlayer.isPlaying()) {
                    mediaPlayer.stop();
                }
            } catch (IllegalStateException ignore) {
                // best-effort
            }
            mediaPlayer.release();
            mediaPlayer = null;

            // Close I2S path only if we had a player running
            // This ensures cleanup even if app is killed during playback
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
