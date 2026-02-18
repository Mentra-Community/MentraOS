package com.mentra.asg_client.service.core.handlers;

import android.util.Log;
import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import com.mentra.asg_client.io.network.interfaces.IWifiScanCallback;
import com.mentra.asg_client.io.network.models.NetworkInfo;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * Handler for WiFi-related commands.
 * Follows Single Responsibility Principle by handling only WiFi commands.
 */
public class WifiCommandHandler implements ICommandHandler {
    private static final String TAG = "WifiCommandHandler";

    private final AsgClientServiceManager serviceManager;
    private final ICommunicationManager communicationManager;
    private final IStateManager stateManager;

    public WifiCommandHandler(AsgClientServiceManager serviceManager,
                              ICommunicationManager communicationManager,
                              IStateManager stateManager) {
        this.serviceManager = serviceManager;
        this.communicationManager = communicationManager;
        this.stateManager = stateManager;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("set_wifi_credentials", "request_wifi_status", "request_wifi_scan", "set_hotspot_state", "disconnect_wifi", "forget_wifi");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case "set_wifi_credentials":
                    return handleSetWifiCredentials(data);
                case "request_wifi_status":
                    return handleRequestWifiStatus();
                case "request_wifi_scan":
                    return handleRequestWifiScan();
                case "set_hotspot_state":
                    return handleSetHotspotState(data);
                case "disconnect_wifi":
                    return handleDisconnectWifi();
                case "forget_wifi":
                    return handleForgetWifi(data);
                default:
                    Log.e(TAG, "Unsupported WiFi command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling WiFi command: " + commandType, e);
            return false;
        }
    }

    /**
     * Handle set WiFi credentials command
     */
    private boolean handleSetWifiCredentials(JSONObject data) {
        try {
            String ssid = data.optString("ssid", "");
            String password = data.optString("password", "");
            if (!ssid.isEmpty()) {
                INetworkManager networkManager = serviceManager.getNetworkManager();
                if (networkManager != null) {
                    Log.d(TAG, "📶 Initiating WiFi connection to: " + ssid);
                    networkManager.connectToWifi(ssid, password);
                    serviceManager.initializeCameraWebServer();

                    // Schedule WiFi status check after connection attempt
                    // This ensures we send status even if broadcast receiver doesn't fire
                    scheduleWifiStatusCheck(ssid);

                    return true;
                } else {
                    Log.e(TAG, "Network manager not available");
                    return false;
                }
            } else {
                Log.e(TAG, "Cannot set WiFi credentials - missing SSID");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling WiFi credentials command", e);
            return false;
        }
    }

    /**
     * Schedule a delayed WiFi status check to ensure mobile app receives status update
     * even if NETWORK_STATE_CHANGED broadcast doesn't fire reliably
     */
    private void scheduleWifiStatusCheck(String targetSsid) {
        new Thread(() -> {
            try {
                // Wait for WiFi connection to establish (3 seconds initial, then poll)
                Log.d(TAG, "📶 ⏱️ Waiting 3s for WiFi connection to establish...");
                Thread.sleep(3000);

                // Poll WiFi status multiple times over 12 seconds (total 15s)
                for (int i = 0; i < 4; i++) {
                    boolean isConnected = stateManager.isConnectedToWifi();
                    String currentSsid = serviceManager.getNetworkManager() != null ?
                            serviceManager.getNetworkManager().getCurrentWifiSsid() : "";

                    Log.d(TAG, "📶 🔍 WiFi status check #" + (i + 1) +
                            ": connected=" + isConnected +
                            ", current_ssid=" + currentSsid +
                            ", target_ssid=" + targetSsid);

                    // Send status if connected to target network, or if we've reached final attempt
                    if ((isConnected && currentSsid.equals(targetSsid)) || i == 3) {
                        Log.d(TAG, "📶 ✅ Sending WiFi status update: " +
                                (isConnected ? "CONNECTED to " + currentSsid : "DISCONNECTED"));
                        communicationManager.sendWifiStatusOverBle(isConnected);
                        break;
                    }

                    // Wait 3 more seconds before next check
                    Thread.sleep(3000);
                }
            } catch (InterruptedException e) {
                Log.w(TAG, "📶 ⚠️ WiFi status check interrupted", e);
                Thread.currentThread().interrupt();
            } catch (Exception e) {
                Log.e(TAG, "📶 💥 Error during WiFi status check", e);
            }
        }).start();
    }

    /**
     * Handle request WiFi status command
     */
    public boolean handleRequestWifiStatus() {
        try {
            if (stateManager.isConnectedToWifi()) {
                communicationManager.sendWifiStatusOverBle(true);
            } else {
                communicationManager.sendWifiStatusOverBle(false);
            }
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling WiFi status request", e);
            return false;
        }
    }

    /**
     * Handle request WiFi scan command
     */
    public boolean handleRequestWifiScan() {
        try {
            INetworkManager networkManager = serviceManager.getNetworkManager();
            if (networkManager != null) {
                new Thread(() -> {
                    try {
                        // Use streaming WiFi scan with callback for immediate results
                        networkManager.scanWifiNetworks(new IWifiScanCallback() {
                            @Override
                            public void onNetworksFoundEnhanced(List<NetworkInfo> networks) {
                                Log.d(TAG, "📡 Streaming " + networks.size() + " enhanced WiFi networks to phone");
                                // Send each batch of networks immediately as they're found
                                communicationManager.sendWifiScanResultsOverBleEnhanced(networks);
                            }

                            @Override
                            public void onScanComplete(int totalNetworksFound) {
                                Log.d(TAG, "📡 WiFi scan completed, total networks found: " + totalNetworksFound);
                                // Could optionally send a completion signal here if needed
                            }

                            @Override
                            public void onScanError(String error) {
                                Log.e(TAG, "📡 WiFi scan error: " + error);
                                // Send empty list on error to indicate scan failure
                                communicationManager.sendWifiScanResultsOverBleEnhanced(new ArrayList<>());
                            }
                        });
                    } catch (Exception e) {
                        Log.e(TAG, "Error scanning for WiFi networks", e);
                        communicationManager.sendWifiScanResultsOverBleEnhanced(new ArrayList<>());
                    }
                }).start();
                return true;
            } else {
                Log.e(TAG, "Network manager not available for WiFi scan");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling WiFi scan request", e);
            return false;
        }
    }

    /**
     * Handle set hotspot state command
     */
    public boolean handleSetHotspotState(JSONObject data) {
        try {
            boolean requestedState = data.optBoolean("enabled", false);
            INetworkManager networkManager = serviceManager.getNetworkManager();

            if (networkManager == null) {
                Log.e(TAG, "Network manager not available for hotspot command");
                return false;
            }

            boolean currentState = networkManager.isHotspotEnabled();

            // Check if already in requested state
            if (currentState == requestedState) {
                Log.d(TAG, "🔥 Hotspot already in requested state (" +
                        (requestedState ? "ENABLED" : "DISABLED") +
                        "), sending current status");

                // Send current status immediately since there won't be a state change broadcast
                sendHotspotStatusToPhone(networkManager);
            } else {
                // State needs to change
                if (requestedState) {
                    networkManager.startHotspot();
                    Log.d(TAG, "🔥 Hotspot start requested - status will be sent via broadcast receiver");
                } else {
                    networkManager.stopHotspot();
                    Log.d(TAG, "🔥 Hotspot stop requested - status will be sent via broadcast receiver");
                }
                // Broadcast receiver will handle sending the status when state actually changes
            }

            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling hotspot state command", e);
            return false;
        }
    }

    /**
     * Handle disconnect WiFi command
     */
    private boolean handleDisconnectWifi() {
        try {
            INetworkManager networkManager = serviceManager.getNetworkManager();
            if (networkManager != null) {
                networkManager.disconnectFromWifi();
                Log.d(TAG, "📶 WiFi disconnect command executed");
                return true;
            } else {
                Log.e(TAG, "Network manager not available for WiFi disconnect");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling WiFi disconnect command", e);
            return false;
        }
    }

    /**
     * Handle forget WiFi command - removes a saved network from the device
     */
    private boolean handleForgetWifi(JSONObject data) {
        try {
            String ssid = data.optString("ssid", "");
            if (ssid.isEmpty()) {
                Log.e(TAG, "📶 Cannot forget WiFi - missing SSID");
                return false;
            }

            Log.d(TAG, "📶 Forgetting WiFi network: " + ssid);

            INetworkManager networkManager = serviceManager.getNetworkManager();
            if (networkManager != null) {
                networkManager.forgetWifiNetwork(ssid);
                Log.d(TAG, "📶 ✅ WiFi forget command executed for: " + ssid);
                return true;
            } else {
                Log.e(TAG, "📶 Network manager not available for WiFi forget");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "📶 Error handling WiFi forget command", e);
            return false;
        }
    }

    /**
     * Send hotspot status to phone via BLE
     */
    private void sendHotspotStatusToPhone(INetworkManager networkManager) {
        try {
            JSONObject hotspotStatus = new JSONObject();
            hotspotStatus.put("type", "hotspot_status_update");
            hotspotStatus.put("hotspot_enabled", networkManager.isHotspotEnabled());

            if (networkManager.isHotspotEnabled()) {
                hotspotStatus.put("hotspot_ssid", networkManager.getHotspotSsid());
                hotspotStatus.put("hotspot_password", networkManager.getHotspotPassword());
                hotspotStatus.put("hotspot_gateway_ip", networkManager.getHotspotGatewayIp());
            }

            boolean sent = communicationManager.sendBluetoothResponse(hotspotStatus);
            Log.d(TAG, "🔥 " + (sent ? "✅ Hotspot status sent successfully" : "❌ Failed to send hotspot status") + ", enabled=" + networkManager.isHotspotEnabled());
        } catch (Exception e) {
            Log.e(TAG, "Error sending hotspot status to phone", e);
        }
    }

} 