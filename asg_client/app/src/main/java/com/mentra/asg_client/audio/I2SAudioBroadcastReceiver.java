package com.mentra.asg_client.audio;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.os.Build;
import android.util.Log;

import com.mentra.asg_client.service.core.AsgClientService;

/**
 * Receives audio play state broadcasts from the ODM firmware and forwards them to
 * {@link AsgClientService} which notifies the MCU to start/stop I2S audio.
 */
public class I2SAudioBroadcastReceiver extends BroadcastReceiver {

    private static final String TAG = "I2SAudioReceiver";

    public static final String ACTION_PLAYSTATE_CHANGE = "com.xy.sound.AUDIO_PLAYSTATE_CHANGE";
    public static final String ACTION_PLAYSTATE_ACTION = "com.xy.sound.AUDIO_PLAYSTATE_ACTION";
    private static final String EXTRA_STATE = "state";
    private static final String STATE_START = "start";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) {
            Log.w(TAG, "Received null intent");
            return;
        }

        final String action = intent.getAction();
        if (!ACTION_PLAYSTATE_CHANGE.equals(action) && !ACTION_PLAYSTATE_ACTION.equals(action)) {
            Log.d(TAG, "Ignoring unrelated action: " + action);
            return;
        }

        final String state = intent.getStringExtra(EXTRA_STATE);
        if (state == null) {
            Log.w(TAG, "Missing state extra in playstate broadcast");
            return;
        }

        final boolean start = STATE_START.equalsIgnoreCase(state);
        Log.i(TAG, "Firmware I2S broadcast: " + state + " (start=" + start + ")");

        // Cues use STREAM_NOTIFICATION and must not forward their own firmware events as
        // external bridge commands. Still reconcile music ownership: a song can end during
        // a cue, and dropping that stop would leave externalAudioPlaying stuck forever.
        if (I2SAudioController.isControllingI2S()) {
            AudioManager audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            boolean musicPlaying = audio != null && audio.isMusicActive();
            if (!start || musicPlaying) {
                I2SAudioController.setExternalAudioPlaying(musicPlaying);
            }
            Log.d(TAG, "Deferring firmware bridge command while a cue is playing");
            return;
        }

        // This playback is not ours, so it owns the bridge for as long as it runs. Camera cues
        // check this before re-announcing or closing I2S; without it every shutter in a burst
        // tore the path down and back up underneath the music.
        I2SAudioController.setExternalAudioPlaying(start);

        // Forward external app audio state to MCU (e.g., VLC, system sounds)
        Intent serviceIntent = new Intent(context, AsgClientService.class);
        serviceIntent.setAction(AsgClientService.ACTION_I2S_AUDIO_STATE);
        serviceIntent.putExtra(AsgClientService.EXTRA_I2S_AUDIO_PLAYING, start);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent);
            } else {
                context.startService(serviceIntent);
            }
        } catch (IllegalStateException e) {
            Log.e(TAG, "Failed to start service for I2S state", e);
        }
    }
}
