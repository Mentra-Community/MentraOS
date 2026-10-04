package com.mentra.asg_client.service.core.handlers;

import android.util.Log;

import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;

import org.json.JSONObject;

import java.util.Set;

/**
 * Handler for version-related commands. Delegates to AsgClientService.sendVersionInfo() for the
 * actual implementation to maintain a single source of truth for version info sending.
 */
public class VersionCommandHandler implements ICommandHandler {
    private static final String TAG = "VersionCommandHandler";

    private final AsgClientServiceManager serviceManager;

    public VersionCommandHandler(AsgClientServiceManager serviceManager) {
        this.serviceManager = serviceManager;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("request_version", "cs_syvr");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case "request_version":
                case "cs_syvr":
                    Log.d(
                            TAG,
                            "📊 Received "
                                    + commandType
                                    + " command - delegating to AsgClientService");
                    if (serviceManager.getService() != null) {
                        if ("request_version".equals(commandType)
                                && data.optBoolean("fresh_bes", false)
                                && serviceManager.getBluetoothManager()
                                        instanceof K900BluetoothManager) {
                            // A cached version reply is not a hardware observation. The coordinator
                            // admits one probe only when UART/OTA ownership permits it; the reply
                            // below retains its existing correlation and cached-value semantics.
                            ((K900BluetoothManager) serviceManager.getBluetoothManager())
                                    .requestSystemVersionRefresh();
                        }
                        String requestId = data.optString("request_id", null);
                        serviceManager.getService().sendVersionInfo(requestId);
                        return true;
                    } else {
                        Log.e(TAG, "Service is null, cannot send version info");
                        return false;
                    }
                default:
                    Log.e(TAG, "Unsupported version command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling version command: " + commandType, e);
            return false;
        }
    }
}
