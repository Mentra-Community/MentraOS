package com.mentra.asg_client.service.communication.interfaces;

import org.json.JSONObject;
import com.mentra.asg_client.io.network.models.NetworkInfo;

/**
 * Interface for communication management (Bluetooth, WiFi status, etc.).
 * Follows Interface Segregation Principle by providing focused communication methods.
 */
public interface ICommunicationManager {
    
    /**
     * Send WiFi status over Bluetooth
     * @param isConnected WiFi connection status
     */
    void sendWifiStatusOverBle(boolean isConnected);

    /**
     * Send WiFi status over Bluetooth with a failure reason. The error is included in the
     * wifi_status message so the phone can show why a provisioning attempt failed instead
     * of silently reporting "not connected".
     *
     * @param isConnected WiFi connection status
     * @param error Failure reason (e.g. "connect_timeout"), or null when not applicable
     */
    void sendWifiStatusOverBle(boolean isConnected, String error);
    
    /**
     * Send battery status over Bluetooth
     */
    void sendBatteryStatusOverBle();
    
    /**
     * Send WiFi scan results over Bluetooth
     * @param networks List of available networks (legacy format)
     * @param scanId Correlation id of the scan that produced these results, echoed in
     *               every chunk; null when the request carried none
     */
    void sendWifiScanResultsOverBle(java.util.List<String> networks, String scanId);

    /**
     * Send enhanced WiFi scan results over Bluetooth with security and signal info
     * @param networks List of NetworkInfo objects with enhanced data
     * @param scanComplete Whether this payload is the terminal scan response
     * @param scanId Correlation id of the scan that produced these results, echoed in
     *               every chunk; null when the request carried none
     */
    void sendWifiScanResultsOverBleEnhanced(java.util.List<NetworkInfo> networks, boolean scanComplete, String scanId);

    /**
     * Send the terminal result for a forget_wifi command.
     * @param requestId Correlation id supplied by the phone, or null for a legacy request
     * @param ssid Network the phone asked the glasses to forget
     * @param dispatched Whether ASG dispatched the forget command through its platform integration;
     *     asynchronous vendor completion may still be unverified
     * @param error Stable failure code, or null when dispatched
     */
    void sendWifiForgetResultOverBle(String requestId, String ssid, boolean dispatched, String error);

    /**
     * Send the configured WiFi SSIDs stored on the glasses.
     * @param requestId Correlation id supplied by the phone
     * @param networks Saved SSIDs; never null
     * @param error Stable failure code, or null on success
     */
    void sendSavedWifiNetworksOverBle(
            String requestId, java.util.List<String> networks, String error);
    
    /**
     * Send acknowledgment response
     * @param messageId Message ID to acknowledge
     */
    void sendAckResponse(long messageId);
    
    /**
     * Send token status response
     * @param success Success status
     */
    void sendTokenStatusResponse(boolean success);
    
    /**
     * Send media success response
     * @param requestId Request ID
     * @param mediaUrl Media URL
     * @param mediaType Media type
     */
    void sendMediaSuccessResponse(String requestId, String mediaUrl, int mediaType);
    
    /**
     * Send media error response
     * @param requestId Request ID
     * @param errorMessage Error message
     * @param mediaType Media type
     */
    void sendMediaErrorResponse(String requestId, String errorMessage, int mediaType);
    
    /**
     * Send keep-alive acknowledgment
     * @param streamId Stream ID
     * @param ackId Acknowledgment ID
     */
    void sendKeepAliveAck(String streamId, String ackId);
    
    /**
     * Send data over Bluetooth
     * @param data Data to send
     * @return true if sent successfully, false otherwise
     */
    boolean sendBluetoothData(byte[] data);
    
    /**
     * Send JSON response over Bluetooth
     * @param response JSON response to send
     * @return true if sent successfully, false otherwise
     */
    boolean sendBluetoothResponse(JSONObject response);
    
    /**
     * Send unified OTA status to phone (new rearchitected protocol).
     * Terminal events (complete/failed) are sent via reliable delivery.
     */
    void sendOtaStatus(JSONObject status);
}
