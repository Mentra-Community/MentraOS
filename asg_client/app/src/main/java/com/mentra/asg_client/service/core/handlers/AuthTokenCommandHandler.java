package com.mentra.asg_client.service.core.handlers;

import android.util.Log;

import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;

import org.json.JSONObject;

import java.util.Set;

/**
 * Handler for authentication token commands.
 * Follows Single Responsibility Principle by handling only auth token commands.
 */
public class AuthTokenCommandHandler implements ICommandHandler {
    private static final String TAG = "AuthTokenCommandHandler";
    
    private final ICommunicationManager communicationManager;
    private final IConfigurationManager configurationManager;

    public AuthTokenCommandHandler(ICommunicationManager communicationManager, 
                                 IConfigurationManager configurationManager) {
        this.communicationManager = communicationManager;
        this.configurationManager = configurationManager;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("auth_token");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case "auth_token":
                    return handleAuthToken(data);
                default:
                    Log.e(TAG, "Unsupported auth token command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling auth token command: " + commandType, e);
            return false;
        }
    }

    /**
     * Handle auth token command
     */
    private boolean handleAuthToken(JSONObject data) {
        try {
            String coreToken = data.optString("coreToken", "");
            if (!coreToken.isEmpty()) {
                Log.d(TAG, "Received coreToken from AugmentOS Core");
                boolean success = configurationManager.saveCoreToken(coreToken);
                communicationManager.sendTokenStatusResponse(success);
                return success;
            } else {
                Log.e(TAG, "Received empty coreToken");
                communicationManager.sendTokenStatusResponse(false);
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling auth token command", e);
            communicationManager.sendTokenStatusResponse(false);
            return false;
        }
    }
} 