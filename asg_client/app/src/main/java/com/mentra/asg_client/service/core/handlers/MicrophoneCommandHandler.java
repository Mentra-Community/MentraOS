package com.mentra.asg_client.service.core.handlers;

import android.util.Log;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;

import org.json.JSONObject;
import java.util.Set;

/**
 * Handler for microphone-related commands.
 * Follows Single Responsibility Principle by handling only microphone commands.
 */
public class MicrophoneCommandHandler implements ICommandHandler {
    private static final String TAG = "MicrophoneCommandHandler";
    
    private final AsgClientServiceManager serviceManager;

    public MicrophoneCommandHandler(AsgClientServiceManager serviceManager) {
        this.serviceManager = serviceManager;
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

    /**
     * Handle set microphone state command
     */
    private boolean handleSetMicState(JSONObject data) {
        try {
            boolean enabled = data.optBoolean("enabled", false);
            Log.d(TAG, "🎤 Setting microphone state: " + enabled);
            //TODO: Set microphone state in service manager
            // serviceManager.setMicrophoneState(enabled);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling set microphone state command", e);
            return false;
        }
    }

    /**
     * Handle set microphone VAD state command
     */
    private boolean handleSetMicVadState(JSONObject data) {
        try {
            boolean enabled = data.optBoolean("enabled", false);
            Log.d(TAG, "🎤 Setting microphone VAD state: " + enabled);
            //TODO: Set microphone VAD state in service manager
            // serviceManager.setMicrophoneVadState(enabled);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling set microphone VAD state command", e);
            return false;
        }
    }
}
