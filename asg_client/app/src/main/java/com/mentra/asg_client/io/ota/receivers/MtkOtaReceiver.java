package com.mentra.asg_client.io.ota.receivers;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.mentra.asg_client.io.ota.events.MtkOtaProgressEvent;
import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import com.mentra.asg_client.io.ota.utils.OtaConstants;

import org.greenrobot.eventbus.EventBus;

/**
 * BroadcastReceiver for MTK firmware OTA update progress
 * Listens to system broadcasts from com.android.systemui about MTK firmware update status
 * 
 * Broadcast format:
 * - Action: "com.xy.otaupdateresult"
 * - Extras:
 *   - "cmd": Command type ("write", "update", "error", "info", "success")
 *   - "msg": Progress message or error description
 */
public class MtkOtaReceiver extends BroadcastReceiver {
    private static final String TAG = OtaConstants.TAG;
    
    // Command constants from MTK OTA system
    public static final String RESULT_CMD_WRITE_PROGRESS = "write";   // Writing firmware (0-100%)
    public static final String RESULT_CMD_UPDATE_PROGRESS = "update"; // Installing firmware (0-100%)
    public static final String RESULT_CMD_ERROR = "error";            // Error occurred
    public static final String RESULT_CMD_INFO = "info";              // General info message
    public static final String RESULT_CMD_SUCCESS = "success";        // Update successful (requires reboot)
    
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        
        String action = intent.getAction();
        if (action == null || !OtaConstants.ACTION_MTK_UPDATE_RESULT.equals(action)) {
            return;
        }
        
        String cmd = intent.getStringExtra("cmd");
        String msg = intent.getStringExtra("msg");
        
        Log.i(TAG, "MTK OTA update - cmd: " + cmd + ", msg: " + msg);
        
        if (cmd == null) {
            Log.w(TAG, "MTK OTA broadcast received with null cmd");
            return;
        }
        
        // Create and post event based on command type
        MtkOtaProgressEvent event;
        
        switch (cmd) {
            case RESULT_CMD_WRITE_PROGRESS:
                event = MtkOtaProgressEvent.createWriteProgress(msg);
                // Log write progress less frequently to avoid spam
                if (shouldLogProgress()) {
                    Log.d(TAG, "MTK OTA write progress: " + msg);
                }
                break;
                
            case RESULT_CMD_UPDATE_PROGRESS:
                event = MtkOtaProgressEvent.createUpdateProgress(msg);
                // Log update progress less frequently to avoid spam
                if (shouldLogProgress()) {
                    Log.d(TAG, "MTK OTA update progress: " + msg);
                }
                break;
                
            case RESULT_CMD_ERROR:
                event = MtkOtaProgressEvent.createError(msg);
                Log.e(TAG, "MTK OTA error: " + msg);
                // Clear in-progress flag on error
                OtaHelper.setMtkOtaInProgress(false);
                break;
                
            case RESULT_CMD_SUCCESS:
                event = MtkOtaProgressEvent.createSuccess(msg);
                Log.i(TAG, "MTK OTA success: " + msg + " (reboot required)");
                // Clear in-progress flag on success
                OtaHelper.setMtkOtaInProgress(false);
                break;
                
            case RESULT_CMD_INFO:
                event = MtkOtaProgressEvent.fromBroadcast(cmd, msg);
                Log.i(TAG, "MTK OTA info: " + msg);
                break;
                
            default:
                event = MtkOtaProgressEvent.fromBroadcast(cmd, msg);
                Log.d(TAG, "MTK OTA unknown cmd: " + cmd + ", msg: " + msg);
                break;
        }
        
        // Post event to EventBus for UI/service consumption
        EventBus.getDefault().post(event);
    }
    
    // Track last progress log time to avoid spamming logs
    private static long lastProgressLogTime = 0;
    private static final long PROGRESS_LOG_INTERVAL_MS = 5000; // Log every 5 seconds max
    
    private boolean shouldLogProgress() {
        long now = System.currentTimeMillis();
        if (now - lastProgressLogTime > PROGRESS_LOG_INTERVAL_MS) {
            lastProgressLogTime = now;
            return true;
        }
        return false;
    }
}
