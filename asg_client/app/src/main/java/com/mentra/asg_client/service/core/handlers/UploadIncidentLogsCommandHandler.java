package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.io.bluetooth.interfaces.IBluetoothManager;
import com.mentra.asg_client.reporting.GlassesLogBuffer;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.utils.IncidentLogBleRelayNaming;
import com.mentra.asg_client.utils.IncidentUploadOkHttp;
import com.mentra.asg_client.utils.ServerConfigUtil;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * Handles the "upload_incident_logs" BLE command from the phone.
 *
 * <p>With WiFi: POSTs logcat and BES logs to the backend from the glasses (existing behavior).
 * Without WiFi: runs mh_logs to completion, then relays glasses_firmware and glasses JSON to the
 * phone via two sequential K900 BLE file transfers; the phone POSTs to the same API.</p>
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
     * handler construction, because {@link com.mentra.asg_client.service.core.ServiceContainer}
     * builds {@code CommandProcessor} before {@code AsgClientServiceManager#initialize()} creates
     * the Bluetooth manager.
     */
    private final AsgClientServiceManager mServiceManager;

    public UploadIncidentLogsCommandHandler(Context context,
                                            IConfigurationManager configurationManager,
                                            K900CommandHandler k900CommandHandler,
                                            IStateManager stateManager,
                                            AsgClientServiceManager serviceManager) {
        mContext = context;
        mConfigurationManager = configurationManager;
        mK900CommandHandler = k900CommandHandler;
        mStateManager = stateManager;
        mServiceManager = serviceManager;
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

            String baseUrl = (apiBaseUrl != null && !apiBaseUrl.isEmpty())
                    ? apiBaseUrl
                    : ServerConfigUtil.getServerBaseUrl(mContext);
            if (baseUrl == null || baseUrl.trim().isEmpty()) {
                Log.e(TAG, "No server base URL available — cannot upload incident logs");
                triggerBleFallback(incidentId, "http_missing_base_url");
                return;
            }
            String url = baseUrl + "/api/incidents/" + incidentId + "/logs";

            JSONArray logs = GlassesLogBuffer.getRecentLogs(MAX_LOG_LINES);

            JSONObject body = new JSONObject();
            body.put("source", "glasses");
            body.put("logs", logs);

            String bodyStr = body.toString();
            RequestBody requestBody = RequestBody.create(bodyStr, JSON_MEDIA_TYPE);

            OkHttpClient.Builder clientBuilder = new OkHttpClient.Builder()
                    .connectTimeout(15, TimeUnit.SECONDS)
                    .writeTimeout(30, TimeUnit.SECONDS)
                    .readTimeout(15, TimeUnit.SECONDS);
            IncidentUploadOkHttp.applyRelaxedRevocation(clientBuilder);
            OkHttpClient client = clientBuilder.build();

            Request request = new Request.Builder()
                    .url(url)
                    .header("Authorization", "Bearer " + coreToken)
                    .post(requestBody)
                    .build();

            int bodyPreviewLen = Math.min(bodyStr.length(), 1500);
            Log.i(TAG, "[LOGS] Glasses logs (logcat) full request: method=POST url=" + url
                    + " body.source=glasses body.logs.length=" + logs.length()
                    + " bodyPreview=" + (bodyStr.length() > bodyPreviewLen ? bodyStr.substring(0, bodyPreviewLen) + "..." : bodyStr));

            client.newCall(request).enqueue(new Callback() {
                @Override
                public void onFailure(Call call, IOException e) {
                    Log.e(TAG, "Failed to upload glasses logs for incident " + incidentId, e);
                    triggerBleFallback(incidentId, "http_onFailure");
                }

                @Override
                public void onResponse(Call call, Response response) {
                    if (response.isSuccessful()) {
                        Log.i(TAG, "✅ Glasses logs uploaded for incident " + incidentId
                                + " (" + logs.length() + " entries)");
                        if (mK900CommandHandler != null) {
                            mK900CommandHandler.requestBesLogs(
                                    incidentId, mContext, mConfigurationManager, apiBaseUrl);
                        }
                    } else {
                        Log.e(TAG, "❌ Server rejected glasses logs upload, status: "
                                + response.code() + " for incident " + incidentId);
                        triggerBleFallback(incidentId, "http_status_" + response.code());
                    }
                    response.close();
                }
            });

        } catch (Exception e) {
            Log.e(TAG, "Error preparing glasses logs upload for incident " + incidentId, e);
            triggerBleFallback(incidentId, "http_prepare_exception");
        }
    }

    private void triggerBleFallback(String incidentId, String reason) {
        Log.w(TAG, "Falling back to BLE relay for incident " + incidentId + " (" + reason + ")");
        new Thread(() -> relayLogsViaBle(incidentId)).start();
    }

    private void relayLogsViaBle(String incidentId) {
        IBluetoothManager bt = mServiceManager != null ? mServiceManager.getBluetoothManager() : null;
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

            CountDownLatch besDone = new CountDownLatch(1);
            AtomicReference<String> firmwareJson = new AtomicReference<>(null);

            if (mK900CommandHandler != null) {
                mK900CommandHandler.requestBesLogs(incidentId, mContext, mConfigurationManager,
                        json -> {
                            firmwareJson.set(json);
                            besDone.countDown();
                        });
            } else {
                besDone.countDown();
            }

            boolean besFinished = besDone.await(BES_WAIT_SEC, TimeUnit.SECONDS);
            if (!besFinished) {
                Log.w(TAG, "Timed out waiting for BES log collection — sending empty firmware payload");
            }
            String fwJson = firmwareJson.get();
            if (fwJson == null) {
                fwJson = com.mentra.asg_client.io.bes.log.BesLogManager.buildFirmwareUploadJson("");
            }

            String bName = IncidentLogBleRelayNaming.bleFileBaseName(incidentId, 'B');
            File bFile = new File(mContext.getCacheDir(), bName);
            writeUtf8File(bFile, fwJson);

            if (!bt.sendImageFile(bFile.getAbsolutePath())) {
                Log.e(TAG, "Failed to start BLE transfer for firmware log file " + bName);
                deleteQuietly(bFile);
                return;
            }
            boolean firmwareIdle = waitUntilFileTransferIdle(bt, FILE_TRANSFER_MAX_WAIT_MS);
            deleteQuietly(bFile);
            if (!firmwareIdle) {
                Log.e(TAG, "Timed out waiting for firmware BLE transfer — aborting relay for incident " + incidentId);
                return;
            }

            String logcatJson = buildGlassesLogcatJson();
            String lName = IncidentLogBleRelayNaming.bleFileBaseName(incidentId, 'L');
            File lFile = new File(mContext.getCacheDir(), lName);
            writeUtf8File(lFile, logcatJson);

            if (!bt.sendImageFile(lFile.getAbsolutePath())) {
                Log.e(TAG, "Failed to start BLE transfer for logcat file " + lName);
                deleteQuietly(lFile);
                return;
            }
            boolean logcatIdle = waitUntilFileTransferIdle(bt, FILE_TRANSFER_MAX_WAIT_MS);
            deleteQuietly(lFile);
            if (!logcatIdle) {
                Log.e(TAG, "Timed out waiting for logcat BLE transfer — relay incomplete for incident " + incidentId);
                return;
            }

            Log.i(TAG, "✅ BLE relay sequence completed for incident " + incidentId);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            Log.e(TAG, "BLE relay interrupted for incident " + incidentId, e);
        } catch (Exception e) {
            Log.e(TAG, "BLE relay failed for incident " + incidentId, e);
        }
    }

    private String buildGlassesLogcatJson() throws Exception {
        JSONArray logs = GlassesLogBuffer.getRecentLogs(MAX_LOG_LINES);
        JSONObject body = new JSONObject();
        body.put("source", "glasses");
        body.put("logs", logs);
        return body.toString();
    }

    private static void writeUtf8File(File file, String utf8) throws IOException {
        try (FileOutputStream fos = new FileOutputStream(file)) {
            fos.write(utf8.getBytes(StandardCharsets.UTF_8));
            fos.flush();
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
     * @return {@code true} if the transfer became idle within the deadline,
     *         {@code false} if the deadline was reached while still in progress
     */
    private boolean waitUntilFileTransferIdle(IBluetoothManager bt, long maxWaitMs)
            throws InterruptedException {
        long deadline = System.currentTimeMillis() + maxWaitMs;
        while (bt.isFileTransferInProgress()
                && System.currentTimeMillis() < deadline) {
            Thread.sleep(FILE_TRANSFER_IDLE_POLL_MS);
        }
        return !bt.isFileTransferInProgress();
    }
}
