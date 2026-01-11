package com.mentra.asg_client.service.core.handlers;

import android.util.Log;

import com.mentra.asg_client.reporting.core.ReportManager;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;

import org.json.JSONObject;

import java.util.Set;

/**
 * Handler for user email commands.
 * Saves user email for Sentry crash reporting identification.
 * Follows Single Responsibility Principle by handling only user email commands.
 */
public class UserEmailCommandHandler implements ICommandHandler {
    private static final String TAG = "UserEmailCommandHandler";

    private final IConfigurationManager configurationManager;
    private final ReportManager reportManager;

    public UserEmailCommandHandler(IConfigurationManager configurationManager,
                                   ReportManager reportManager) {
        this.configurationManager = configurationManager;
        this.reportManager = reportManager;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("user_email");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case "user_email":
                    return handleUserEmail(data);
                default:
                    Log.e(TAG, "Unsupported user email command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling user email command: " + commandType, e);
            return false;
        }
    }

    /**
     * Handle user email command
     */
    private boolean handleUserEmail(JSONObject data) {
        try {
            String email = data.optString("email", "");
            if (!email.isEmpty()) {
                Log.d(TAG, "Received user email from phone");
                boolean success = configurationManager.saveUserEmail(email);

                if (success && reportManager != null) {
                    // Set user context for Sentry reporting
                    // Using email as both userId and email since that's how mobile does it
                    reportManager.setUserContext(email, null, email);
                    Log.d(TAG, "User context set for crash reporting");
                }

                return success;
            } else {
                Log.e(TAG, "Received empty user email");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling user email command", e);
            return false;
        }
    }
}
