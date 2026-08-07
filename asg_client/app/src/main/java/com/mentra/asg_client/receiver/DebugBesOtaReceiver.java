package com.mentra.asg_client.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.di.hilt.AsgClientEntryPoint;
import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import dagger.hilt.android.EntryPointAccessors;
import java.io.File;
import java.util.Locale;

/**
 * Privileged receiver for testing validated BES firmware version changes through ADB.
 *
 * <p>The manifest requires {@code android.permission.DUMP}, which is available to ADB shell but not
 * ordinary applications. The caller supplies immutable identity metadata for the staged release
 * container; {@link OtaHelper} then uses the same validator and durable BES manager as the
 * phone-owned flow. This path intentionally permits explicit internal downgrades.
 */
public class DebugBesOtaReceiver extends BroadcastReceiver {
    private static final String TAG = "DebugBesOtaReceiver";
    public static final String ACTION_DEBUG_BES_OTA = "com.mentra.DEBUG_BES_OTA";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION_DEBUG_BES_OTA.equals(intent.getAction())) {
            return;
        }

        Log.w(TAG, "========================================");
        Log.w(TAG, "⚠️ DEBUG BES OTA TRIGGERED VIA ADB ⚠️");
        Log.w(TAG, "========================================");

        String targetVersion =
                intent.getStringExtra(AsgConstants.DEBUG_BES_OTA_TARGET_VERSION_EXTRA);
        String expectedSha256 = intent.getStringExtra(AsgConstants.DEBUG_BES_OTA_SHA256_EXTRA);
        String artifactId = intent.getStringExtra(AsgConstants.DEBUG_BES_OTA_ARTIFACT_ID_EXTRA);
        if (isBlank(targetVersion) || isBlank(expectedSha256) || isBlank(artifactId)) {
            Log.e(
                    TAG,
                    "❌ Missing required target_version, sha256, or artifact_id intent extra;"
                            + " use scripts/test-bes-ota.sh");
            return;
        }
        String normalizedSha256 = expectedSha256.trim().toLowerCase(Locale.US);
        if (!normalizedSha256.matches("[0-9a-f]{64}")) {
            Log.e(TAG, "❌ Invalid sha256 intent extra; use scripts/test-bes-ota.sh");
            return;
        }

        Context applicationContext = context.getApplicationContext();
        PendingResult pendingResult = goAsync();
        new Thread(
                        () -> {
                            File artifact =
                                    new File(
                                            AsgConstants.DEBUG_BES_OTA_ARTIFACT_PREFIX
                                                    + normalizedSha256
                                                    + ".bin");
                            boolean started = false;
                            try {
                                OtaHelper helper =
                                        EntryPointAccessors.fromApplication(
                                                        applicationContext,
                                                        AsgClientEntryPoint.class)
                                                .otaHelper();
                                started =
                                        helper.startValidatedDebugBesFirmware(
                                                artifact,
                                                targetVersion,
                                                normalizedSha256,
                                                artifactId);
                                if (started) {
                                    Log.i(
                                            TAG,
                                            "✅ Validated BES OTA started; monitor durable state"
                                                    + " through reboot");
                                } else {
                                    Log.e(TAG, "❌ Validated BES OTA was refused");
                                }
                            } catch (Exception e) {
                                Log.e(TAG, "❌ Debug BES OTA dispatch failed", e);
                            } finally {
                                pendingResult.finish();
                            }
                        },
                        "debug-bes-ota")
                .start();
    }

    private static boolean isBlank(String value) {
        return value == null || value.trim().isEmpty();
    }
}
