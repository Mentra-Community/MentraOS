package com.augmentos.augmentos_core.augmentos_backend;

import org.json.JSONObject;

import java.util.List;

public interface ServerCommsCallback {
    void onConnectionAck();
    void onAppStateChange(List<ThirdPartyCloudApp> appList);
    void onDisplayEvent(JSONObject displayData);
    void onDashboardDisplayEvent(JSONObject dashboardDisplayData);
    void onConnectionError(String errorMsg);
    void onAuthError();
    void onConnectionStatusChange(WebSocketManager.IncomingMessageHandler.WebSocketStatus status);
    void onRequestSingle(String dataType);
    void onMicrophoneStateChange(boolean isEnabled);
    
    /**
     * Called when the server requests a photo to be taken
     * 
     * @param requestId Unique ID for this photo request
     * @param appId ID of the app requesting the photo
     */
    void onPhotoRequest(String requestId, String appId);
    
    /**
     * Called when the server requests an RTMP stream
     * 
     * @param message The complete RTMP stream request message with all parameters
     */
    void onRtmpStreamStartRequest(JSONObject message);
    
    /**
     * Called when the server requests to stop an RTMP stream
     * 
     */
    void onRtmpStreamStop();
    
    /**
     * Called when the server sends a keep alive message for an RTMP stream
     * 
     * @param message The keep alive message with streamId, ackId, and timestamp
     */
    void onRtmpStreamKeepAlive(JSONObject message);

    // New methods for explicit app started/stopped events
    void onAppStarted(String packageName);
    void onAppStopped(String packageName);
    void onSettingsUpdate(JSONObject settings);
}
