package com.mentra.asg_client.service.core.processors;

import android.util.Log;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.communication.reliability.ReliableMessageManager;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Response sender component following Single Responsibility Principle.
 * <p>
 * This class is responsible for sending various types of responses
 * over Bluetooth Low Energy (BLE) communication with optional reliability.
 */
public class ResponseSender {
    private static final String TAG = "ResponseSender";

    private final AsgClientServiceManager serviceManager;
    private final ReliableMessageManager reliableManager;

    /**
     * Constructor for ResponseSender.
     *
     * @param serviceManager The service manager for accessing Bluetooth functionality
     */
    public ResponseSender(AsgClientServiceManager serviceManager) {
        this.serviceManager = serviceManager;

        // Initialize reliability manager - use 'this.serviceManager' to always get current reference
        this.reliableManager = new ReliableMessageManager(
            data -> {
                if (this.serviceManager != null &&
                    this.serviceManager.getBluetoothManager() != null) {
                    return this.serviceManager.getBluetoothManager().sendData(data);
                }
                return false;
            }
        );

        // Enable by default - worst case with old phones is just some extra retries
        this.reliableManager.setEnabled(true, 1);

        Log.d(TAG, "✅ Response sender initialized with reliability support");
    }

    /**
     * Get the reliable message manager (for CommandProcessor to handle ACKs).
     * @return The ReliableMessageManager instance
     */
    public ReliableMessageManager getReliableManager() {
        return reliableManager;
    }

    /**
     * Send download progress notification over BLE.
     *
     * @param status          The status of the download (e.g., "started", "completed", "failed")
     * @param progress        The download progress percentage (0-100)
     * @param bytesDownloaded The number of bytes downloaded so far
     * @param totalBytes      The total number of bytes to download
     * @param errorMessage    Error message if download failed, null otherwise
     * @param timestamp       The timestamp of the progress update
     */
    public void sendDownloadProgress(String status, int progress, long bytesDownloaded, long totalBytes, String errorMessage, long timestamp) {
        if (!isBluetoothConnected()) {
            Log.d(TAG, "Cannot send download progress - not connected to BLE device");
            return;
        }

        try {
            JSONObject downloadProgress = new JSONObject();
            downloadProgress.put("type", "ota_download_progress");
            downloadProgress.put("status", status);
            downloadProgress.put("progress", progress);
            downloadProgress.put("bytes_downloaded", bytesDownloaded);
            downloadProgress.put("total_bytes", totalBytes);
            if (errorMessage != null) {
                downloadProgress.put("error_message", errorMessage);
            }
            downloadProgress.put("timestamp", timestamp);

            // Use reliable sending for OTA progress
            boolean sent = reliableManager.sendMessage(downloadProgress);
            Log.d(TAG, "📥 Sent download progress via BLE: " + status + " - " + progress + "% (sent: " + sent + ")");

        } catch (JSONException e) {
            Log.e(TAG, "Error creating download progress JSON", e);
        }
    }

    /**
     * Send installation progress notification over BLE.
     *
     * @param status       The status of the installation (e.g., "started", "completed", "failed")
     * @param apkPath      The path to the APK being installed
     * @param errorMessage Error message if installation failed, null otherwise
     * @param timestamp    The timestamp of the progress update
     */
    public void sendInstallationProgress(String status, String apkPath, String errorMessage, long timestamp) {
        if (!isBluetoothConnected()) {
            Log.d(TAG, "Cannot send installation progress - not connected to BLE device");
            return;
        }

        try {
            JSONObject installationProgress = new JSONObject();
            installationProgress.put("type", "ota_installation_progress");
            installationProgress.put("status", status);
            installationProgress.put("apk_path", apkPath);
            if (errorMessage != null) {
                installationProgress.put("error_message", errorMessage);
            }
            installationProgress.put("timestamp", timestamp);

            // Use reliable sending for OTA installation
            boolean sent = reliableManager.sendMessage(installationProgress);
            Log.d(TAG, "🔧 Sent installation progress via BLE: " + status + " - " + apkPath + " (sent: " + sent + ")");

        } catch (JSONException e) {
            Log.e(TAG, "Error creating installation progress JSON", e);
        }
    }

    /**
     * Send MTK firmware update complete notification over BLE.
     * Notifies mobile app that MTK firmware has been successfully updated
     * and glasses need to be restarted.
     */
    public void sendMtkUpdateComplete() {
        if (!isBluetoothConnected()) {
            Log.d(TAG, "Cannot send MTK update complete - not connected to BLE device");
            return;
        }

        try {
            JSONObject message = new JSONObject();
            message.put("type", "mtk_update_complete");
            message.put("message", "Please restart your glasses.");
            message.put("timestamp", System.currentTimeMillis());

            // Use reliable sending for MTK update complete
            boolean sent = reliableManager.sendMessage(message);
            Log.i(TAG, "🔄 Sent MTK update complete via BLE (sent: " + sent + ")");

        } catch (JSONException e) {
            Log.e(TAG, "Error creating MTK update complete JSON", e);
        }
    }

    /**
     * Send report swipe status over BLE.
     *
     * @param report The swipe report status (true/false)
     */
    public void sendReportSwipe(boolean report) {
        if (!isBluetoothConnected()) {
            Log.d(TAG, "Cannot send swipe report - not connected to BLE device");
            return;
        }

        try {
            JSONObject swipeJson = new JSONObject();
            swipeJson.put("C", "cs_swit");
            JSONObject bJson = new JSONObject();
            bJson.put("type", 27);
            bJson.put("switch", report);
            swipeJson.put("B", bJson);
            swipeJson.put("V", 1);

            String jsonString = swipeJson.toString();
            sendDataOverBluetooth(jsonString.getBytes());
            Log.d(TAG, "📱 Sent swipe report status via BLE: " + report);

        } catch (JSONException e) {
            Log.e(TAG, "Error creating swipe JSON", e);
        }
    }

    /**
     * Send a generic JSON response over BLE with reliability support.
     *
     * @param responseType The type of response
     * @param data         The response data
     * @param messageId    Optional message ID for acknowledgment (not used with reliability)
     */
    public void sendGenericResponse(String responseType, JSONObject data, long messageId) {
        if (!isBluetoothConnected()) {
            Log.d(TAG, "Cannot send generic response - not connected to BLE device");
            return;
        }

        try {
            JSONObject response = new JSONObject();
            response.put("type", responseType);
            if (data != null) {
                response.put("data", data);
            }
            response.put("timestamp", System.currentTimeMillis());

            // Use reliable sending (it will add mId if needed)
            boolean sent = reliableManager.sendMessage(response);
            Log.d(TAG, "📤 Sent " + responseType + " response via BLE (sent: " + sent + ")");

        } catch (JSONException e) {
            Log.e(TAG, "Error creating generic response JSON", e);
        }
    }

    /**
     * Send error response over BLE with reliability.
     *
     * @param errorCode    The error code
     * @param errorMessage The error message
     * @param messageId    Optional message ID for acknowledgment (not used with reliability)
     */
    public void sendErrorResponse(String errorCode, String errorMessage, long messageId) {
        if (!isBluetoothConnected()) {
            Log.d(TAG, "Cannot send error response - not connected to BLE device");
            return;
        }

        try {
            JSONObject errorResponse = new JSONObject();
            errorResponse.put("type", "error");
            errorResponse.put("error_code", errorCode);
            errorResponse.put("error_message", errorMessage);
            errorResponse.put("timestamp", System.currentTimeMillis());

            // Use reliable sending for errors (critical messages)
            boolean sent = reliableManager.sendMessage(errorResponse);
            Log.d(TAG, "❌ Sent error response via BLE: " + errorCode + " - " + errorMessage + " (sent: " + sent + ")");

        } catch (JSONException e) {
            Log.e(TAG, "Error creating error response JSON", e);
        }
    }

    /**
     * Check if Bluetooth is connected and available.
     *
     * @return true if Bluetooth is connected, false otherwise
     */
    private boolean isBluetoothConnected() {
        return serviceManager != null &&
                serviceManager.getBluetoothManager() != null &&
                serviceManager.getBluetoothManager().isConnected();
    }

    /**
     * Send data over Bluetooth with error handling.
     *
     * @param data The data to send
     */
    private void sendDataOverBluetooth(byte[] data) {
        try {
            serviceManager.getBluetoothManager().sendData(data);
        } catch (Exception e) {
            Log.e(TAG, "Error sending data over Bluetooth", e);
        }
    }

    /**
     * Get the service manager instance.
     *
     * @return The service manager
     */
    public AsgClientServiceManager getServiceManager() {
        return serviceManager;
    }
} 