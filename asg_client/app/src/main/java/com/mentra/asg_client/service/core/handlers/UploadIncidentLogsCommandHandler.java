package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.reporting.GlassesLogBuffer;
import com.mentra.asg_client.reporting.incidentlogs.IncidentLogUploadScheduler;
import com.mentra.asg_client.reporting.incidentlogs.PendingIncidentLogStore;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Set;

/**
 * Handles the "upload_incident_logs" BLE command sent by the phone when a bug report is submitted.
 *
 * <p>Captures the current logcat snapshot to durable on-disk storage immediately,
 * then schedules a WorkManager job to upload when WiFi is available. This ensures
 * logs survive WiFi outages (e.g., STA torn down for SoftAP during gallery sync)
 * and reboots.</p>
 *
 * <p>The command handler never does HTTP directly. All upload logic lives in
 * {@link com.mentra.asg_client.reporting.incidentlogs.IncidentLogUploadWorker}.</p>
 */
public class UploadIncidentLogsCommandHandler implements ICommandHandler {

    private static final String TAG = "UploadIncidentLogsHandler";
    private static final int MAX_LOG_LINES = 400;

    private final Context mContext;
    private final IConfigurationManager mConfigurationManager;
    private final K900CommandHandler mK900CommandHandler;
    private final PendingIncidentLogStore mPendingStore;

    public UploadIncidentLogsCommandHandler(Context context,
                                            IConfigurationManager configurationManager,
                                            K900CommandHandler k900CommandHandler) {
        mContext = context;
        mConfigurationManager = configurationManager;
        mK900CommandHandler = k900CommandHandler;
        mPendingStore = new PendingIncidentLogStore(context);
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("upload_incident_logs");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        if (!"upload_incident_logs".equals(commandType)) {
            Log.e(TAG, "Unsupported command: " + commandType);
            return false;
        }

        String incidentId;
        try {
            incidentId = data.getString("incidentId");
            if (incidentId == null || incidentId.isEmpty()) {
                Log.e(TAG, "incidentId is missing from upload_incident_logs command");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to parse incidentId from command data", e);
            return false;
        }

        Log.i(TAG, "📋 Capturing glasses logs for incident: " + incidentId);

        // Capture + persist on worker thread (logcat exec blocks, don't block BLE thread)
        final String finalIncidentId = incidentId;
        new Thread(() -> {
            try {
                JSONArray logs = GlassesLogBuffer.getRecentLogs(MAX_LOG_LINES);
                mPendingStore.enqueue(finalIncidentId, "glasses", logs);
                IncidentLogUploadScheduler.scheduleDrain(mContext);
                Log.i(TAG, "✅ Glasses logs queued for incident " + finalIncidentId
                    + " (" + logs.length() + " entries)");
            } catch (Exception e) {
                Log.e(TAG, "Failed to queue glasses logs for " + finalIncidentId, e);
            }
        }).start();

        // Collect BES chip trace buffer and upload separately as "glasses_firmware"
        if (mK900CommandHandler != null) {
            mK900CommandHandler.requestBesLogs(finalIncidentId, mContext, mConfigurationManager);
        } else {
            Log.d(TAG, "K900CommandHandler not available — skipping BES log collection");
        }

        return true;
    }
}
