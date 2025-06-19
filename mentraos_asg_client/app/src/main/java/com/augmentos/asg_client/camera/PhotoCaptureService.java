package com.augmentos.asg_client.camera;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.preference.PreferenceManager;

import com.augmentos.augmentos_core.utils.ServerConfigUtil;

import org.json.JSONException;
import org.json.JSONObject;

import com.augmentos.augmentos_core.smarterglassesmanager.camera.PhotoUploadService;

import java.io.File;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.UUID;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * Service that handles photo capturing and uploading functionality.
 * Extracts this logic from AsgClientService to improve modularity.
 */
public class PhotoCaptureService {
    private static final String TAG = "PhotoCaptureService";
    
    private final Context mContext;
    private final PhotoQueueManager mPhotoQueueManager;
    private PhotoCaptureListener mPhotoCaptureListener;
    
    /**
     * Interface for listening to photo capture and upload events
     */
    public interface PhotoCaptureListener {
        void onPhotoCapturing(String requestId);
        void onPhotoCaptured(String requestId, String filePath);
        void onPhotoUploading(String requestId);
        void onPhotoUploaded(String requestId, String url);
        void onPhotoError(String requestId, String error);
    }
    
    /**
     * Constructor
     *
     * @param context Application context
     * @param photoQueueManager PhotoQueueManager instance
     */
    public PhotoCaptureService(@NonNull Context context, @NonNull PhotoQueueManager photoQueueManager) {
        mContext = context.getApplicationContext();
        mPhotoQueueManager = photoQueueManager;
    }
    
    /**
     * Set a listener for photo capture events
     */
    public void setPhotoCaptureListener(PhotoCaptureListener listener) {
        this.mPhotoCaptureListener = listener;
    }

    /**
     * Handles the photo button press by sending a request to the cloud server
     * If connected, makes REST API call to server
     * If disconnected or server error, takes photo locally
     */
    public void handlePhotoButtonPress() {
        // Get core token for authentication
        String coreToken = PreferenceManager.getDefaultSharedPreferences(mContext)
                .getString("core_token", "");
        
        // Get device ID for hardware identification
        String deviceId = android.os.Build.MODEL + "_" + android.os.Build.SERIAL;
        
        if (coreToken == null || coreToken.isEmpty()) {
            Log.e(TAG, "No core token available, taking photo locally");
            takePhotoLocally();
            return;
        }
        
        // Prepare REST API call
        try {
            // Get the button press URL from the central config utility
            String buttonPressUrl = ServerConfigUtil.getButtonPressUrl(mContext);
            
            // Create payload for button press event
            JSONObject buttonPressPayload = new JSONObject();
            buttonPressPayload.put("buttonId", "photo");
            buttonPressPayload.put("pressType", "short");
            buttonPressPayload.put("deviceId", deviceId);
            
            Log.d(TAG, "Sending button press event to server: " + buttonPressUrl);
            
            // Make REST API call with timeout
            OkHttpClient client = new OkHttpClient.Builder()
                .connectTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
                .writeTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
                .readTimeout(5, java.util.concurrent.TimeUnit.SECONDS)
                .build();
            
            RequestBody requestBody = RequestBody.create(
                MediaType.parse("application/json"), 
                buttonPressPayload.toString()
            );
            
            Request request = new Request.Builder()
                .url(buttonPressUrl)
                .header("Authorization", "Bearer " + coreToken) // Use header() for consistency
                .post(requestBody)
                .build();
            
            // Execute request asynchronously
            client.newCall(request).enqueue(new Callback() {
                @Override
                public void onFailure(Call call, IOException e) {
                    Log.e(TAG, "Failed to send button press event", e);
                    // Connection failed, take photo locally
                    takePhotoLocally();
                }
                
                @Override
                public void onResponse(Call call, Response response) {
                    try {
                        if (!response.isSuccessful()) {
                            Log.e(TAG, "Server returned error: " + response.code());
                            // Server error, take photo locally
                            takePhotoLocally();
                            return;
                        }
                        
                        // Parse response
                        String responseBody = response.body().string();
                        Log.d(TAG, "Server response: " + responseBody);
                        JSONObject jsonResponse = new JSONObject(responseBody);
                        
                        // Check if we need to take a photo
                        if ("take_photo".equals(jsonResponse.optString("action"))) {
                            String requestId = jsonResponse.optString("requestId");
                            boolean saveToGallery = jsonResponse.optBoolean("saveToGallery", true);
                            String appId = jsonResponse.optString("appId", "system");
                            
                            Log.d(TAG, "Server requesting photo with requestId: " + requestId);
                            
                            // Take photo and upload directly to server
                            String timeStamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date());
                            String photoFilePath = mContext.getExternalFilesDir(null) + File.separator + "IMG_" + timeStamp + ".jpg";
                            takePhotoAndUpload(photoFilePath, requestId, appId);
                        } else {
                            Log.d(TAG, "Button press handled by server, no photo needed");
                        }
                    } catch (Exception e) {
                        Log.e(TAG, "Error processing server response", e);
                        takePhotoLocally();
                    } finally {
                        response.close();
                    }
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "Error preparing button press request", e);
            // Something went wrong, take photo locally
            takePhotoLocally();
        }
    }
    
    /**
     * Takes a photo locally when offline or when server communication fails
     */
    private void takePhotoLocally() {
        // Check storage availability before taking photo
        if (!isExternalStorageAvailable()) {
            Log.e(TAG, "External storage is not available for photo capture");
            return;
        }
        
        String timeStamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date());
        String photoFilePath = mContext.getExternalFilesDir(null) + File.separator + "IMG_" + timeStamp + ".jpg";
        
        // Generate a temporary requestId
        String requestId = "local_" + timeStamp;
        
        // For offline mode, take photo and queue it for later upload
        CameraNeo.takePictureWithCallback(
            mContext,
            photoFilePath,
            new CameraNeo.PhotoCaptureCallback() {
                @Override
                public void onPhotoCaptured(String filePath) {
                    Log.d(TAG, "Offline photo captured successfully at: " + filePath);
                    
                    // Queue the photo for later upload
                    mPhotoQueueManager.queuePhoto(filePath, requestId, "system");
                    
                    // Notify the user about offline mode
                    Log.d(TAG, "Photo queued for later upload (offline mode)");
                    
                    // Notify through standard capture listener if set up
                    if (mPhotoCaptureListener != null) {
                        mPhotoCaptureListener.onPhotoCaptured(requestId, filePath);
                        mPhotoCaptureListener.onPhotoUploading(requestId);
                    }
                }
                
                @Override
                public void onPhotoError(String errorMessage) {
                    Log.e(TAG, "Failed to capture offline photo: " + errorMessage);
                    
                    if (mPhotoCaptureListener != null) {
                        mPhotoCaptureListener.onPhotoError(requestId, errorMessage);
                    }
                }
            }
        );
    }
    
    /**
     * Take a photo and upload it to AugmentOS Cloud
     */
    public void takePhotoAndUpload(String photoFilePath, String requestId, String appId) {
        // Notify that we're about to take a photo
        if (mPhotoCaptureListener != null) {
            mPhotoCaptureListener.onPhotoCapturing(requestId);
        }
        
        try {
            // Use CameraNeo for photo capture
            CameraNeo.takePictureWithCallback(
                mContext,
                photoFilePath,
                new CameraNeo.PhotoCaptureCallback() {
                    @Override
                    public void onPhotoCaptured(String filePath) {
                        Log.d(TAG, "Photo captured successfully at: " + filePath);
                        
                        // Notify that we've captured the photo
                        if (mPhotoCaptureListener != null) {
                            mPhotoCaptureListener.onPhotoCaptured(requestId, filePath);
                            mPhotoCaptureListener.onPhotoUploading(requestId);
                        }
                        
                        // Upload the photo to AugmentOS Cloud
                        uploadPhotoToCloud(filePath, requestId, appId);
                    }
                    
                    @Override
                    public void onPhotoError(String errorMessage) {
                        Log.e(TAG, "Failed to capture photo: " + errorMessage);
                        sendPhotoErrorResponse(requestId, appId, errorMessage);
                        
                        if (mPhotoCaptureListener != null) {
                            mPhotoCaptureListener.onPhotoError(requestId, errorMessage);
                        }
                    }
                }
            );
        } catch (Exception e) {
            Log.e(TAG, "Error taking photo", e);
            sendPhotoErrorResponse(requestId, appId, "Error taking photo: " + e.getMessage());
            
            if (mPhotoCaptureListener != null) {
                mPhotoCaptureListener.onPhotoError(requestId, "Error taking photo: " + e.getMessage());
            }
        }
    }
    
    /**
     * Upload photo to AugmentOS Cloud
     */
    private void uploadPhotoToCloud(String photoFilePath, String requestId, String appId) {
        // Upload the photo to AugmentOS Cloud
        PhotoUploadService.uploadPhoto(
            mContext,
            photoFilePath,
            requestId,
            new PhotoUploadService.UploadCallback() {
                @Override
                public void onSuccess(String url) {
                    Log.d(TAG, "Photo uploaded successfully: " + url);
                    sendPhotoSuccessResponse(requestId, appId, url);
                    
                    // Notify listener about successful upload
                    if (mPhotoCaptureListener != null) {
                        mPhotoCaptureListener.onPhotoUploaded(requestId, url);
                    }
                }
                
                @Override
                public void onFailure(String errorMessage) {
                    Log.e(TAG, "Photo upload failed: " + errorMessage);
                    sendPhotoErrorResponse(requestId, appId, errorMessage);
                    
                    // Notify listener about error
                    if (mPhotoCaptureListener != null) {
                        mPhotoCaptureListener.onPhotoError(requestId, "Upload failed: " + errorMessage);
                    }
                }
            }
        );
    }
    
    /**
     * Send a success response for a photo request
     * This should be overridden by the service that uses this class
     */
    protected void sendPhotoSuccessResponse(String requestId, String appId, String photoUrl) {
        // Default implementation is empty
        // This should be overridden by the service that uses this class
    }
    
    /**
     * Send an error response for a photo request
     * This should be overridden by the service that uses this class
     */
    protected void sendPhotoErrorResponse(String requestId, String appId, String errorMessage) {
        // Default implementation is empty
        // This should be overridden by the service that uses this class
    }
    
    /**
     * Check if external storage is available for read/write
     */
    private boolean isExternalStorageAvailable() {
        String state = android.os.Environment.getExternalStorageState();
        return android.os.Environment.MEDIA_MOUNTED.equals(state);
    }
}