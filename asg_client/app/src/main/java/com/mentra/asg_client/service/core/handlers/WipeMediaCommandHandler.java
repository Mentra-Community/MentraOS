package com.mentra.asg_client.service.core.handlers;

import android.util.Log;

import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.media.managers.MediaUploadQueueManager;
import com.mentra.asg_client.io.media.utils.MediaUtils;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;

import org.json.JSONObject;

import java.io.File;
import java.util.Set;

/**
 * Wipes all media under the default gallery directory during ownership transfer pairing.
 */
public class WipeMediaCommandHandler implements ICommandHandler {
    private static final String TAG = "WipeMediaCommandHandler";

    private final ICommunicationManager communicationManager;
    private final AsgClientServiceManager serviceManager;
    private final FileManager fileManager;

    public WipeMediaCommandHandler(
            ICommunicationManager communicationManager,
            AsgClientServiceManager serviceManager,
            FileManager fileManager) {
        this.communicationManager = communicationManager;
        this.serviceManager = serviceManager;
        this.fileManager = fileManager;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("wipe_media");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        if (!"wipe_media".equals(commandType)) {
            return false;
        }

        boolean success = false;
        try {
            MediaUploadQueueManager queueManager = serviceManager != null
                    ? serviceManager.getMediaQueueManager()
                    : null;
            if (queueManager != null) {
                queueManager.clearQueue();
            }

            File mediaDir = fileManager.getDefaultMediaDirectory();
            success = deleteDirectoryContents(mediaDir);
            Log.i(TAG, "wipe_media completed success=" + success + " dir=" + mediaDir);
        } catch (Exception e) {
            Log.e(TAG, "wipe_media failed", e);
            success = false;
        }

        try {
            JSONObject response = new JSONObject();
            response.put("type", "wipe_media_result");
            response.put("success", success);
            return communicationManager.sendBluetoothResponse(response);
        } catch (Exception e) {
            Log.e(TAG, "Failed to send wipe_media_result", e);
            return false;
        }
    }

    private boolean deleteDirectoryContents(File directory) {
        if (directory == null || !directory.exists()) {
            return true;
        }

        File[] children = directory.listFiles();
        if (children == null) {
            return false;
        }

        boolean allDeleted = true;
        for (File child : children) {
            if (child.isDirectory()) {
                if (!deleteDirectoryContents(child)) {
                    allDeleted = false;
                }
                if (!child.delete()) {
                    allDeleted = false;
                }
            } else if (!MediaUtils.deleteMediaFile(child.getAbsolutePath())) {
                allDeleted = false;
            }
        }
        return allDeleted;
    }
}
