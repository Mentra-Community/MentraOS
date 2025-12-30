package com.mentra.asg_client.service.core.handlers;

import android.util.Log;

import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;

import org.json.JSONObject;
import java.util.Set;

/**
 * Handler for version-related commands.
 * Delegates to AsgClientService.sendVersionInfo() for the actual implementation
 * to maintain a single source of truth for version info sending.
 */
public class VersionCommandHandler implements ICommandHandler {
    private static final String TAG = "VersionCommandHandler";

    private final AsgClientServiceManager serviceManager;

    public VersionCommandHandler(AsgClientServiceManager serviceManager) {
        this.serviceManager = serviceManager;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("request_version", "cs_syvr");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case "request_version":
                case "cs_syvr":
                    Log.d(TAG, "📊 Received " + commandType + " command - delegating to AsgClientService");
                    if (serviceManager.getService() != null) {
                        serviceManager.getService().sendVersionInfo();
                        return true;
                    } else {
                        Log.e(TAG, "Service is null, cannot send version info");
                        return false;
                    }
                default:
                    Log.e(TAG, "Unsupported version command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling version command: " + commandType, e);
            return false;
        }
    }
} 