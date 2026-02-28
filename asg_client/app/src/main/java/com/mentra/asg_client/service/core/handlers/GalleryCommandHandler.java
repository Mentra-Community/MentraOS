package com.mentra.asg_client.service.core.handlers;

import android.util.Log;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.io.streaming.services.RtmpStreamingService;
import com.mentra.asg_client.utils.GalleryStatusHelper;

import org.json.JSONObject;
import java.util.Set;

/**
 * Handler for gallery-related commands.
 * Provides gallery status information to the phone via BLE.
 */
public class GalleryCommandHandler implements ICommandHandler {
    private static final String TAG = "GalleryCommandHandler";
    
    private final AsgClientServiceManager serviceManager;
    private final ICommunicationManager communicationManager;

    public GalleryCommandHandler(AsgClientServiceManager serviceManager, 
                                ICommunicationManager communicationManager) {
        this.serviceManager = serviceManager;
        this.communicationManager = communicationManager;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("query_gallery_status");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case "query_gallery_status":
                    return handleQueryGalleryStatus();
                default:
                    Log.e(TAG, "Unsupported gallery command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling gallery command: " + commandType, e);
            return false;
        }
    }

    /**
     * Handle query gallery status command.
     * Returns the count of photos and videos in the gallery using the same
     * FileManager approach as the HTTP server.
     * Also includes camera busy state if camera is being used.
     */
    private boolean handleQueryGalleryStatus() {
        try {
            Log.d(TAG, "📸 Querying gallery status...");

            // Get FileManager from the camera server (same way HTTP server does it)
            FileManager fileManager = null;
            if (serviceManager != null && serviceManager.getCameraServer() != null) {
                fileManager = serviceManager.getCameraServer().getFileManager();
            }

            if (fileManager == null) {
                Log.e(TAG, "📸 FileManager not available");
                return sendEmptyGalleryStatus();
            }

            // Build gallery status using shared utility
            JSONObject response = GalleryStatusHelper.buildGalleryStatus(fileManager);

            // Check camera busy state - only include if camera is actually busy
            String cameraState = getCameraBusyState();
            if (cameraState != null) {
                response.put("camera_busy", cameraState);
            }

            // Send response
            boolean sent = communicationManager.sendBluetoothResponse(response);
            Log.d(TAG, "📸 " + (sent ? "✅ Gallery status sent successfully" : "❌ Failed to send gallery status"));

            return sent;
        } catch (Exception e) {
            Log.e(TAG, "📸 Error querying gallery status", e);
            return sendEmptyGalleryStatus();
        }
    }
    
    /**
     * Send empty gallery status when FileManager is not available
     */
    private boolean sendEmptyGalleryStatus() {
        try {
            JSONObject response = new JSONObject();
            response.put("type", "gallery_status");
            response.put("photos", 0);
            response.put("videos", 0);
            response.put("total", 0);
            response.put("total_size", 0);
            response.put("has_content", false);

            return communicationManager.sendBluetoothResponse(response);
        } catch (Exception e) {
            Log.e(TAG, "📸 Error sending empty gallery status", e);
            return false;
        }
    }
    
    /**
     * Check if camera is busy with recording or streaming.
     * @return "video" if recording, "stream" if streaming, null if camera is available
     */
    private String getCameraBusyState() {
        try {
            // Check if RTMP streaming is active
            if (RtmpStreamingService.isStreaming()) {
                Log.d(TAG, "Camera is busy: RTMP streaming active");
                return "stream";
            }
            
            // Check if video recording is active
            MediaCaptureService mediaCaptureService = null;
            if (serviceManager != null) {
                mediaCaptureService = serviceManager.getMediaCaptureService();
            }
            
            if (mediaCaptureService != null && mediaCaptureService.isRecordingVideo()) {
                Log.d(TAG, "Camera is busy: Video recording active");
                return "video";
            }
            
            // TODO: Add check for buffer recording when implemented
            // if (bufferRecordingActive) {
            //     return "buffer";
            // }
            
            // Camera is not busy
            return null;
        } catch (Exception e) {
            Log.e(TAG, "Error checking camera busy state", e);
            return null;
        }
    }
}