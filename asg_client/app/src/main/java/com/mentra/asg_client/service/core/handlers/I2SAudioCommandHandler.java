package com.mentra.asg_client.service.core.handlers;

import android.util.Log;

import com.mentra.asg_client.service.core.AsgClientService;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;

import org.json.JSONObject;

import java.util.Set;

/**
 * Handler for I2S audio enable/disable commands.
 * Allows third-party apps to control I2S audio playback on the glasses
 * via the intent IPC API or BLE command channel.
 */
public class I2SAudioCommandHandler implements ICommandHandler {
    private static final String TAG = "I2SAudioCommandHandler";

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("enable_i2s", "enable_android_audio", "disable_i2s", "disable_android_audio");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        AsgClientService service = AsgClientService.getInstance();
        if (service == null) {
            Log.e(TAG, "❌ AsgClientService not running");
            return false;
        }

        switch (commandType) {
            case "enable_android_audio":
            case "enable_i2s":
                Log.i(TAG, "🔊 Enabling I2S audio");
                service.handleI2SAudioState(true);
                return true;
            case "disable_android_audio":
            case "disable_i2s":
                Log.i(TAG, "🔇 Disabling I2S audio");
                service.handleI2SAudioState(false);
                return true;
            default:
                Log.e(TAG, "❌ Unsupported command: " + commandType);
                return false;
        }
    }
}
