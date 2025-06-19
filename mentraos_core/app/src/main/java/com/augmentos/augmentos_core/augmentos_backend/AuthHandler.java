package com.augmentos.augmentos_core.augmentos_backend;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.preference.PreferenceManager;

import com.augmentos.augmentos_core.AugmentosService;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.UUID;

public class AuthHandler {
    private static final String TAG = "AuthHandler";

    // Name of our SharedPreferences file
    private static final String PREFS_NAME = "augmentos_auth_prefs";

    // Keys for SharedPreferences
    private static final String KEY_MANAGER_USER = "manager_user";
    private static final String KEY_CORE_TOKEN_OWNER = "core_token_owner";
    private static final String KEY_CORE_TOKEN_STATUS = "core_token_status";
    private static final String KEY_CORE_TOKEN = "core_token";
    private static final String KEY_LAST_VERIFICATION = "last_verification_timestamp";
    private static final String KEY_LOCAL_ANALYTICS_ID = "local_analytics_id";

    public enum TokenStatus {
        NONE, PENDING, VERIFIED, INVALID
    }

    private String managerUser;
    private String coreTokenOwner;
    private TokenStatus coreTokenStatus = TokenStatus.NONE;
    private String coreToken;
    private long lastVerificationTimestamp;
    private String localAnalyticsId;

    private Context context;
    // Constructors, getters, and other methods omitted for brevity...

    public AuthHandler(Context context) {
        this.context = context;
        loadFromStorage();
    }

    // ----------------------------------------------------
    // Persistence Methods
    // ----------------------------------------------------
    public void loadFromStorage() {
        Log.d(TAG, "Loading auth state from storage...");
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);

        this.managerUser = prefs.getString(KEY_MANAGER_USER, null);
        this.coreTokenOwner = prefs.getString(KEY_CORE_TOKEN_OWNER, null);

        String statusString = prefs.getString(KEY_CORE_TOKEN_STATUS, TokenStatus.NONE.name());
        this.coreTokenStatus = TokenStatus.valueOf(statusString);

        this.coreToken = prefs.getString(KEY_CORE_TOKEN, null);
        this.lastVerificationTimestamp = prefs.getLong(KEY_LAST_VERIFICATION, 0);

        this.localAnalyticsId = prefs.getString(KEY_LOCAL_ANALYTICS_ID, null);

        Log.d(TAG, "Auth state loaded: managerUser=" + managerUser
                + ", coreTokenOwner=" + coreTokenOwner
                + ", status=" + coreTokenStatus
                + ", lastVerification=" + lastVerificationTimestamp);
    }

    public void saveToStorage() {
        Log.d(TAG, "Saving auth state to storage...");
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        SharedPreferences.Editor editor = prefs.edit();

        editor.putString(KEY_MANAGER_USER, managerUser);
        editor.putString(KEY_CORE_TOKEN_OWNER, coreTokenOwner);
        editor.putString(KEY_CORE_TOKEN_STATUS, coreTokenStatus.name());
        editor.putString(KEY_CORE_TOKEN, coreToken);
        editor.putLong(KEY_LAST_VERIFICATION, lastVerificationTimestamp);
        editor.putString(KEY_LOCAL_ANALYTICS_ID, localAnalyticsId);

        editor.apply();  // or commit()
    }
    public void setManagerUser(String managerUser) {
        this.managerUser = managerUser;
        saveToStorage();  // ensure we save whenever we update
    }

    public void setAuthSecretKey(String authSecretKey) {
        Log.d(TAG, "Setting auth secret key: " + authSecretKey);

        if (authSecretKey == null || authSecretKey.isEmpty()) {
            this.coreToken = null;
            this.coreTokenStatus = TokenStatus.NONE;
            this.coreTokenOwner = null;
            this.lastVerificationTimestamp = 0;
        } else {
            this.coreToken = authSecretKey;
            this.coreTokenStatus = TokenStatus.PENDING;
            this.coreTokenOwner = null;
            this.lastVerificationTimestamp = 0;
        }

        // Persist these changes
        saveToStorage();
    }

    // TODO: This is a hacky stopgap- in the future, get this fro. the backend
    public void verifyAuthSecretKey(String uniqueUserId) {
        Log.d(TAG, "Verifying auth secret key");
        if (coreToken == null || coreToken.isEmpty()) {
            Log.w(TAG, "No auth secret key set, cannot verify.");
            this.coreTokenStatus = TokenStatus.NONE;
            this.coreTokenOwner = null;
            this.lastVerificationTimestamp = 0;
            saveToStorage();
            return;
        }

        // TODO:  "fake" verification logic
        boolean tokenValid = true; // Imagine a real API call to /verify
        String tokenOwner = uniqueUserId;
        //String tokenOwner = "bob@gmail.com"; // Returned by server

        String oldAnalyticsId = getUniqueIdForAnalytics();

        if (tokenValid) {
            this.coreTokenStatus = TokenStatus.VERIFIED;
            this.coreTokenOwner = tokenOwner;
        } else {
            this.coreTokenStatus = TokenStatus.INVALID;
            this.coreTokenOwner = null;
        }
        this.lastVerificationTimestamp = System.currentTimeMillis();

        saveToStorage();
    }

    public void deleteAuthSecretKey() {
        Log.d(TAG, "Deleting auth secret key");

        this.coreToken = null;
        this.coreTokenStatus = TokenStatus.NONE;
        this.coreTokenOwner = null;
        this.lastVerificationTimestamp = 0;

        saveToStorage();
    }

    // ----------------------------------------------------
    // Getters
    // ----------------------------------------------------

    /**
     * Returns the Manager user (usually the email address),
     * as stored or loaded from SharedPreferences.
     */
    public String getManagerUser() {
        return managerUser;
    }

    /**
     * Returns the user associated with the current CoreToken,
     * if verified by the backend.
     */
    public String getCoreTokenOwner() {
        return coreTokenOwner;
    }

    public synchronized String getUniqueIdForAnalytics() {
        if (coreTokenOwner != null && !coreTokenOwner.isEmpty()
                && coreTokenStatus == TokenStatus.VERIFIED) {
            // The user is verified, so use their verified identity
            return coreTokenOwner;
        } else {
            // Use or create the local random ID
            if (localAnalyticsId == null || localAnalyticsId.isEmpty()) {
                localAnalyticsId = UUID.randomUUID().toString();
                saveToStorage();
            }
            return localAnalyticsId;
        }
    }

    /**
     * Returns the current status of the token:
     * NONE, PENDING, VERIFIED, or INVALID.
     */
    public TokenStatus getCoreTokenStatus() {
        return coreTokenStatus;
    }

    /**
     * Returns the actual token (for internal usage).
     * Avoid exposing this externally in JSON or logs.
     */
    public String getCoreToken() {
        return coreToken;
    }

    /**
     * Returns the last time (in millis since epoch) we attempted verification.
     */
    public long getLastVerificationTimestamp() {
        return lastVerificationTimestamp;
    }

    public JSONObject toJson() {
        JSONObject authJson = new JSONObject();
        try {
            //authJson.put("manager_user", managerUser != null ? managerUser : JSONObject.NULL);
            authJson.put("core_token_owner", coreTokenOwner != null ? coreTokenOwner : JSONObject.NULL);
            authJson.put("core_token_status", coreTokenStatus.name().toLowerCase());
            authJson.put("last_verification_timestamp", lastVerificationTimestamp);
        } catch (JSONException e) {
            Log.e(TAG, "Error constructing auth status JSON", e);
        }
        return authJson;
    }
}
