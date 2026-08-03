package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.file.managers.ThumbnailManager;
import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.io.media.managers.MediaUploadQueueManager;
import com.mentra.asg_client.io.media.utils.MediaUtils;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;

import org.json.JSONObject;

import java.io.File;
import java.util.Set;

/**
 * Wipes all gallery media during ownership-transfer pairing.
 *
 * <p>Verified wipe: success requires empty gallery (no residual primary media). Captures are
 * gated by transfer id until clear (finalize window / explicit clear). Media deleted mid-transfer
 * is not restored on abort.
 */
public class WipeMediaCommandHandler implements ICommandHandler {
    private static final String TAG = "WipeMediaCommandHandler";
    private static final String PREFS = "pairing_transfer_capture_gate";
    private static final String KEY_TRANSFER_ID = "transfer_id";
    private static final String KEY_UNTIL_MS = "until_ms";
    /** Matches BES ownership-transfer window (5 minutes). */
    private static final long TRANSFER_WINDOW_MS = 5 * 60 * 1000L;

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
        return Set.of("wipe_media");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        if (!"wipe_media".equals(commandType)) {
            return false;
        }

        final String requestId = data != null ? data.optString("request_id", "") : "";
        final String transferId = data != null ? data.optString("transfer_id", "") : "";
        String error = null;
        boolean success = false;

        try {
            pauseAndCancelCapture();

            MediaUploadQueueManager queueManager = serviceManager != null
                    ? serviceManager.getMediaQueueManager()
                    : null;
            if (queueManager != null) {
                queueManager.clearQueue();
            }

            boolean deleted = wipeAllMediaRoots();
            boolean empty = verifyGalleryEmpty();
            success = deleted && empty;
            if (!success && error == null) {
                error = empty ? "delete_incomplete" : "gallery_not_empty";
            }

            if (success && transferId != null && !transferId.isEmpty()) {
                armCaptureBarrier(transferId);
            }
            Log.i(TAG, "wipe_media success=" + success + " transfer_id=" + transferId
                    + " request_id=" + requestId);
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

    private void pauseAndCancelCapture() {
        if (serviceManager == null) {
            return;
        }
        MediaCaptureService capture = serviceManager.getMediaCaptureService();
        if (capture == null) {
            return;
        }
        try {
            if (capture.isRecordingVideo()) {
                Log.i(TAG, "Stopping active video recording before wipe");
                capture.stopVideoRecording();
            }
        } catch (Exception e) {
            Log.w(TAG, "Failed to stop active recording before wipe", e);
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
        if (appContext == null) {
            return;
        }
        SharedPreferences prefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        prefs.edit()
                .putString(KEY_TRANSFER_ID, transferId)
                .putLong(KEY_UNTIL_MS, System.currentTimeMillis() + TRANSFER_WINDOW_MS)
                .apply();
    }

    /** True while an ownership-transfer capture barrier is active for any transfer. */
    public static boolean isCaptureBarrierActive(Context context) {
        if (context == null) {
            return false;
        }
        SharedPreferences prefs =
                context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long until = prefs.getLong(KEY_UNTIL_MS, 0L);
        if (until <= 0L) {
            return false;
        }
        if (System.currentTimeMillis() > until) {
            prefs.edit().clear().apply();
            return false;
        }
        return prefs.getString(KEY_TRANSFER_ID, null) != null;
    }

    public static void clearCaptureBarrier(Context context) {
        if (context == null) {
            return;
        }
        context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
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
