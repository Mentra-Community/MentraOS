package com.augmentos.augmentos_core.smarterglassesmanager.camera;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.preference.PreferenceManager;
import android.util.Log;

import com.augmentos.augmentos_core.BuildConfig;
import com.augmentos.augmentos_core.augmentos_backend.OldBackendServerComms;
import com.augmentos.augmentos_core.utils.ServerConfigUtil;

import java.io.File;
import java.io.IOException;
import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Service for uploading photos to AugmentOS Cloud
 */
public class PhotoUploadService {
    private static final String TAG = "PhotoUploadService";
    private static final int TIMEOUT_CONNECT = 30000; // 30 seconds
    private static final int TIMEOUT_WRITE = 60000;   // 60 seconds
    private static final int TIMEOUT_READ = 60000;    // 60 seconds
    
    /**
     * Callback interface for photo upload results
     */
    public interface UploadCallback {
        void onSuccess(String url);
        void onFailure(String errorMessage);
    }

    /**
     * @deprecated Use ServerConfigUtil.getServerBaseUrl() instead
     */
    @Deprecated
    private static String getServerUrl(Context context) {
        return ServerConfigUtil.getServerBaseUrl(context);
    }
    
    /**
     * Upload a photo to AugmentOS Cloud
     * 
     * @param context Application context
     * @param photoFilePath Path to the photo file
     * @param requestId Request ID associated with this photo
     * @param callback Callback to receive result
     */
    public static void uploadPhoto(Context context, String photoFilePath, String requestId, UploadCallback callback) {
        // Get core token for authentication
        String coreToken = PreferenceManager.getDefaultSharedPreferences(context)
                .getString("core_token", "");
        
        // Create a thread to handle the upload
        new Thread(() -> {
            OkHttpClient client = new OkHttpClient.Builder()
                .connectTimeout(TIMEOUT_CONNECT, TimeUnit.MILLISECONDS)
                .writeTimeout(TIMEOUT_WRITE, TimeUnit.MILLISECONDS)
                .readTimeout(TIMEOUT_READ, TimeUnit.MILLISECONDS)
                .build();
            
            try {
                File photoFile = new File(photoFilePath);
                if (!photoFile.exists()) {
                    handleFailure(callback, "Photo file does not exist: " + photoFilePath);
                    return;
                }
                
                // Get photo upload URL from central config
                String uploadUrl = ServerConfigUtil.getPhotoUploadUrl(context);
                
                Log.d(TAG, "Uploading photo to: " + uploadUrl);
                
                RequestBody requestBody = new MultipartBody.Builder()
                    .setType(MultipartBody.FORM)
                    .addFormDataPart("requestId", requestId)
                    // Remove coreToken from form data and use Authorization header instead
                    .addFormDataPart("photo", photoFile.getName(),
                        RequestBody.create(MediaType.parse("image/jpeg"), photoFile))
                    .build();
                    
                Request request = new Request.Builder()
                    .url(uploadUrl)
                    .header("Authorization", "Bearer " + coreToken) // Use Authorization header (industry standard)
                    .post(requestBody)
                    .build();
                    
                Response response = client.newCall(request).execute();
                
                if (!response.isSuccessful()) {
                    // Get more detailed error information when available
                    String errorBody = "";
                    try {
                        errorBody = response.body() != null ? response.body().string() : "";
                    } catch (Exception e) {
                        // Ignore error reading body
                    }
                    
                    // Log detailed error information
                    Log.e(TAG, "Upload failed with status: " + response.code());
                    Log.e(TAG, "URL: " + uploadUrl);
                    Log.e(TAG, "RequestId: " + requestId);
                    if (!errorBody.isEmpty()) {
                        Log.e(TAG, "Error response: " + errorBody);
                    }
                    
                    // Create error message with more context
                    String errorMessage = "Upload failed with status: " + response.code();
                    if (!errorBody.isEmpty()) {
                        errorMessage += " - " + errorBody;
                    }
                    
                    handleFailure(callback, errorMessage);
                    return;
                }
                
                String responseBody = response.body().string();
                JSONObject jsonResponse = new JSONObject(responseBody);
                String photoUrl = jsonResponse.optString("photoUrl", "");
                
                if (photoUrl.isEmpty()) {
                    handleFailure(callback, "No photo URL in response");
                    return;
                }
                
                // Success
                if (callback != null) {
                    new Handler(Looper.getMainLooper()).post(() -> {
                        callback.onSuccess(photoUrl);
                    });
                }
                
                // Cleanup temporary file
                photoFile.delete();
                
            } catch (IOException e) {
                Log.e(TAG, "Error uploading photo", e);
                handleFailure(callback, "Upload error: " + e.getMessage());
            } catch (JSONException e) {
                Log.e(TAG, "Error parsing response", e);
                handleFailure(callback, "Response parsing error: " + e.getMessage());
            }
        }).start();
    }
    
    private static void handleFailure(UploadCallback callback, String errorMessage) {
        Log.e(TAG, errorMessage);
        if (callback != null) {
            new Handler(Looper.getMainLooper()).post(() -> {
                callback.onFailure(errorMessage);
            });
        }
    }
}