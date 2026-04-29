package com.mentra.asg_client.service.system.managers;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.preference.PreferenceManager;

import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;


/**
 * Implementation of IConfigurationManager using SharedPreferences.
 * Follows Single Responsibility Principle by handling only configuration management.
 */
public class ConfigurationManager implements IConfigurationManager {

    private static final String TAG = "ConfigurationManager";
    private static final String USER_EMAIL_KEY = "user_email";

    private final Context context;
    private final SharedPreferences preferences;

    public ConfigurationManager(Context context) {
        this.context = context;
        this.preferences = PreferenceManager.getDefaultSharedPreferences(context);
    }

    @Override
    public boolean saveUserEmail(String email) {
        if (email == null || email.trim().isEmpty()) {
            Log.w(TAG, "Cannot save empty or null user email");
            return false;
        }

        try {
            SharedPreferences.Editor editor = preferences.edit();
            editor.putString(USER_EMAIL_KEY, email.trim());
            boolean success = editor.commit();

            if (success) {
                Log.d(TAG, "User email saved successfully");
            } else {
                Log.e(TAG, "Failed to save user email");
            }

            return success;
        } catch (Exception e) {
            Log.e(TAG, "Error saving user email", e);
            return false;
        }
    }

    @Override
    public String getUserEmail() {
        try {
            String email = preferences.getString(USER_EMAIL_KEY, null);
            if (email != null) {
                Log.d(TAG, "User email retrieved successfully");
            } else {
                Log.d(TAG, "No user email found");
            }
            return email;
        } catch (Exception e) {
            Log.e(TAG, "Error retrieving user email", e);
            return null;
        }
    }

    @Override
    public boolean clearUserEmail() {
        try {
            SharedPreferences.Editor editor = preferences.edit();
            editor.remove(USER_EMAIL_KEY);
            boolean success = editor.commit();

            if (success) {
                Log.d(TAG, "User email cleared successfully");
            } else {
                Log.e(TAG, "Failed to clear user email");
            }

            return success;
        } catch (Exception e) {
            Log.e(TAG, "Error clearing user email", e);
            return false;
        }
    }

    @Override
    public boolean hasUserEmail() {
        try {
            String email = preferences.getString(USER_EMAIL_KEY, null);
            boolean hasEmail = email != null && !email.trim().isEmpty();
            Log.d(TAG, "User email exists: " + hasEmail);
            return hasEmail;
        } catch (Exception e) {
            Log.e(TAG, "Error checking user email existence", e);
            return false;
        }
    }

    @Override
    public boolean saveConfiguration(String key, String value) {
        if (key == null || key.trim().isEmpty()) {
            Log.w(TAG, "Cannot save configuration with empty or null key");
            return false;
        }

        try {
            SharedPreferences.Editor editor = preferences.edit();
            editor.putString(key.trim(), value);
            boolean success = editor.commit();

            if (success) {
                Log.d(TAG, "Configuration saved successfully: " + key);
            } else {
                Log.e(TAG, "Failed to save configuration: " + key);
            }

            return success;
        } catch (Exception e) {
            Log.e(TAG, "Error saving configuration: " + key, e);
            return false;
        }
    }

    @Override
    public String getConfiguration(String key, String defaultValue) {
        if (key == null || key.trim().isEmpty()) {
            Log.w(TAG, "Cannot retrieve configuration with empty or null key");
            return defaultValue;
        }

        try {
            String value = preferences.getString(key.trim(), defaultValue);
            Log.d(TAG, "Configuration retrieved: " + key + " = " + value);
            return value;
        } catch (Exception e) {
            Log.e(TAG, "Error retrieving configuration: " + key, e);
            return defaultValue;
        }
    }

    @Override
    public boolean clearConfiguration(String key) {
        if (key == null || key.trim().isEmpty()) {
            Log.w(TAG, "Cannot clear configuration with empty or null key");
            return false;
        }

        try {
            SharedPreferences.Editor editor = preferences.edit();
            editor.remove(key.trim());
            boolean success = editor.commit();

            if (success) {
                Log.d(TAG, "Configuration cleared successfully: " + key);
            } else {
                Log.e(TAG, "Failed to clear configuration: " + key);
            }

            return success;
        } catch (Exception e) {
            Log.e(TAG, "Error clearing configuration: " + key, e);
            return false;
        }
    }
}
