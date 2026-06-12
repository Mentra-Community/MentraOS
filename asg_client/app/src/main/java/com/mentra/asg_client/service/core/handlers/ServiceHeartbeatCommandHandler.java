package com.mentra.asg_client.service.core.handlers;

import android.util.Log;

import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;

import org.json.JSONObject;

import java.util.Set;

/**
 * Handler for heartbeat commands.
 * Handles both "service_heartbeat" (from MentraLiveSGC) and
 * "heartbeat" (from iOS companion app via InmoGo2.swift).
 * Resets the 35-second connection timeout on the glasses side.
 */
public class ServiceHeartbeatCommandHandler implements ICommandHandler {
    private static final String TAG = "ServiceHeartbeatCommandHandler";

    private final AsgClientServiceManager serviceManager;

    public ServiceHeartbeatCommandHandler(AsgClientServiceManager serviceManager) {
        this.serviceManager = serviceManager;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("service_heartbeat", "heartbeat");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case "service_heartbeat":
                case "heartbeat":
                    return handleHeartbeat(commandType, data);
                default:
                    Log.e(TAG, "Unsupported heartbeat command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling heartbeat command: " + commandType, e);
            return false;
        }
    }

    private boolean handleHeartbeat(String commandType, JSONObject data) {
        try {
            long timestamp = data.optLong("timestamp", System.currentTimeMillis());
            int counter = data.optInt("heartbeat_counter", -1);

            if (counter != -1) {
                Log.d(TAG, "💓 " + commandType + " #" + counter + " at " + timestamp);
            } else {
                Log.d(TAG, "💓 " + commandType + " at " + timestamp);
            }

            if (serviceManager != null) {
                serviceManager.onServiceHeartbeatReceived();
                return true;
            } else {
                Log.e(TAG, "❌ ServiceManager is null - cannot reset heartbeat timeout");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "💥 Error handling heartbeat", e);
            return false;
        }
    }
}