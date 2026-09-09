package com.mentra.asg_client.service.core.handlers;

import android.util.Log;

import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import com.mentra.asg_client.io.ota.session.OtaSessionManager;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.communication.interfaces.IResponseBuilder;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;

import org.json.JSONObject;

import java.util.Set;

/**
 * Handler for ping commands.
 * Follows Single Responsibility Principle by handling only ping commands.
 * Also resets heartbeat timeout to maintain connection state.
 */
public class PingCommandHandler implements ICommandHandler {
    private static final String TAG = "PingCommandHandler";

    private final ICommunicationManager communicationManager;
    private final IResponseBuilder responseBuilder;
    private final AsgClientServiceManager serviceManager;

    public PingCommandHandler(ICommunicationManager communicationManager,
                            IResponseBuilder responseBuilder,
                            AsgClientServiceManager serviceManager) {
        this.communicationManager = communicationManager;
        this.responseBuilder = responseBuilder;
        this.serviceManager = serviceManager;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("ping");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case "ping":
                    return handlePing(data);
                default:
                    Log.e(TAG, "Unsupported ping command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling ping command: " + commandType, e);
            return false;
        }
    }

    /**
     * Handle ping command
     */
    private boolean handlePing(JSONObject data) {
        Log.d(TAG, "🏓 =========================================");
        Log.d(TAG, "🏓 HANDLE PING COMMAND");
        Log.d(TAG, "🏓 =========================================");
        Log.d(TAG, "🏓 Received ping data: " + (data != null ? data.toString() : "null"));

        try {
            refreshOtaHotspotActivity();
            Log.d(TAG, "🏓 🔨 Building ping response...");
            JSONObject pingResponse = responseBuilder.buildPingResponse();
            Log.d(TAG, "🏓 📤 Sending ping response: " + pingResponse.toString());

            boolean sent = communicationManager.sendBluetoothResponse(pingResponse);
            Log.d(TAG, "🏓 " + (sent ? "✅ Ping command handled successfully" : "❌ Failed to send ping response"));
            return sent;
        } catch (Exception e) {
            Log.e(TAG, "🏓 💥 Error handling ping command", e);
            return false;
        }
    }

    /** Let the existing OTA heartbeat refresh the hotspot's shared inactivity timer. */
    private void refreshOtaHotspotActivity() {
        try {
            if (serviceManager == null || serviceManager.getContext() == null) {
                return;
            }
            INetworkManager networkManager = serviceManager.getNetworkManager();
            if (networkManager != null
                    && networkManager.isHotspotEnabled()
                    && new OtaSessionManager(serviceManager.getContext()).hasActiveSession()) {
                networkManager.updateHttpActivity();
            }
        } catch (Exception e) {
            // Hotspot bookkeeping must never make the BLE heartbeat fail.
            Log.w(TAG, "Could not refresh OTA hotspot activity", e);
        }
    }
}
