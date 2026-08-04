package com.mentra.asg_client.io.bes;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesUartTransportCoordinator;
import java.io.BufferedReader;
import java.io.FileReader;

/** Prevents a second legacy {@code mh_ota} authorization attempt during one glasses boot. */
public final class BesOtaAuthorizationGate implements BesUartTransportCoordinator.OtaSafetyState {
    private static final String TAG = "BesOtaAuthGate";
    private static final String LINUX_BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
    private static final Object RESERVATION_LOCK = new Object();

    private final BootIdProvider bootIdProvider;
    private final SharedPreferences preferences;

    public enum PostApplyVerification {
        NOT_PENDING,
        VERIFIED,
        VERSION_MISMATCH,
        PERSISTENCE_FAILURE
    }

    public BesOtaAuthorizationGate(Context context) {
        this(context, null);
    }

    BesOtaAuthorizationGate(Context context, BootIdProvider bootIdProvider) {
        this.bootIdProvider = bootIdProvider;
        this.preferences =
                context.getApplicationContext()
                        .getSharedPreferences(
                                AsgConstants.BES_OTA_AUTH_GATE_PREFS, Context.MODE_PRIVATE);
    }

    boolean isRetryBlockedThisBoot() {
        synchronized (RESERVATION_LOCK) {
            String current = currentBootId();
            String attempted = attemptedBootId();
            return current == null || current.equals(attempted);
        }
    }

    /**
     * Atomically reserve and persist this boot before the first authorization byte can reach BES.
     */
    boolean tryReserveCurrentBoot(String targetVersion) {
        synchronized (RESERVATION_LOCK) {
            String current = currentBootId();
            if (current == null) {
                Log.e(
                        TAG,
                        "Cannot prove the glasses boot identity; refusing BES OTA authorization");
                return false;
            }
            if (current.equals(attemptedBootId())) {
                Log.e(TAG, "BES OTA authorization is already reserved for this glasses boot");
                return false;
            }
            String target = canonicalExactTargetVersion(targetVersion);
            if (target == null) {
                Log.e(TAG, "Cannot reserve BES OTA without an exact dotted target version");
                return false;
            }
            return preferences
                    .edit()
                    .putString(AsgConstants.BES_OTA_AUTH_GATE_BOOT_ID_KEY, current)
                    .putString(AsgConstants.BES_OTA_AUTH_GATE_TARGET_VERSION_KEY, target)
                    .putBoolean(AsgConstants.BES_OTA_AUTH_GATE_APPLY_PENDING_KEY, false)
                    .commit();
        }
    }

    /** Persist the apply phase before releasing raw OTA ownership for BES reboot discovery. */
    boolean markApplyPending() {
        synchronized (RESERVATION_LOCK) {
            String current = currentBootId();
            if (current == null
                    || !current.equals(attemptedBootId())
                    || expectedTargetVersionLocked().isEmpty()) {
                return false;
            }
            return preferences
                    .edit()
                    .putBoolean(AsgConstants.BES_OTA_AUTH_GATE_APPLY_PENDING_KEY, true)
                    .commit();
        }
    }

    /** Clear only after explicit denial or post-reboot normal-mode version proof. */
    boolean clear() {
        synchronized (RESERVATION_LOCK) {
            return clearLocked();
        }
    }

    /** Restore fail-closed UART quarantine after an ASG process or serial-session restart. */
    @Override
    public boolean isQuarantinedForCurrentBoot() {
        synchronized (RESERVATION_LOCK) {
            String attempted = attemptedBootId();
            if (attempted == null) {
                return false;
            }
            String current = currentBootId();
            return current == null || current.equals(attempted);
        }
    }

    @Override
    public boolean isPostApplyVerificationPendingForCurrentBoot() {
        synchronized (RESERVATION_LOCK) {
            String current = currentBootId();
            return current != null
                    && current.equals(attemptedBootId())
                    && preferences.getBoolean(
                            AsgConstants.BES_OTA_AUTH_GATE_APPLY_PENDING_KEY, false);
        }
    }

    public String getExpectedTargetVersion() {
        synchronized (RESERVATION_LOCK) {
            return expectedTargetVersionLocked();
        }
    }

    /** Consume one post-reboot version proof and clear the interlock only durably. */
    public PostApplyVerification verifyPostApplyVersion(String actualVersion) {
        synchronized (RESERVATION_LOCK) {
            if (!isPostApplyVerificationPendingForCurrentBoot()) {
                return PostApplyVerification.NOT_PENDING;
            }
            String expected = expectedTargetVersionLocked();
            String actual = canonicalExactTargetVersion(actualVersion);
            boolean matches = expected.equals(actual);
            if (!clearLocked()) {
                return PostApplyVerification.PERSISTENCE_FAILURE;
            }
            return matches
                    ? PostApplyVerification.VERIFIED
                    : PostApplyVerification.VERSION_MISMATCH;
        }
    }

    /** Convert a timed-out verification into durable quarantine for the rest of this boot. */
    public boolean abandonPostApplyVerification() {
        synchronized (RESERVATION_LOCK) {
            if (!isPostApplyVerificationPendingForCurrentBoot()) {
                return true;
            }
            return preferences
                    .edit()
                    .putBoolean(AsgConstants.BES_OTA_AUTH_GATE_APPLY_PENDING_KEY, false)
                    .commit();
        }
    }

    private String attemptedBootId() {
        return preferences.getString(AsgConstants.BES_OTA_AUTH_GATE_BOOT_ID_KEY, null);
    }

    private String expectedTargetVersionLocked() {
        return preferences.getString(AsgConstants.BES_OTA_AUTH_GATE_TARGET_VERSION_KEY, "").trim();
    }

    private boolean clearLocked() {
        return preferences
                .edit()
                .remove(AsgConstants.BES_OTA_AUTH_GATE_BOOT_ID_KEY)
                .remove(AsgConstants.BES_OTA_AUTH_GATE_TARGET_VERSION_KEY)
                .remove(AsgConstants.BES_OTA_AUTH_GATE_APPLY_PENDING_KEY)
                .commit();
    }

    /**
     * Canonical four-byte firmware identity used by release metadata and the embedded image.
     * Runtime feature gates tolerate display suffixes, but a suffixed value cannot be proven from
     * the four version bytes validated in the OTA artifact and therefore remains inadmissible here.
     */
    static String canonicalExactTargetVersion(String value) {
        if (value == null) {
            return null;
        }
        String[] parts = value.trim().split("\\.", -1);
        if (parts.length != 4) {
            return null;
        }
        StringBuilder canonical = new StringBuilder();
        for (String part : parts) {
            if (!part.matches("\\d{1,3}")) {
                return null;
            }
            int component;
            try {
                component = Integer.parseInt(part);
            } catch (NumberFormatException e) {
                return null;
            }
            if (component > 255) {
                return null;
            }
            if (canonical.length() > 0) {
                canonical.append('.');
            }
            canonical.append(component);
        }
        return canonical.toString();
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
            Log.e(TAG, "Stable Linux boot identity is unavailable", e);
            return null;
        }
        Log.e(TAG, "Stable Linux boot identity is empty");
        return null;
    }

    interface BootIdProvider {
        String currentBootId();
    }
}
