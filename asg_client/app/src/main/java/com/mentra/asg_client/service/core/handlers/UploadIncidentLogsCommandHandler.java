package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.io.bes.log.BesIncidentUploader;
import com.mentra.asg_client.io.bes.log.BesLivenessLog;
import com.mentra.asg_client.io.bes.log.BesLogManager;
import com.mentra.asg_client.io.bluetooth.interfaces.IBluetoothManager;
import com.mentra.asg_client.io.ota.utils.OtaHttpRequest;
import com.mentra.asg_client.reporting.GlassesLogBuffer;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.utils.IncidentLogBleRelayNaming;
import com.mentra.asg_client.utils.IncidentUploadOkHttp;
import com.mentra.asg_client.utils.ServerConfigUtil;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.concurrent.TimeUnit;

/**
 * Handles the "upload_incident_logs" BLE command from the phone.
 *
 * <p>With WiFi: POSTs logcat and BES logs to the backend from the glasses (existing behavior).
 * Without WiFi: runs mh_logs to completion, then relays glasses_firmware and glasses JSON to the
 * phone via two sequential K900 BLE file transfers; the phone POSTs to the same API.
 *
 * <p>When the report id belongs to a persisted BES incident (OS-1988), the glasses_firmware
 * artifact is that incident's stored bundle instead (see {@link BesIncidentUploader}); such an
 * incident never falls back to a fresh mh_logs. Any other report id keeps the behavior above.
 */
public class UploadIncidentLogsCommandHandler implements ICommandHandler {

    private static final String TAG = "UploadIncidentLogsHandler";
    private static final int MAX_LOG_LINES = 600;
    private static final long BES_WAIT_SEC = 25;
    private static final long FILE_TRANSFER_IDLE_POLL_MS = 50;
    private static final long FILE_TRANSFER_MAX_WAIT_MS = 120_000;
    private static final long PRE_TRANSFER_CLEAR_WAIT_MS = 10_000;

    private static final MediaType JSON_MEDIA_TYPE =
            MediaType.parse("application/json; charset=utf-8");

    private final Context mContext;
    private final IConfigurationManager mConfigurationManager;
    private final K900CommandHandler mK900CommandHandler;
    private final IStateManager mStateManager;

    /**
     * Resolved at command time via {@link AsgClientServiceManager#getBluetoothManager()} — not at
     * handler construction, because {@link com.mentra.asg_client.service.core.ServiceInitializer}
     * builds {@code CommandProcessor} before {@code AsgClientServiceManager#initialize()} creates
     * the Bluetooth manager.
     */
    private final AsgClientServiceManager mServiceManager;

    private final BesIncidentUploader mIncidentUploader;
    private final BesIncidentUploader.HttpPoster mHttpPoster;

    /** Where the glasses_firmware artifact of a report comes from. */
    private enum FirmwareSource {
        /** A normal user report: TRACE store or a fresh mh_logs dump. */
        LEGACY,
        /** A persisted BES incident that still has to be uploaded. */
        INCIDENT,
        /** A BES incident that is already uploaded or evicted: never fall back to mh_logs. */
        NONE
    }

    public UploadIncidentLogsCommandHandler(
            Context context,
            IConfigurationManager configurationManager,
            K900CommandHandler k900CommandHandler,
            IStateManager stateManager,
            AsgClientServiceManager serviceManager) {
        this(
                context,
                configurationManager,
                k900CommandHandler,
                stateManager,
                serviceManager,
                BesIncidentUploader.shared(),
                new OkHttpPoster());
    }

    UploadIncidentLogsCommandHandler(
            Context context,
            IConfigurationManager configurationManager,
            K900CommandHandler k900CommandHandler,
            IStateManager stateManager,
            AsgClientServiceManager serviceManager,
            BesIncidentUploader incidentUploader,
            BesIncidentUploader.HttpPoster httpPoster) {
        mContext = context;
        mConfigurationManager = configurationManager;
        mK900CommandHandler = k900CommandHandler;
        mStateManager = stateManager;
        mServiceManager = serviceManager;
        mIncidentUploader = incidentUploader;
        mHttpPoster = httpPoster;
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

        Log.i(TAG, "📋 Incident logs for: " + incidentId);

        final String finalIncidentId = incidentId;
        final String apiBaseUrl = data.optString("apiBaseUrl", "").trim();
        boolean wifi = mStateManager != null && mStateManager.isConnectedToWifi();

        if (wifi) {
            new Thread(() -> uploadLogsOverHttp(finalIncidentId, apiBaseUrl)).start();
        } else {
            new Thread(() -> relayLogsViaBle(finalIncidentId)).start();
        }

        return true;
    }

    private void uploadLogsOverHttp(String incidentId, String apiBaseUrl) {
        try {
            String coreToken = mConfigurationManager.getCoreToken();
            if (coreToken == null || coreToken.isEmpty()) {
                Log.e(TAG, "No coreToken available — cannot upload incident logs");
                triggerBleFallback(incidentId, "http_missing_core_token");
                return;
            }

            String baseUrl =
                    (apiBaseUrl != null && !apiBaseUrl.isEmpty())
                            ? apiBaseUrl
                            : ServerConfigUtil.getServerBaseUrl(mContext);
            if (baseUrl == null || baseUrl.trim().isEmpty()) {
                Log.e(TAG, "No server base URL available — cannot upload incident logs");
                triggerBleFallback(incidentId, "http_missing_base_url");
                return;
            }
            String url = buildReportArtifactsUrl(baseUrl, incidentId);

            JSONArray logs = buildGlassesLogEntries();

            JSONObject body = new JSONObject();
            body.put("type", "logs");
            body.put("source", "glasses");
            body.put("entries", logs);

            String bodyStr = body.toString();
            RequestBody requestBody = RequestBody.create(bodyStr, JSON_MEDIA_TYPE);

            OkHttpClient.Builder clientBuilder =
                    new OkHttpClient.Builder()
                            .connectTimeout(15, TimeUnit.SECONDS)
                            .writeTimeout(30, TimeUnit.SECONDS)
                            .readTimeout(15, TimeUnit.SECONDS);
            IncidentUploadOkHttp.applyRelaxedRevocation(clientBuilder);
            OkHttpClient client = clientBuilder.build();

            Request request =
                    new Request.Builder()
                            .url(url)
                            .header("Authorization", "Bearer " + coreToken)
                            .post(requestBody)
                            .build();

            int bodyPreviewLen = Math.min(bodyStr.length(), 1500);
            Log.i(
                    TAG,
                    "[LOGS] Glasses logs (logcat) full request: method=POST url="
                            + url
                            + " body.source=glasses body.entries.length="
                            + logs.length()
                            + " bodyPreview="
                            + (bodyStr.length() > bodyPreviewLen
                                    ? bodyStr.substring(0, bodyPreviewLen) + "..."
                                    : bodyStr));

            client.newCall(request)
                    .enqueue(
                            new Callback() {
                                @Override
                                public void onFailure(Call call, IOException e) {
                                    Log.e(
                                            TAG,
                                            "Failed to upload glasses logs for incident "
                                                    + incidentId,
                                            e);
                                    triggerBleFallback(incidentId, "http_onFailure");
                                }

                                @Override
                                public void onResponse(Call call, Response response) {
                                    if (response.isSuccessful()) {
                                        Log.i(
                                                TAG,
                                                "✅ Glasses logs uploaded for incident "
                                                        + incidentId
                                                        + " ("
                                                        + logs.length()
                                                        + " entries)");
                                        onGlassesLogsUploaded(incidentId, apiBaseUrl);
                                    } else {
                                        Log.e(
                                                TAG,
                                                "❌ Server rejected glasses logs upload, status: "
                                                        + response.code()
                                                        + " for incident "
                                                        + incidentId);
                                        triggerBleFallback(
                                                incidentId, "http_status_" + response.code());
                                    }
                                    response.close();
                                }
                            });

        } catch (Exception e) {
            Log.e(TAG, "Error preparing glasses logs upload for incident " + incidentId, e);
            triggerBleFallback(incidentId, "http_prepare_exception");
        }
    }

    private FirmwareSource firmwareSourceFor(String reportId) {
        JSONObject incident = mIncidentUploader.findByReportId(reportId);
        if (incident == null) {
            // An evicted or already-deleted incident has no data left; the BES ring now holds
            // something else, so it is not uploaded in its place.
            return mIncidentUploader.isRetiredReport(reportId)
                    ? FirmwareSource.NONE
                    : FirmwareSource.LEGACY;
        }
        return BesIncidentUploader.isUploadable(incident)
                ? FirmwareSource.INCIDENT
                : FirmwareSource.NONE;
    }

    /** The Java logs are up over HTTP; now the glasses_firmware artifact. */
    private void onGlassesLogsUploaded(String incidentId, String apiBaseUrl) {
        FirmwareSource source = firmwareSourceFor(incidentId);
        if (source == FirmwareSource.INCIDENT) {
            new Thread(() -> uploadIncidentFirmwareOverHttp(incidentId, apiBaseUrl)).start();
        } else if (source == FirmwareSource.LEGACY && mK900CommandHandler != null) {
            // Same monitor-coordinated capture as the BLE relay, so the two never share a session.
            new Thread(() -> captureBesLogsOverHttp(incidentId, apiBaseUrl)).start();
        }
    }

    /**
     * Uploads the persisted full body of a BES incident. {@code UPLOADED} is set only on an HTTP
     * 2xx; any other outcome leaves the incident {@code REPORTED} and falls back to the BLE relay
     * of the (separately persisted) relay body.
     */
    void uploadIncidentFirmwareOverHttp(String reportId, String apiBaseUrl) {
        JSONObject incident = mIncidentUploader.findByReportId(reportId);
        if (!BesIncidentUploader.isUploadable(incident)) {
            Log.w(TAG, "Report " + reportId + " has no uploadable BES incident");
            return;
        }
        String incidentKey = incident.optString("incidentKey", "");
        try {
            String coreToken = mConfigurationManager.getCoreToken();
            String baseUrl =
                    (apiBaseUrl != null && !apiBaseUrl.isEmpty())
                            ? apiBaseUrl
                            : ServerConfigUtil.getServerBaseUrl(mContext);
            if (coreToken == null
                    || coreToken.isEmpty()
                    || baseUrl == null
                    || baseUrl.trim().isEmpty()) {
                Log.e(TAG, "No token or base URL for BES incident upload " + incidentKey);
            } else if (mIncidentUploader.uploadOverHttp(
                    incidentKey,
                    buildReportArtifactsUrl(baseUrl, reportId),
                    coreToken,
                    mHttpPoster)) {
                return;
            }
        } catch (Exception e) {
            Log.e(TAG, "BES incident HTTP upload failed for " + incidentKey, e);
        }
        Log.w(TAG, "Falling back to BLE relay for BES incident " + incidentKey);
        relayIncidentFirmwareOnly(reportId);
    }

    /** BLE relay of the firmware body alone (the Java logs already went over HTTP). */
    void relayIncidentFirmwareOnly(String reportId) {
        IBluetoothManager bt =
                mServiceManager != null ? mServiceManager.getBluetoothManager() : null;
        if (bt == null || !bt.isConnected()) {
            Log.e(TAG, "BLE not available — BES incident stays REPORTED for " + reportId);
            return;
        }
        try {
            waitUntilFileTransferIdle(bt, PRE_TRANSFER_CLEAR_WAIT_MS);
            if (bt.isFileTransferInProgress()) {
                Log.e(TAG, "File transfer still active — abort BES incident relay");
                return;
            }
            relayIncidentFirmware(bt, reportId);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            Log.e(TAG, "BES incident relay interrupted for " + reportId, e);
        } catch (Exception e) {
            Log.e(TAG, "BES incident relay failed for " + reportId, e);
        }
    }

    private void relayIncidentFirmware(IBluetoothManager bt, String reportId)
            throws InterruptedException {
        JSONObject incident = mIncidentUploader.findByReportId(reportId);
        if (!BesIncidentUploader.isUploadable(incident)) {
            return;
        }
        BesIncidentUploader.Prepared prepared =
                mIncidentUploader.prepare(
                        incident.optString("incidentKey", ""),
                        BesIncidentUploader.ARTIFACT_RELAY);
        if (prepared == null) {
            Log.w(TAG, "No relay body for BES incident of report " + reportId);
            return;
        }
        // The phone confirms with transfer_complete after its own POST; only that marks UPLOADED.
        relayFileViaBle(bt, reportId, "glasses_firmware", 'B', prepared.bytes);
    }

    private void triggerBleFallback(String incidentId, String reason) {
        Log.w(TAG, "Falling back to BLE relay for incident " + incidentId + " (" + reason + ")");
        new Thread(() -> relayLogsViaBle(incidentId)).start();
    }

    synchronized void captureBesLogsOverHttp(String incidentId, String apiBaseUrl) {
        if (mK900CommandHandler == null) return;
        try {
            BesLogManager session =
                    mK900CommandHandler.requestBesLogs(
                            incidentId, mContext, mConfigurationManager, apiBaseUrl, null);
            awaitBesCapture(session, incidentId);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            Log.e(TAG, "HTTP incident BES capture interrupted for " + incidentId, e);
        }
    }

    private void awaitBesCapture(BesLogManager session, String incidentId)
            throws InterruptedException {
        if (session != null && !session.awaitCollection(BES_WAIT_SEC, TimeUnit.SECONDS)) {
            Log.w(TAG, "Incident BES capture wait expired after partial settlement: " + incidentId);
        }
    }

    // Both reports share one BES capture session and one BLE file-transfer slot.
    // Hold this handler's monitor for the complete B/L transaction, not just its idle check.
    synchronized void relayLogsViaBle(String incidentId) {
        IBluetoothManager bt =
                mServiceManager != null ? mServiceManager.getBluetoothManager() : null;
        if (bt == null) {
            Log.e(TAG, "No BluetoothManager — cannot BLE-relay incident logs");
            return;
        }
        if (!bt.isConnected()) {
            Log.e(TAG, "BLE not connected — cannot BLE-relay incident logs");
            return;
        }

        try {
            waitUntilFileTransferIdle(bt, PRE_TRANSFER_CLEAR_WAIT_MS);
            if (bt.isFileTransferInProgress()) {
                Log.e(TAG, "File transfer still active — abort BLE incident relay");
                return;
            }

            FirmwareSource firmwareSource = firmwareSourceFor(incidentId);
            if (firmwareSource != FirmwareSource.LEGACY) {
                if (firmwareSource == FirmwareSource.INCIDENT) {
                    relayIncidentFirmware(bt, incidentId);
                }
                relayGlassesLogcat(bt, incidentId);
                return;
            }

            BesLogManager session = null;
            if (mK900CommandHandler != null) {
                // Select BLE delivery; the exact session supplies its frozen JSON after settlement,
                // independently from callback scheduling or the handler's ownership monitor.
                session = mK900CommandHandler.requestBesLogs(
                        incidentId, mContext, mConfigurationManager, "", json -> {});
            }
            awaitBesCapture(session, incidentId);
            String fwJson = session != null
                    ? session.getCollectedFirmwareJson()
                    : BesLogManager.buildFirmwareUploadJson("");

            relayFileViaBle(bt, incidentId, "glasses_firmware", 'B', fwJson);
            relayGlassesLogcat(bt, incidentId);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            Log.e(TAG, "BLE relay interrupted for incident " + incidentId, e);
        } catch (Exception e) {
            Log.e(TAG, "BLE relay failed for incident " + incidentId, e);
        }
    }

    /**
     * A refused or failed firmware transfer must not discard independent Java logs. Only a freshly
     * connected, idle transport can start the next file; never clear it.
     */
    private void relayGlassesLogcat(IBluetoothManager bt, String incidentId)
            throws Exception {
        boolean connected = bt.isConnected();
        boolean transferActive = bt.isFileTransferInProgress();
        if (!connected || transferActive) {
            Log.w(
                    TAG,
                    "Incident BLE relay incidentId="
                            + incidentId
                            + " source=glasses stage=not_started connected="
                            + connected
                            + " transferActive="
                            + transferActive);
            return;
        }

        relayFileViaBle(bt, incidentId, "glasses", 'L', buildGlassesLogcatJson());
    }

    private void relayFileViaBle(
            IBluetoothManager bt, String incidentId, String source, char prefix, String json)
            throws InterruptedException {
        relayFileViaBle(bt, incidentId, source, prefix, json.getBytes(StandardCharsets.UTF_8));
    }

    private void relayFileViaBle(
            IBluetoothManager bt, String incidentId, String source, char prefix, byte[] payload)
            throws InterruptedException {
        File file =
                new File(
                        mContext.getCacheDir(),
                        IncidentLogBleRelayNaming.bleFileBaseName(incidentId, prefix));
        String diagnostic = "Incident BLE relay incidentId=" + incidentId + " source=" + source;
        try {
            if (Thread.currentThread().isInterrupted()) {
                throw new InterruptedException(
                        "Incident BLE relay was interrupted before transfer");
            }
            writeBytes(file, payload);
            boolean connected = bt.isConnected();
            boolean transferActive = bt.isFileTransferInProgress();
            if (!connected || transferActive) {
                Log.w(
                        TAG,
                        diagnostic
                                + " stage=not_started connected="
                                + connected
                                + " transferActive="
                                + transferActive);
                return;
            }
            boolean started = bt.sendFile(file.getAbsolutePath());
            if (Thread.currentThread().isInterrupted()) {
                throw new InterruptedException("Incident BLE transfer startup was interrupted");
            }
            if (!started) {
                Log.w(TAG, diagnostic + " stage=start_refused");
                return;
            }
            Log.i(TAG, diagnostic + " stage=started");
            boolean idle = waitUntilFileTransferIdle(bt, FILE_TRANSFER_MAX_WAIT_MS);
            // Idle also follows transfer failure. This is transport settlement, not an upload ACK.
            if (idle) {
                Log.i(TAG, diagnostic + " stage=settled");
            } else {
                Log.w(TAG, diagnostic + " stage=wait_expired");
            }
        } catch (InterruptedException e) {
            Log.w(TAG, diagnostic + " stage=interrupted");
            throw e;
        } catch (Exception e) {
            Log.e(TAG, diagnostic + " stage=failed", e);
        } finally {
            deleteQuietly(file);
        }
    }

    private String buildGlassesLogcatJson() throws Exception {
        JSONArray logs = buildGlassesLogEntries();
        JSONObject body = new JSONObject();
        body.put("type", "logs");
        body.put("source", "glasses");
        body.put("entries", logs);
        return body.toString();
    }

    /**
     * Merges the logcat tail with the BES liveness and retained OTA request rings, oldest first.
     *
     * <p>{@link #MAX_LOG_LINES} deliberately stays small because the BLE relay path has to push
     * this whole payload over a K900 file transfer. That window cannot hold a BES fault: the
     * reboot's BLE re-handshake and stream teardown emit thousands of lines afterwards and evict
     * it. {@link BesLivenessLog} is kept out of band for exactly that reason, so splice it back in
     * here rather than widening the tail.
     */
    private JSONArray buildGlassesLogEntries() {
        JSONArray logcat = GlassesLogBuffer.getRecentLogs(MAX_LOG_LINES);
        JSONArray liveness = BesLivenessLog.recentEntries();
        return mergeByTimestamp(
                mergeByTimestamp(logcat, liveness), OtaHttpRequest.recentEntries(mContext));
    }

    /** Both inputs are already ascending by timestamp, so a single pass interleaves them. */
    private static JSONArray mergeByTimestamp(JSONArray left, JSONArray right) {
        JSONArray merged = new JSONArray();
        int i = 0;
        int j = 0;
        while (i < left.length() && j < right.length()) {
            if (timestampOf(left, i) <= timestampOf(right, j)) {
                merged.put(left.opt(i++));
            } else {
                merged.put(right.opt(j++));
            }
        }
        while (i < left.length()) {
            merged.put(left.opt(i++));
        }
        while (j < right.length()) {
            merged.put(right.opt(j++));
        }
        return merged;
    }

    private static long timestampOf(JSONArray entries, int index) {
        JSONObject entry = entries.optJSONObject(index);
        return entry != null ? entry.optLong("timestamp", 0L) : 0L;
    }

    private static String buildReportArtifactsUrl(String baseUrl, String reportId) {
        String trimmed = baseUrl != null ? baseUrl.trim() : "";
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        return trimmed + "/api/client/reports/" + reportId + "/artifacts";
    }

    private static void writeBytes(File file, byte[] bytes) throws IOException {
        try (FileOutputStream fos = new FileOutputStream(file)) {
            fos.write(bytes);
            fos.flush();
        }
    }

    /** Synchronous OkHttp POST; the status code decides whether an incident is uploaded. */
    private static final class OkHttpPoster implements BesIncidentUploader.HttpPoster {
        @Override
        public int post(String url, String bearerToken, byte[] body) throws IOException {
            OkHttpClient.Builder clientBuilder =
                    new OkHttpClient.Builder()
                            .connectTimeout(15, TimeUnit.SECONDS)
                            .writeTimeout(45, TimeUnit.SECONDS)
                            .readTimeout(60, TimeUnit.SECONDS);
            IncidentUploadOkHttp.applyRelaxedRevocation(clientBuilder);
            Request request =
                    new Request.Builder()
                            .url(url)
                            .header("Authorization", "Bearer " + bearerToken)
                            .post(RequestBody.create(body, JSON_MEDIA_TYPE))
                            .build();
            try (Response response = clientBuilder.build().newCall(request).execute()) {
                return response.code();
            }
        }
    }

    private static void deleteQuietly(File f) {
        if (f != null && f.exists() && !f.delete()) {
            Log.w(TAG, "Could not delete temp relay file: " + f.getAbsolutePath());
        }
    }

    /**
     * Polls until the BLE file transfer becomes idle or {@code maxWaitMs} elapses.
     *
     * @return {@code true} if the transfer became idle within the deadline, {@code false} if the
     *     deadline was reached while still in progress
     */
    boolean waitUntilFileTransferIdle(IBluetoothManager bt, long maxWaitMs)
            throws InterruptedException {
        long deadline = System.currentTimeMillis() + maxWaitMs;
        while (bt.isFileTransferInProgress() && System.currentTimeMillis() < deadline) {
            Thread.sleep(FILE_TRANSFER_IDLE_POLL_MS);
        }
        return !bt.isFileTransferInProgress();
    }
}
