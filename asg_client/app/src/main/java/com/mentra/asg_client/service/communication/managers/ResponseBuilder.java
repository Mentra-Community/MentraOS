package com.mentra.asg_client.service.communication.managers;

import android.util.Log;

import com.mentra.asg_client.service.communication.interfaces.IResponseBuilder;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.List;

/**
 * Implementation of IResponseBuilder that creates JSON responses.
 * Follows Single Responsibility Principle by handling only response creation.
 */
public class ResponseBuilder implements IResponseBuilder {
    private static final String TAG = "ResponseBuilder";

    public ResponseBuilder() {
    }

    @Override
    public JSONObject buildAckResponse(long messageId) {
        try {
            JSONObject ack = new JSONObject();
            ack.put("type", "ack");
            ack.put("messageId", messageId);
            return ack;
        } catch (JSONException e) {
            Log.e(TAG, "Error creating ACK response", e);
            return new JSONObject();
        }
    }

    @Override
    public JSONObject buildTokenStatusResponse(boolean success) {
        try {
            JSONObject response = new JSONObject();
            response.put("type", "token_status");
            response.put("success", success);
            return response;
        } catch (JSONException e) {
            Log.e(TAG, "Error creating token status response", e);
            return new JSONObject();
        }
    }

    @Override
    public JSONObject buildVideoRecordingStatusResponse(boolean success, String status, String details) {
        try {
            JSONObject response = new JSONObject();
            response.put("type", "video_recording_status");
            response.put("success", success);
            response.put("status", status);
            if (details != null) {
                response.put("details", details);
            }
            return response;
        } catch (JSONException e) {
            Log.e(TAG, "Error creating video recording status response", e);
            return new JSONObject();
        }
    }

    @Override
    public JSONObject buildVideoRecordingStatusResponse(boolean success, JSONObject statusObject) {
        try {
            JSONObject response = new JSONObject();
            response.put("type", "video_recording_status");
            response.put("success", success);
            response.put("data", statusObject);
            return response;
        } catch (JSONException e) {
            Log.e(TAG, "Error creating video recording status response", e);
            return new JSONObject();
        }
    }

    @Override
    public JSONObject buildRtmpStatusResponse(boolean success, String status, String details) {
        try {
            JSONObject response = new JSONObject();
            response.put("type", "rtmp_stream_status");
            response.put("success", success);
            response.put("status", status);
            if (details != null) {
                response.put("details", details);
            }
            return response;
        } catch (JSONException e) {
            Log.e(TAG, "Error creating RTMP status response", e);
            return new JSONObject();
        }
    }

    @Override
    public JSONObject buildRtmpStatusResponse(boolean success, JSONObject statusObject) {
        try {
            JSONObject response = new JSONObject();
            response.put("type", "rtmp_stream_status");
            response.put("success", success);
            response.put("data", statusObject);
            return response;
        } catch (JSONException e) {
            Log.e(TAG, "Error creating RTMP status response", e);
            return new JSONObject();
        }
    }

    @Override
    public JSONObject buildWifiScanResultsResponse(List<String> networks) {
        try {
            JSONObject scanResults = new JSONObject();
            scanResults.put("type", "wifi_scan_result");

            JSONArray networksArray = new JSONArray();
            for (String network : networks) {
                networksArray.put(network);
            }
            scanResults.put("networks", networksArray);
            return scanResults;
        } catch (JSONException e) {
            Log.e(TAG, "Error creating WiFi scan results JSON", e);
            return new JSONObject();
        }
    }

    @Override
    public JSONObject buildPingResponse() {
        try {
            JSONObject pingResponse = new JSONObject();
            pingResponse.put("type", "pong");
            return pingResponse;
        } catch (JSONException e) {
            Log.e(TAG, "Error creating ping response", e);
            return new JSONObject();
        }
    }

    @Override
    public JSONObject buildGlassesReadyResponse() {
        try {
            JSONObject response = new JSONObject();
            response.put("type", "glasses_ready");
            response.put("timestamp", System.currentTimeMillis());
            return response;
        } catch (JSONException e) {
            Log.e(TAG, "Error creating glasses_ready response", e);
            return new JSONObject();
        }
    }

    @Override
    public JSONObject buildDownloadProgressResponse(String status, int progress, long bytesDownloaded, 
                                                   long totalBytes, String errorMessage, long timestamp) {
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
            return downloadProgress;
        } catch (JSONException e) {
            Log.e(TAG, "Error creating download progress JSON", e);
            return new JSONObject();
        }
    }

    @Override
    public JSONObject buildInstallationProgressResponse(String status, String apkPath, 
                                                       String errorMessage, long timestamp) {
        try {
            JSONObject installationProgress = new JSONObject();
            installationProgress.put("type", "ota_installation_progress");
            installationProgress.put("status", status);
            installationProgress.put("apk_path", apkPath);
            if (errorMessage != null) {
                installationProgress.put("error_message", errorMessage);
            }
            installationProgress.put("timestamp", timestamp);
            return installationProgress;
        } catch (JSONException e) {
            Log.e(TAG, "Error creating installation progress JSON", e);
            return new JSONObject();
        }
    }

    @Override
    public JSONObject buildButtonPressResponse(String buttonId, String pressType) {
        try {
            JSONObject buttonObject = new JSONObject();
            buttonObject.put("type", "button_press");
            buttonObject.put("buttonId", buttonId);
            buttonObject.put("pressType", pressType);
            buttonObject.put("timestamp", System.currentTimeMillis());
            return buttonObject;
        } catch (JSONException e) {
            Log.e(TAG, "Error creating button press response", e);
            return new JSONObject();
        }
    }

    @Override
    public JSONObject buildBatteryStatusResponse(int batteryPercentage, boolean isCharging) {
        try {
            JSONObject obj = new JSONObject();
            obj.put("type", "battery_status");
            obj.put("charging", isCharging);
            obj.put("percent", batteryPercentage);
            return obj;
        } catch (JSONException e) {
            Log.e(TAG, "Error creating battery status JSON", e);
            return new JSONObject();
        }
    }

    @Override
    public JSONObject buildPhotoModeAckResponse(String mode) {
        try {
            JSONObject ack = new JSONObject();
            ack.put("type", "set_photo_mode_ack");
            ack.put("mode", mode);
            return ack;
        } catch (JSONException e) {
            Log.e(TAG, "Error creating photo mode ack", e);
            return new JSONObject();
        }
    }

    @Override
    public JSONObject buildSwipeReportResponse(boolean report) {
        try {
            JSONObject swipeJson = new JSONObject();
            swipeJson.put("C", "cs_swit");
            JSONObject bJson = new JSONObject();
            bJson.put("type", 27);
            bJson.put("switch", report);
            swipeJson.put("B", bJson);
            swipeJson.put("V", 1);
            return swipeJson;
        } catch (JSONException e) {
            Log.e(TAG, "Error creating swipe JSON", e);
            return new JSONObject();
        }
    }
} 