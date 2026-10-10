package com.mentra.asg_client.service.core.handlers;

import android.util.Log;

import com.mentra.asg_client.io.bes.log.BesIncidentAccessProvider;
import com.mentra.asg_client.io.bes.log.BesIncidentUploadAccess;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;

import org.json.JSONObject;

import java.util.Set;
import java.util.function.Supplier;

/**
 * Handles {@code bes_crash_reported} from the phone (OS-1988 contract section 8): persists the
 * Cloud {@code reportId} and {@code REPORTED} for the incident, then replies
 * {@code bes_crash_reported_ack}. Repeats with the same reportId are acked again; an unknown
 * incident is acked with {@code ok:false, error:"unknown_incident"}.
 */
public class BesCrashReportedCommandHandler implements ICommandHandler {
    private static final String TAG = "BesCrashReportedHandler";

    private final ICommunicationManager mCommunicationManager;
    private final Supplier<BesIncidentUploadAccess> mAccess;

    public BesCrashReportedCommandHandler(ICommunicationManager communicationManager) {
        this(communicationManager, BesIncidentAccessProvider::get);
    }

    BesCrashReportedCommandHandler(
            ICommunicationManager communicationManager, Supplier<BesIncidentUploadAccess> access) {
        mCommunicationManager = communicationManager;
        mAccess = access;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("bes_crash_reported");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        if (!"bes_crash_reported".equals(commandType) || data == null) {
            return false;
        }
        String incidentKey = data.optString("incidentKey", "");
        String reportId = data.optString("reportId", "");
        if (incidentKey.isEmpty()) {
            Log.w(TAG, "bes_crash_reported without incidentKey");
            return false;
        }

        boolean ok = false;
        String error = null;
        try {
            BesIncidentUploadAccess access = mAccess.get();
            JSONObject record = access != null ? access.find(incidentKey) : null;
            if (record == null) {
                error = "unknown_incident";
            } else if (reportId.isEmpty()) {
                error = "invalid_report_id";
            } else if (reportId.equals(persistedReportId(record))) {
                ok = true; // Repeat of an already persisted report: idempotent.
            } else if (access.markReported(incidentKey, reportId)) {
                ok = true;
            } else {
                String state = record.optString("state", "");
                error = "EVICTED".equals(state) ? "unknown_incident" : "report_id_conflict";
            }
        } catch (RuntimeException e) {
            Log.e(TAG, "bes_crash_reported failed for " + incidentKey, e);
            error = "internal_error";
        }
        Log.i(TAG, "bes_crash_reported " + incidentKey + " -> ok=" + ok
                + (error != null ? " error=" + error : ""));
        return sendAck(incidentKey, reportId, ok, error);
    }

    private static String persistedReportId(JSONObject record) {
        return record.isNull("reportId") ? "" : record.optString("reportId", "");
    }

    private boolean sendAck(String incidentKey, String reportId, boolean ok, String error) {
        try {
            JSONObject ack = new JSONObject();
            ack.put("type", "bes_crash_reported_ack");
            ack.put("incidentKey", incidentKey);
            ack.put("reportId", reportId);
            ack.put("ok", ok);
            if (!ok && error != null) {
                ack.put("error", error);
            }
            return mCommunicationManager != null
                    && mCommunicationManager.sendBluetoothResponse(ack);
        } catch (Exception e) {
            Log.e(TAG, "Could not send bes_crash_reported_ack", e);
            return false;
        }
    }
}
