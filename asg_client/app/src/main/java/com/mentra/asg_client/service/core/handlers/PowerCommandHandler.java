package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.SysControl;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;

import org.json.JSONObject;

import java.util.Set;

/**
 * Handler for power-related commands (shutdown, reboot).
 * Handles commands sent from the phone to control glasses power state.
 *
 * Command format: {"type": "shutdown"} or {"type": "reboot"}
 */
public class PowerCommandHandler implements ICommandHandler {
    private static final String TAG = "PowerCommandHandler";

    private static final String CMD_SHUTDOWN = "shutdown";
    private static final String CMD_REBOOT = "reboot";

    private final Context context;

    public PowerCommandHandler(Context context) {
        this.context = context;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of(CMD_SHUTDOWN, CMD_REBOOT);
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case CMD_SHUTDOWN:
                    return handleShutdown();
                case CMD_REBOOT:
                    return handleReboot();
                default:
                    Log.e(TAG, "Unsupported power command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling power command: " + commandType, e);
            return false;
        }
    }

    /**
     * Handle shutdown command from phone.
     * Initiates a graceful shutdown of the glasses.
     */
    private boolean handleShutdown() {
        Log.i(TAG, "🔌 Received shutdown command from phone - initiating device shutdown");

        try {
            SysControl.shut(context);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "❌ Error initiating shutdown", e);
            return false;
        }
    }

    /**
     * Handle reboot command from phone.
     * Initiates a reboot of the glasses.
     */
    private boolean handleReboot() {
        Log.i(TAG, "🔄 Received reboot command from phone - initiating device reboot");

        try {
            SysControl.reboot(context);
            return true;
        } catch (Exception e) {
            Log.e(TAG, "❌ Error initiating reboot", e);
            return false;
        }
    }
}
