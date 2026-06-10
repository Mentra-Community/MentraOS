package com.mentra.asg_client.service.core.handlers.subscribers;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.io.peripheral.events.ShutdownEvent;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.core.SystemControllerFactory;
import java.nio.charset.StandardCharsets;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Reacts to {@link ShutdownEvent}s (BES requesting graceful shutdown). Sends the {@code sr_shut}
 * acknowledgment back to BES, finalizes any active recording, then performs a graceful MTK shutdown
 * after a short delay. Moved verbatim from {@code K900CommandHandler.handleShutdownCommand}/{@code
 * sendShutdownAcknowledgment}/{@code stopActiveRecordingBeforeShutdown}.
 */
public final class ShutdownEventSubscriber implements IPeripheralBus.McuEventListener {

    private static final String TAG = "ShutdownEventSubscriber";

    private final AsgClientServiceManager serviceManager;
    private final Context context;
    private final Handler mainHandler;

    public ShutdownEventSubscriber(AsgClientServiceManager serviceManager, Context context) {
        this.serviceManager = serviceManager;
        this.context = context;
        this.mainHandler = new Handler(Looper.getMainLooper());
    }

    @Override
    public void onMcuEvent(McuEvent event) {
        if (!(event instanceof ShutdownEvent)) {
            return;
        }
        handleShutdownCommand();
    }

    /**
     * Handle shutdown command from BES (cs_shut). BES sends this when power button is held - we
     * need to: 1. Send sr_shut acknowledgment back to BES 2. Perform graceful MTK shutdown
     *
     * <p>This prevents sudden power cuts that could corrupt MTK firmware. BES will wait up to 2
     * seconds for sr_shut before force-cutting power.
     */
    private void handleShutdownCommand() {
        Log.i(TAG, "🔌 Received shutdown command (cs_shut) from BES");

        // Step 1: Send acknowledgment back to BES
        sendShutdownAcknowledgment();

        // Step 2: Stop active video recording to finalize moov atom and prevent corruption
        stopActiveRecordingBeforeShutdown();

        // Step 3: Perform graceful shutdown after delay to ensure ACK is sent and recording
        // finalized
        mainHandler.postDelayed(
                () -> {
                    Log.i(TAG, "🔌 Initiating MTK shutdown...");
                    Context ctx = serviceManager != null ? serviceManager.getContext() : context;
                    if (ctx != null) {
                        SystemControllerFactory.get(ctx).shutdown();
                    } else {
                        Log.e(TAG, "🔌 Cannot shutdown - context not available");
                    }
                },
                500); // 500ms delay to allow MediaRecorder.stop() to finalize
    }

    /**
     * Stop any active video recording before shutdown to prevent file corruption. MPEG4 writes its
     * moov atom during MediaRecorder.stop() — if the device powers off before that, the recorded
     * file is unplayable.
     */
    private void stopActiveRecordingBeforeShutdown() {
        try {
            if (serviceManager == null) {
                Log.w(TAG, "⚠️ ServiceManager not available - cannot check for active recordings");
                return;
            }

            MediaCaptureService mediaCaptureService = serviceManager.getMediaCaptureService();
            if (mediaCaptureService != null && mediaCaptureService.isRecordingVideo()) {
                Log.i(
                        TAG,
                        "🎥 Active video recording detected - stopping before shutdown to prevent corruption");
                mediaCaptureService.stopVideoRecording();
                Log.i(TAG, "🎥 Video recording stopped successfully before shutdown");
            }
        } catch (Exception e) {
            Log.e(TAG, "❌ Error stopping recording before shutdown", e);
        }
    }

    /**
     * Send shutdown acknowledgment (sr_shut) back to BES. This tells BES that MTK received the
     * shutdown command and is shutting down.
     */
    private void sendShutdownAcknowledgment() {
        Log.i(TAG, "🔌 Sending shutdown acknowledgment (sr_shut) to BES");

        try {
            JSONObject k900Command = new JSONObject();
            k900Command.put("C", "sr_shut");
            k900Command.put("V", 1);
            k900Command.put("B", "");

            String commandStr = k900Command.toString();
            Log.d(TAG, "📤 Sending sr_shut: " + commandStr);

            if (serviceManager == null || serviceManager.getBluetoothManager() == null) {
                Log.w(TAG, "⚠️ ServiceManager or Bluetooth manager unavailable");
                return;
            }

            if (!serviceManager.getBluetoothManager().isConnected()) {
                Log.w(TAG, "⚠️ Bluetooth not connected; cannot send shutdown acknowledgment");
                return;
            }

            boolean sent =
                    serviceManager
                            .getBluetoothManager()
                            .sendMessage(commandStr.getBytes(StandardCharsets.UTF_8));

            if (sent) {
                Log.i(TAG, "✅ Shutdown acknowledgment (sr_shut) sent to BES");
            } else {
                Log.e(TAG, "❌ Failed to send shutdown acknowledgment");
            }
        } catch (JSONException e) {
            Log.e(TAG, "💥 Error creating shutdown acknowledgment", e);
        }
    }
}
