package com.mentra.asg_client.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import com.mentra.asg_client.camera.UvcStreamingState;
import com.mentra.asg_client.service.core.AsgClientService;

/**
 * Receives UVC streaming state from MTK when USB webcam mode starts or stops.
 *
 * <p>Broadcast format (from MTK):
 *
 * <pre>
 * action: com.uvc.action.UVC_STREAMING_CHANGED
 * package: com.mentra.asg_client
 * extra: streaming (boolean)
 * </pre>
 */
public class UvcStreamingBroadcastReceiver extends BroadcastReceiver {

    private static final String TAG = "UvcStreamingReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) {
            return;
        }

        if (!UvcStreamingState.ACTION_UVC_STREAMING_CHANGED.equals(intent.getAction())) {
            return;
        }

        boolean streaming = intent.getBooleanExtra(UvcStreamingState.EXTRA_STREAMING, false);
        Log.i(TAG, "MTK UVC streaming changed: streaming=" + streaming);

        UvcStreamingState.setStreaming(streaming);

        Intent serviceIntent = new Intent(context, AsgClientService.class);
        serviceIntent.setAction(AsgClientService.ACTION_UVC_STREAMING_CHANGED);
        serviceIntent.putExtra(AsgClientService.EXTRA_UVC_STREAMING, streaming);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent);
            } else {
                context.startService(serviceIntent);
            }
        } catch (IllegalStateException e) {
            Log.e(TAG, "Failed to start service for UVC state", e);
        }
    }
}
