package com.mentra.asg_client.service.core.handlers;

import android.util.Log;

import com.mentra.asg_client.audio.AudioRecorder;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;

import org.json.JSONObject;

import java.util.Set;

/**
 * Handler for microphone-related commands.
 * Follows Single Responsibility Principle by handling only microphone commands.
 *
 * <p>Routes {@code set_mic_state} and {@code set_mic_vad_state} BLE commands to the
 * {@link AudioRecorder}, which performs the actual PCM capture on a dedicated thread.
 */
public class MicrophoneCommandHandler implements ICommandHandler {

    private static final String TAG = "MicrophoneCommandHandler";

    private final AudioRecorder audioRecorder;

    public MicrophoneCommandHandler(AudioRecorder audioRecorder) {
        this.audioRecorder = audioRecorder;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("set_mic_state", "set_mic_vad_state");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case "set_mic_state":
                    return handleSetMicState(data);
                case "set_mic_vad_state":
                    return handleSetMicVadState(data);
                default:
                    Log.e(TAG, "Unsupported microphone command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling microphone command: " + commandType, e);
            return false;
        }
    }

    // ─── Private helpers ─────────────────────────────────────────────────────────

    private boolean handleSetMicState(JSONObject data) {
        try {
            boolean enabled = data.optBoolean("enabled", false);
            Log.i(TAG, "Setting microphone state: " + (enabled ? "ON" : "OFF"));

            if (enabled) {
                return audioRecorder.start();
            } else {
                audioRecorder.stop();
                return true;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling set_mic_state", e);
            return false;
        }
    }

    private boolean handleSetMicVadState(JSONObject data) {
        try {
            boolean enabled = data.optBoolean("enabled", false);
            Log.i(TAG, "Setting microphone VAD state: " + (enabled ? "ON" : "OFF"));
            audioRecorder.setVadEnabled(enabled);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling set_mic_vad_state", e);
            return false;
        }
    }
}
