package com.mentra.asg_client.io.bes;

import android.content.Context;
import android.content.SharedPreferences;
import android.provider.Settings;
import android.util.Log;
import com.mentra.asg_client.AsgConstants;
import java.io.BufferedReader;
import java.io.FileReader;

/** Prevents a second legacy {@code mh_ota} authorization attempt during one glasses boot. */
final class BesOtaAuthorizationGate {
    private static final String TAG = "BesOtaAuthGate";
    private static final String LINUX_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

    private final Context context;
    private final BootIdProvider bootIdProvider;
    private final SharedPreferences preferences;

    BesOtaAuthorizationGate(Context context) {
        this(context, null);
    }

    BesOtaAuthorizationGate(Context context, BootIdProvider bootIdProvider) {
        this.context = context.getApplicationContext();
        this.bootIdProvider = bootIdProvider;
        this.preferences =
                this.context.getSharedPreferences(
                        AsgConstants.BES_OTA_AUTH_GATE_PREFS, Context.MODE_PRIVATE);
    }

    boolean isRetryBlockedThisBoot() {
        String current = currentBootId();
        String attempted = preferences.getString(AsgConstants.BES_OTA_AUTH_GATE_BOOT_ID_KEY, null);
        return current == null || current.equals(attempted);
    }

    /** Persist synchronously before the first authorization byte can reach BES. */
    boolean markAttemptedThisBoot() {
        String current = currentBootId();
        if (current == null) {
            Log.e(TAG, "Cannot prove the glasses boot identity; refusing BES OTA authorization");
            return false;
        }
        return preferences
                .edit()
                .putString(AsgConstants.BES_OTA_AUTH_GATE_BOOT_ID_KEY, current)
                .commit();
    }

    /** Clear only after an explicit denial or accepted apply proves the old raw-mode risk ended. */
    void clear() {
        preferences.edit().remove(AsgConstants.BES_OTA_AUTH_GATE_BOOT_ID_KEY).commit();
    }

    String currentBootId() {
        if (bootIdProvider != null) {
            return bootIdProvider.currentBootId();
        }
        try (BufferedReader reader = new BufferedReader(new FileReader(LINUX_BOOT_ID_PATH))) {
            String id = reader.readLine();
            if (id != null && !id.trim().isEmpty()) {
                return "linux:" + id.trim();
            }
        } catch (Exception e) {
            Log.w(TAG, "Linux boot_id unavailable; trying Android boot count", e);
        }

        try {
            int bootCount = Settings.Global.getInt(context.getContentResolver(), "boot_count");
            return "android:" + bootCount;
        } catch (Exception e) {
            Log.e(TAG, "No stable boot identity is available", e);
            return null;
        }
    }

    interface BootIdProvider {
        String currentBootId();
    }
}
