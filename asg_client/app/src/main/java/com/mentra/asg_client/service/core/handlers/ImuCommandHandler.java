package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.sensors.ImuManager;
import com.mentra.asg_client.service.core.processors.ResponseSender;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Handles IMU-related commands from the phone.
 * Processes requests for single readings, streaming, and gesture detection.
 * Power-optimized to minimize battery usage.
 */
public class ImuCommandHandler implements ICommandHandler {
    private static final String TAG = "ImuCommandHandler";
    
    // Command types
    private static final String CMD_IMU_SINGLE = "imu_single";
    private static final String CMD_IMU_STREAM_START = "imu_stream_start";
    private static final String CMD_IMU_STREAM_STOP = "imu_stream_stop";
    private static final String CMD_IMU_SUBSCRIBE_GESTURE = "imu_subscribe_gesture";
    private static final String CMD_IMU_UNSUBSCRIBE_GESTURE = "imu_unsubscribe_gesture";
    
    private final Context context;
    private final ResponseSender responseSender;
    private ImuManager imuManager;
    
    public ImuCommandHandler(Context context, ResponseSender responseSender) {
        this.context = context;
        this.responseSender = responseSender;
        initializeImuManager();
    }
    
    private void initializeImuManager() {
        if (imuManager == null) {
            Log.d(TAG, "Initializing ImuManager");
            imuManager = new ImuManager(context);
            
            // Set up callbacks for IMU data
            imuManager.setDataCallback(new ImuManager.ImuDataCallback() {
                @Override
                public void onSingleReading(JSONObject data) {
                    sendResponse(data);
                }
                
                @Override
                public void onStreamData(JSONObject data) {
                    sendResponse(data);
                }
                
                @Override
                public void onGestureDetected(String gesture) {
                    sendGestureResponse(gesture);
                }
            });
        }
    }
    
    @Override
    public Set<String> getSupportedCommandTypes() {
        Set<String> supportedTypes = new HashSet<>();
        supportedTypes.add(CMD_IMU_SINGLE);
        supportedTypes.add(CMD_IMU_STREAM_START);
        supportedTypes.add(CMD_IMU_STREAM_STOP);
        supportedTypes.add(CMD_IMU_SUBSCRIBE_GESTURE);
        supportedTypes.add(CMD_IMU_UNSUBSCRIBE_GESTURE);
        return supportedTypes;
    }
    
    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        Log.d(TAG, "Handling IMU command: " + commandType);
        
        try {
            switch (commandType) {
                case CMD_IMU_SINGLE:
                    handleSingleReading(data);
                    return true;
                    
                case CMD_IMU_STREAM_START:
                    handleStreamStart(data);
                    return true;
                    
                case CMD_IMU_STREAM_STOP:
                    handleStreamStop(data);
                    return true;
                    
                case CMD_IMU_SUBSCRIBE_GESTURE:
                    handleGestureSubscription(data);
                    return true;
                    
                case CMD_IMU_UNSUBSCRIBE_GESTURE:
                    handleGestureUnsubscription(data);
                    return true;
                    
                default:
                    Log.w(TAG, "Unknown IMU command type: " + commandType);
                    sendErrorResponse("Unknown IMU command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling IMU command", e);
            sendErrorResponse("IMU command failed: " + e.getMessage());
            return false;
        }
    }
    
    /**
     * Handle request for single IMU reading
     */
    private void handleSingleReading(JSONObject data) {
        Log.d(TAG, "Processing single IMU reading request");
        
        if (imuManager == null) {
            sendErrorResponse("IMU manager not initialized");
            return;
        }
        
        // Request single reading (power-optimized with quick on/off)
        imuManager.requestSingleReading();
    }
    
    /**
     * Handle start streaming request
     */
    private void handleStreamStart(JSONObject data) {
        Log.d(TAG, "Processing stream start request");
        
        if (imuManager == null) {
            sendErrorResponse("IMU manager not initialized");
            return;
        }
        
        try {
            
            // Parse streaming parameters with defaults
            int rateHz = data.optInt("rate_hz", 50);
            long batchMs = data.optLong("batch_ms", 0);
            
            // Validate and clamp parameters
            rateHz = Math.min(100, Math.max(1, rateHz)); // 1-100 Hz
            batchMs = Math.min(1000, Math.max(0, batchMs)); // 0-1000ms
            
            Log.d(TAG, "Starting IMU stream: " + rateHz + "Hz, batch: " + batchMs + "ms");
            
            // Start streaming with auto-timeout
            imuManager.startStreaming(rateHz, batchMs);
            
            // Send acknowledgment
            sendAckResponse("IMU streaming started");
            
        } catch (Exception e) {
            Log.e(TAG, "Error parsing stream parameters", e);
            sendErrorResponse("Invalid stream parameters");
        }
    }
    
    /**
     * Handle stop streaming request
     */
    private void handleStreamStop(JSONObject data) {
        Log.d(TAG, "Processing stream stop request");
        
        if (imuManager == null) {
            sendErrorResponse("IMU manager not initialized");
            return;
        }
        
        imuManager.stopStreaming();
        sendAckResponse("IMU streaming stopped");
    }
    
    /**
     * Handle gesture subscription request
     */
    private void handleGestureSubscription(JSONObject data) {
        Log.d(TAG, "Processing gesture subscription request");
        
        if (imuManager == null) {
            sendErrorResponse("IMU manager not initialized");
            return;
        }
        
        try {
            JSONArray gesturesArray = data.optJSONArray("gestures");
            
            if (gesturesArray == null || gesturesArray.length() == 0) {
                sendErrorResponse("No gestures specified");
                return;
            }
            
            // Parse gesture list
            List<String> gestures = new ArrayList<>();
            for (int i = 0; i < gesturesArray.length(); i++) {
                String gesture = gesturesArray.getString(i);
                
                // Validate gesture type
                if (isValidGesture(gesture)) {
                    gestures.add(gesture);
                } else {
                    Log.w(TAG, "Invalid gesture type: " + gesture);
                }
            }
            
            if (gestures.isEmpty()) {
                sendErrorResponse("No valid gestures specified");
                return;
            }
            
            Log.d(TAG, "Subscribing to gestures: " + gestures);
            
            // Subscribe to gestures (power-optimized with accelerometer only)
            imuManager.subscribeToGestures(gestures);
            
            // Send acknowledgment
            JSONObject response = new JSONObject();
            response.put("type", "imu_gesture_subscribed");
            response.put("gestures", new JSONArray(gestures));
            sendResponse(response);
            
        } catch (Exception e) {
            Log.e(TAG, "Error parsing gesture subscription", e);
            sendErrorResponse("Invalid gesture subscription parameters");
        }
    }
    
    /**
     * Handle gesture unsubscription request
     */
    private void handleGestureUnsubscription(JSONObject data) {
        Log.d(TAG, "Processing gesture unsubscription request");
        
        if (imuManager == null) {
            sendErrorResponse("IMU manager not initialized");
            return;
        }
        
        imuManager.unsubscribeFromGestures();
        sendAckResponse("Unsubscribed from all gestures");
    }
    
    /**
     * Validate if a gesture type is supported
     */
    private boolean isValidGesture(String gesture) {
        return "head_up".equals(gesture) ||
               "head_down".equals(gesture) ||
               "nod_yes".equals(gesture) ||
               "shake_no".equals(gesture);
    }
    
    /**
     * Send IMU data response
     */
    private void sendResponse(JSONObject data) {
        try {
            // Add timestamp if not present
            if (!data.has("timestamp")) {
                data.put("timestamp", System.currentTimeMillis());
            }
            
            // Get the type from the data to use as response type
            String responseType = data.optString("type", "imu_response");
            
            // Send via ResponseSender using the generic response method
            responseSender.sendGenericResponse(responseType, data, System.currentTimeMillis());
            
        } catch (JSONException e) {
            Log.e(TAG, "Error sending IMU response", e);
        }
    }
    
    /**
     * Send gesture detection response
     */
    private void sendGestureResponse(String gesture) {
        try {
            JSONObject response = new JSONObject();
            response.put("type", "imu_gesture_response");
            response.put("gesture", gesture);
            response.put("timestamp", System.currentTimeMillis());
            
            sendResponse(response);
            
        } catch (JSONException e) {
            Log.e(TAG, "Error sending gesture response", e);
        }
    }
    
    /**
     * Send acknowledgment response
     */
    private void sendAckResponse(String message) {
        try {
            JSONObject response = new JSONObject();
            response.put("type", "imu_ack");
            response.put("status", "success");
            response.put("message", message);
            
            sendResponse(response);
            
        } catch (JSONException e) {
            Log.e(TAG, "Error sending ack response", e);
        }
    }
    
    /**
     * Send error response
     */
    private void sendErrorResponse(String error) {
        responseSender.sendErrorResponse("IMU_ERROR", error, System.currentTimeMillis());
    }
    
    /**
     * Clean up resources
     */
    public void shutdown() {
        Log.d(TAG, "Shutting down ImuCommandHandler");
        
        if (imuManager != null) {
            imuManager.shutdown();
            imuManager = null;
        }
    }
}