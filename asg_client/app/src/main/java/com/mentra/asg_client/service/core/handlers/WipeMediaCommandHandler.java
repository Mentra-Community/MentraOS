package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.file.managers.ThumbnailManager;
import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.io.media.managers.MediaUploadQueueManager;
import com.mentra.asg_client.io.media.utils.MediaUtils;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.pairing.PairingTransferCaptureGate;

import org.json.JSONObject;

import java.io.File;
import java.util.Set;

/**
 * Ownership-transfer pairing commands for Mentra Live.
 *
 * <p>{@code wipe_media}: verified wipe (success requires empty gallery). Captures are gated by
 * transfer id until finalize/abort clears the barrier. Media deleted mid-transfer is not restored
 * on abort.
 *
 * <p>{@code pairing_finalize} / {@code pairing_abort}: clear the ASG capture barrier so the new
 * (or restored) owner can capture immediately. Ownership-state results remain BES-owned.
 */
public class WipeMediaCommandHandler implements ICommandHandler {
    private static final String TAG = "WipeMediaCommandHandler";

    private final ICommunicationManager communicationManager;
    private final AsgClientServiceManager serviceManager;
    private final FileManager fileManager;
    private final Context appContext;

    public WipeMediaCommandHandler(
            ICommunicationManager communicationManager,
            AsgClientServiceManager serviceManager,
            FileManager fileManager) {
        this.communicationManager = communicationManager;
        this.serviceManager = serviceManager;
        this.fileManager = fileManager;
        Context ctx = null;
        if (serviceManager != null && serviceManager.getContext() != null) {
            ctx = serviceManager.getContext().getApplicationContext();
        }
        this.appContext = ctx;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("wipe_media", "pairing_finalize", "pairing_abort");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        if ("pairing_finalize".equals(commandType) || "pairing_abort".equals(commandType)) {
            return handleTransferEnd(commandType, data);
        }
        if (!"wipe_media".equals(commandType)) {
            return false;
        }

        final String requestId = data != null ? data.optString("request_id", "") : "";
        final String transferId = data != null ? data.optString("transfer_id", "") : "";
        String error = null;
        boolean success = false;

        try {
            if (transferId != null && !transferId.isEmpty()) {
                armCaptureBarrier(transferId);
            }
            if (!AsgConstants.ENABLE_PAIRING_MEDIA_WIPE) {
                // Keep wipe implementation below; pairing temporarily skips gallery delete.
                Log.i(TAG, "wipe_media skipped (ENABLE_PAIRING_MEDIA_WIPE=false)"
                        + " transfer_id=" + transferId + " request_id=" + requestId);
                success = true;
            } else {
                pauseAndCancelCapture();

                boolean deleted = wipeAllMediaRoots();
                boolean empty = verifyGalleryEmpty();
                success = deleted && empty;
                if (!success && error == null) {
                    error = empty ? "delete_incomplete" : "gallery_not_empty";
                }

                // Only clear upload queue after a verified empty gallery so a failed wipe does
                // not leave the previous owner with a wiped queue and partial files.
                if (success) {
                    MediaUploadQueueManager queueManager = serviceManager != null
                            ? serviceManager.getMediaQueueManager()
                            : null;
                    if (queueManager != null) {
                        queueManager.clearQueue();
                    }
                }
                Log.i(TAG, "wipe_media success=" + success + " transfer_id=" + transferId
                        + " request_id=" + requestId);
            }
        } catch (Exception e) {
            Log.e(TAG, "wipe_media failed", e);
            success = false;
            error = e.getMessage() != null ? e.getMessage() : "wipe_exception";
        }

        try {
            JSONObject response = new JSONObject();
            response.put("type", "wipe_media_result");
            response.put("success", success);
            if (requestId != null && !requestId.isEmpty()) {
                response.put("request_id", requestId);
            }
            if (transferId != null && !transferId.isEmpty()) {
                response.put("transfer_id", transferId);
            }
            if (error != null) {
                response.put("error", error);
            }
            return communicationManager.sendBluetoothResponse(response);
        } catch (Exception e) {
            Log.e(TAG, "Failed to send wipe_media_result", e);
            return false;
        }
    }

    /**
     * Clear the ASG-side capture barrier when ownership transfer ends. Does not emit
     * {@code pairing_transfer_result} — BES owns that acknowledgment.
     */
    private boolean handleTransferEnd(String commandType, JSONObject data) {
        final String transferId = data != null ? data.optString("transfer_id", "") : "";
        boolean cleared = clearCaptureBarrier(appContext, transferId);
        if (cleared) {
            Log.i(TAG, commandType + " cleared capture barrier transfer_id=" + transferId);
        } else {
            Log.w(
                    TAG,
                    commandType
                            + " did not match active capture barrier; leaving armed transfer_id="
                            + transferId);
        }
        // Return true so CommandProcessor treats the command as handled on ASG. BES may also
        // process ownership state on its own path; ASG only releases the media gate here.
        return true;
    }

    private void pauseAndCancelCapture() {
        if (serviceManager == null) {
            return;
        }
        MediaCaptureService capture = serviceManager.getMediaCaptureService();
        if (capture == null) {
            return;
        }
        try {
            capture.cancelInFlightCapturesForPairingWipe();
        } catch (Exception e) {
            Log.w(TAG, "Failed to cancel in-flight captures before wipe", e);
        }
    }

    private boolean wipeAllMediaRoots() {
        boolean ok = true;
        File mediaDir = fileManager != null ? fileManager.getDefaultMediaDirectory() : null;
        ok = deleteDirectoryContents(mediaDir) && ok;

        if (mediaDir != null) {
            ok = deleteDirectoryContents(new File(mediaDir, FileManager.GALLERY_TRASH_DIR_NAME)) && ok;
            ok = deleteDirectoryContents(new File(mediaDir, FileManager.SDK_PENDING_DIR_NAME)) && ok;
            ok = deleteDirectoryContents(new File(mediaDir, FileManager.GALLERY_METADATA_DIR_NAME)) && ok;
        }

        if (fileManager != null) {
            ThumbnailManager thumbs = fileManager.getThumbnailManager();
            if (thumbs != null && thumbs.getThumbnailDirectory() != null) {
                ok = deleteDirectoryContents(thumbs.getThumbnailDirectory()) && ok;
            }
        }
        return ok;
    }

    private boolean verifyGalleryEmpty() {
        File mediaDir = fileManager != null ? fileManager.getDefaultMediaDirectory() : null;
        if (mediaDir == null || !mediaDir.exists()) {
            return true;
        }
        return !directoryContainsPrimaryMedia(mediaDir);
    }

    private boolean directoryContainsPrimaryMedia(File directory) {
        File[] children = directory.listFiles();
        if (children == null) {
            return false;
        }
        for (File child : children) {
            if (child.isDirectory()) {
                String name = child.getName();
                if (FileManager.GALLERY_TRASH_DIR_NAME.equals(name)
                        || FileManager.SDK_PENDING_DIR_NAME.equals(name)
                        || FileManager.GALLERY_METADATA_DIR_NAME.equals(name)) {
                    // Hidden dirs should also be empty after wipe.
                    if (directoryContainsPrimaryMedia(child)) {
                        return true;
                    }
                    continue;
                }
                if (directoryContainsPrimaryMedia(child)) {
                    return true;
                }
            } else if (isPrimaryMediaFile(child)) {
                return true;
            }
        }
        return false;
    }

    private static boolean isPrimaryMediaFile(File file) {
        if (file == null || !file.isFile()) {
            return false;
        }
        String name = file.getName().toLowerCase();
        return name.endsWith(".jpg")
                || name.endsWith(".jpeg")
                || name.endsWith(".png")
                || name.endsWith(".mp4")
                || name.endsWith(".mov")
                || name.endsWith(".webm");
    }

    private void armCaptureBarrier(String transferId) {
        PairingTransferCaptureGate.arm(appContext, transferId);
    }

    /** True while an ownership-transfer capture barrier is active for any transfer. */
    public static boolean isCaptureBarrierActive(Context context) {
        return PairingTransferCaptureGate.isActive(context);
    }

    public static void clearCaptureBarrier(Context context) {
        PairingTransferCaptureGate.clear(context);
    }

    public static boolean clearCaptureBarrier(Context context, String transferId) {
        return PairingTransferCaptureGate.clear(context, transferId);
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
                if (!child.delete()) {
                    allDeleted = false;
                }
            }
        }
        return allDeleted;
    }
}
