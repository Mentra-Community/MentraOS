package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.io.ota.utils.OtaConstants;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.utils.ServiceUtils;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;

import org.json.JSONException;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;
import java.util.Set;

/**
 * Handler for version-related commands.
 * Follows Single Responsibility Principle by handling only version commands.
 */
public class VersionCommandHandler implements ICommandHandler {
    private static final String TAG = "VersionCommandHandler";
    
    private final Context context;
    private final AsgClientServiceManager serviceManager;

    public VersionCommandHandler(Context context, AsgClientServiceManager serviceManager) {
        this.context = context;
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
                    return handleRequestVersion();
                case "cs_syvr":
                    return handleCsSyvrCommand();
                default:
                    Log.e(TAG, "Unsupported version command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling version command: " + commandType, e);
            return false;
        }
    }

    /**
     * Handle request version command
     */
    private boolean handleRequestVersion() {
        try {
            Log.d(TAG, "📊 Received version request - sending version info");
            sendVersionInfo();
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling version request command", e);
            return false;
        }
    }

    /**
     * Handle cs_syvr command (alternative version request)
     */
    public boolean handleCsSyvrCommand() {
        try {
            Log.d(TAG, "📊 Received cs_syvr command - sending version info");
            sendVersionInfo();
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling cs_syvr command", e);
            return false;
        }
    }

    /**
     * Send version information
     */
    private void sendVersionInfo() {
        try {
            JSONObject versionInfo = new JSONObject();
            versionInfo.put("type", "version_info");
            
            String appVersion = "1.0.0";
            String buildNumber = "1";
            
            try {
                appVersion = context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionName;
                buildNumber = String.valueOf(context.getPackageManager().getPackageInfo(context.getPackageName(), 0).versionCode);
            } catch (Exception e) {
                Log.e(TAG, "Error getting app version", e);
            }
            
            versionInfo.put("app_version", appVersion);
            versionInfo.put("build_number", buildNumber);
            versionInfo.put("device_model", ServiceUtils.getDeviceTypeString(context));
            versionInfo.put("android_version", android.os.Build.VERSION.RELEASE);
            versionInfo.put("ota_version_url", OtaConstants.VERSION_JSON_URL);

            Log.d(TAG, "📋 Version info prepared - Device: " + ServiceUtils.getDeviceTypeString(context) + 
                      ", Android: " + android.os.Build.VERSION.RELEASE + 
                      ", OTA URL: " + OtaConstants.VERSION_JSON_URL);

            if (serviceManager.getBluetoothManager() != null && 
                serviceManager.getBluetoothManager().isConnected()) {
                serviceManager.getBluetoothManager().sendData(versionInfo.toString().getBytes(StandardCharsets.UTF_8));
                Log.d(TAG, "✅ Sent version info to phone");
            }
        } catch (JSONException e) {
            Log.e(TAG, "Error creating version info", e);
        }
    }
} 