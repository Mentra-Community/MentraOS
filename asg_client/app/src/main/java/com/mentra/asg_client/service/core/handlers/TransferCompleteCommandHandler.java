package com.mentra.asg_client.service.core.handlers;

import android.util.Log;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import java.util.Set;
import org.json.JSONObject;

/**
 * Handler for transfer_complete commands from phone. This handler processes phone confirmations
 * about file transfer completion.
 */
public class TransferCompleteCommandHandler implements ICommandHandler {
    private static final String TAG = "TransferCompleteHandler";

    private final AsgClientServiceManager serviceManager;

    public TransferCompleteCommandHandler(AsgClientServiceManager serviceManager) {
        this.serviceManager = serviceManager;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("transfer_complete");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case "transfer_complete":
                    return handleTransferComplete(data);
                default:
                    Log.e(TAG, "Unsupported command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling transfer_complete command: " + commandType, e);
            return false;
        }
    }

    /** Handle transfer_complete command from phone */
    private boolean handleTransferComplete(JSONObject data) {
        try {
            String fileName = data.optString("fileName", "");
            boolean success = data.optBoolean("success", false);

            Log.d(TAG, "📱 Received transfer_complete from phone");
            Log.d(TAG, "📱 fileName: " + fileName);
            Log.d(TAG, "📱 success: " + success);

            if (fileName.isEmpty()) {
                Log.e(TAG, "❌ transfer_complete missing fileName");
                return false;
            }

            // Forward to the active transport
            if (serviceManager != null && serviceManager.getBluetoothManager() != null) {
                var bluetoothManager = serviceManager.getBluetoothManager();
                bluetoothManager.onFileTransferConfirmation(fileName, success);
                Log.d(TAG, "✅ Forwarded transfer_complete to transport");

                // A negative confirmation can synchronously start a full-file retry. Preserve the
                // original photo timing state until the transport reaches a terminal result.
                boolean transferInProgress = bluetoothManager.isFileTransferInProgress();
                if (!transferInProgress && serviceManager.getMediaCaptureService() != null) {
                    serviceManager
                            .getMediaCaptureService()
                            .onBlePhotoTransferComplete(fileName, success);
                } else if (transferInProgress) {
                    Log.d(TAG, "⏱️ BLE transfer retry active; deferring terminal photo timing");
                }
                return true;
            } else {
                Log.e(TAG, "❌ BluetoothManager not available");
                return false;
            }

        } catch (Exception e) {
            Log.e(TAG, "💥 Error handling transfer_complete", e);
            return false;
        }
    }
}
