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
     * Send battery status over Bluetooth
     */
    void sendBatteryStatusOverBle();
    
    /**
     * Send WiFi scan results over Bluetooth
     * @param networks List of available networks (legacy format)
     */
    void sendWifiScanResultsOverBle(java.util.List<String> networks);
    
    /**
     * Send enhanced WiFi scan results over Bluetooth with security and signal info
     * @param networks List of NetworkInfo objects with enhanced data
     */
    void sendWifiScanResultsOverBleEnhanced(java.util.List<NetworkInfo> networks);
    
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
     * Send OTA progress update to phone
     * @param progress JSON with stage, status, progress, bytes_downloaded, total_bytes, error_message, etc.
     */
    void sendOtaProgress(JSONObject progress);
} 