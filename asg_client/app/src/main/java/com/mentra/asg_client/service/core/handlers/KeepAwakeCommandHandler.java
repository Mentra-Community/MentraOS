package com.mentra.asg_client.service.core.handlers;

import android.util.Log;

import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;

import org.json.JSONObject;

import java.util.Set;

/**
 * Handler for keep_awake commands from the phone (e.g. during live view).
 * Acknowledges the command so the phone knows the glasses are responsive.
 * No response payload is required; the handler prevents "no handler found" errors.
 */
public class KeepAwakeCommandHandler implements ICommandHandler {
    private static final String TAG = "KeepAwakeCommandHandler";

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("keep_awake");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        if (!"keep_awake".equals(commandType)) {
            Log.e(TAG, "Unsupported command: " + commandType);
            return false;
        }
        Log.d(TAG, "☀️ keep_awake received (no response required)");
        return true;
    }
}
