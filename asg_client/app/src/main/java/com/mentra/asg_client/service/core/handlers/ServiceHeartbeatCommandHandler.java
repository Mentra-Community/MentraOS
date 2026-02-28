package com.mentra.asg_client.service.core.handlers;

import android.util.Log;

import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;

import org.json.JSONObject;

import java.util.Set;

/**
 * Handler for service heartbeat commands from MentraLiveSGC.
 * Follows Single Responsibility Principle by handling only service heartbeat commands.
 */
public class ServiceHeartbeatCommandHandler implements ICommandHandler {
    private static final String TAG = "ServiceHeartbeatCommandHandler";
    
    private final AsgClientServiceManager serviceManager;

    public ServiceHeartbeatCommandHandler(AsgClientServiceManager serviceManager) {
        this.serviceManager = serviceManager;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("service_heartbeat");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case "service_heartbeat":
                    return handleServiceHeartbeat(data);
                default:
                    Log.e(TAG, "Unsupported service heartbeat command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling service heartbeat command: " + commandType, e);
            return false;
        }
    }

    /**
     * Handle service heartbeat command from MentraLiveSGC
     */
    private boolean handleServiceHeartbeat(JSONObject data) {
        try {
            // Extract heartbeat information
            long timestamp = data.optLong("timestamp", System.currentTimeMillis());
            int heartbeatCounter = data.optInt("heartbeat_counter", -1);
            
            Log.d(TAG, "💓 Service heartbeat #" + heartbeatCounter + " received at " + timestamp);
            
            // Notify AsgClientService about heartbeat to reset timeout
            if (serviceManager != null) {
                serviceManager.onServiceHeartbeatReceived();
                return true;
            } else {
                Log.e(TAG, "❌ ServiceManager is null - cannot process heartbeat");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "💥 Error handling service heartbeat command", e);
            return false;
        }
    }
}
