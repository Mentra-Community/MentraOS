package com.mentra.asg_client.service.communication.interfaces;

import org.json.JSONObject;
import java.util.List;

/**
 * Interface for building JSON responses.
 * Follows Single Responsibility Principle by handling only response creation.
 */
public interface IResponseBuilder {
    
    /**
     * Build a simple acknowledgment response
     * @param messageId Message ID to acknowledge
     * @return JSON response object
     */
    JSONObject buildAckResponse(long messageId);
    
    /**
     * Build a token status response
     * @param success Success status
     * @return JSON response object
     */
    JSONObject buildTokenStatusResponse(boolean success);
    
    /**
     * Build a video recording status response
     * @param success Success status
     * @param status Status message
     * @param details Additional details
     * @return JSON response object
     */
    JSONObject buildVideoRecordingStatusResponse(boolean success, String status, String details);
    
    /**
     * Build a video recording status response with JSON object
     * @param success Success status
     * @param statusObject Status JSON object
     * @return JSON response object
     */
    JSONObject buildVideoRecordingStatusResponse(boolean success, JSONObject statusObject);
    
    /**
     * Build an RTMP status response
     * @param success Success status
     * @param status Status message
     * @param details Additional details
     * @return JSON response object
     */
    JSONObject buildRtmpStatusResponse(boolean success, String status, String details);
    
    /**
     * Build an RTMP status response with JSON object
     * @param success Success status
     * @param statusObject Status JSON object
     * @return JSON response object
     */
    JSONObject buildRtmpStatusResponse(boolean success, JSONObject statusObject);
    
    /**
     * Build a WiFi scan results response
     * @param networks List of available networks
     * @return JSON response object
     */
    JSONObject buildWifiScanResultsResponse(List<String> networks);
    
    /**
     * Build a ping response
     * @return JSON response object
     */
    JSONObject buildPingResponse();
    
    /**
     * Build a glasses ready response
     * @return JSON response object
     */
    JSONObject buildGlassesReadyResponse();
    
    /**
     * Build a download progress response
     * @param status Download status
     * @param progress Progress percentage
     * @param bytesDownloaded Bytes downloaded
     * @param totalBytes Total bytes
     * @param errorMessage Error message (optional)
     * @param timestamp Timestamp
     * @return JSON response object
     */
    JSONObject buildDownloadProgressResponse(String status, int progress, long bytesDownloaded, 
                                           long totalBytes, String errorMessage, long timestamp);
    
    /**
     * Build an installation progress response
     * @param status Installation status
     * @param apkPath APK path
     * @param errorMessage Error message (optional)
     * @param timestamp Timestamp
     * @return JSON response object
     */
    JSONObject buildInstallationProgressResponse(String status, String apkPath, 
                                               String errorMessage, long timestamp);
    
    /**
     * Build a button press response
     * @param buttonId Button ID
     * @param pressType Press type (short/long)
     * @return JSON response object
     */
    JSONObject buildButtonPressResponse(String buttonId, String pressType);
    
    /**
     * Build a battery status response
     * @param batteryPercentage Battery percentage
     * @param isCharging Whether device is charging
     * @return JSON response object
     */
    JSONObject buildBatteryStatusResponse(int batteryPercentage, boolean isCharging);
    
    /**
     * Build a photo mode acknowledgment response
     * @param mode Photo mode
     * @return JSON response object
     */
    JSONObject buildPhotoModeAckResponse(String mode);
    
    /**
     * Build a swipe report response
     * @param report Report status
     * @return JSON response object
     */
    JSONObject buildSwipeReportResponse(boolean report);
} 