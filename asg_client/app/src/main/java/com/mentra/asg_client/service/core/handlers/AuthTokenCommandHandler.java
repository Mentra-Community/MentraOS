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
        Log.i(TAG, "🔐 ========== handleCommand() called ==========");
        Log.i(TAG, "🔐 Command type: " + commandType);
        Log.i(TAG, "🔐 Data: " + (data != null ? data.toString().replace(data.optString("coreToken", ""), "[TOKEN_REDACTED]") : "null"));
        
        try {
            switch (commandType) {
                case "auth_token":
                    Log.i(TAG, "🔐 Routing to handleAuthToken()");
                    boolean result = handleAuthToken(data);
                    Log.i(TAG, "🔐 handleAuthToken() returned: " + result);
                    Log.i(TAG, "🔐 ========== handleCommand() END ==========");
                    return result;
                default:
                    Log.e(TAG, "❌ Unsupported auth token command: " + commandType);
                    Log.i(TAG, "🔐 ========== handleCommand() END (UNSUPPORTED) ==========");
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "💥 Error handling auth token command: " + commandType, e);
            Log.e(TAG, "💥 Stack trace: " + android.util.Log.getStackTraceString(e));
            Log.i(TAG, "🔐 ========== handleCommand() END (EXCEPTION) ==========");
            return false;
        }
    }

    /**
     * Handle auth token command
     */
    private boolean handleAuthToken(JSONObject data) {
        Log.i(TAG, "🔐 ========== handleAuthToken() START ==========");
        Log.i(TAG, "🔐 Step 1: Extracting coreToken from JSON data");
        
        try {
            String coreToken = data.optString("coreToken", "");
            Log.i(TAG, "🔐 Step 2: Token extracted - " + (coreToken.isEmpty() ? "EMPTY" : "exists (length: " + coreToken.length() + " chars)"));
            
            if (!coreToken.isEmpty()) {
                Log.i(TAG, "🔐 Step 3: Token validation passed");
                Log.i(TAG, "🔐 Received coreToken from mobile app (length: " + coreToken.length() + " chars)");
                Log.i(TAG, "🔐 Step 4: Calling configurationManager.saveCoreToken()");
                
                boolean success = configurationManager.saveCoreToken(coreToken);
                
                Log.i(TAG, "🔐 Step 5: saveCoreToken() returned: " + success);
                
                if (success) {
                    Log.i(TAG, "✅ Core token saved successfully - gallery uploads can now proceed");
                    Log.i(TAG, "🔐 Step 6: Sending success response to mobile app");
                } else {
                    Log.e(TAG, "❌ Failed to save core token");
                    Log.i(TAG, "🔐 Step 6: Sending failure response to mobile app");
                }
                
                communicationManager.sendTokenStatusResponse(success);
                Log.i(TAG, "🔐 Step 7: Response sent to mobile app");
                Log.i(TAG, "🔐 ========== handleAuthToken() END (SUCCESS: " + success + ") ==========");
                return success;
            } else {
                Log.e(TAG, "❌ Received empty coreToken from mobile app");
                Log.i(TAG, "🔐 Step 3: Token validation FAILED - token is empty");
                Log.i(TAG, "🔐 Step 4: Sending failure response to mobile app");
                communicationManager.sendTokenStatusResponse(false);
                Log.i(TAG, "🔐 ========== handleAuthToken() END (FAILED - EMPTY TOKEN) ==========");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "💥 Error handling auth token command", e);
            Log.e(TAG, "💥 Exception type: " + e.getClass().getName());
            Log.e(TAG, "💥 Exception message: " + e.getMessage());
            Log.e(TAG, "💥 Stack trace: " + android.util.Log.getStackTraceString(e));
            Log.i(TAG, "🔐 Step X: Sending failure response due to exception");
            communicationManager.sendTokenStatusResponse(false);
            Log.i(TAG, "🔐 ========== handleAuthToken() END (EXCEPTION) ==========");
            return false;
        }
    }
} 