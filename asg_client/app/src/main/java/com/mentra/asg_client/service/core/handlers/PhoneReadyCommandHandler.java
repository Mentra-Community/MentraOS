package com.mentra.asg_client.service.core.handlers;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.communication.interfaces.IResponseBuilder;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import java.util.Set;
import org.json.JSONObject;

/**
 * Handler for phone ready commands. Follows Single Responsibility Principle by handling only phone
 * ready commands.
 */
public class PhoneReadyCommandHandler implements ICommandHandler {
    private static final String TAG = "PhoneReadyCommandHandler";

    private final ICommunicationManager communicationManager;
    private final IStateManager stateManager;
    private final IResponseBuilder responseBuilder;
    private final AsgClientServiceManager serviceManager;

    public PhoneReadyCommandHandler(
            ICommunicationManager communicationManager,
            IStateManager stateManager,
            IResponseBuilder responseBuilder,
            AsgClientServiceManager serviceManager) {
        this.communicationManager = communicationManager;
        this.stateManager = stateManager;
        this.responseBuilder = responseBuilder;
        this.serviceManager = serviceManager;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("phone_ready");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case "phone_ready":
                    return handlePhoneReady(data);
                default:
                    Log.e(TAG, "Unsupported phone ready command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling phone ready command: " + commandType, e);
            return false;
        }
    }

    /** Handle phone ready command */
    private boolean handlePhoneReady(JSONObject data) {
        Log.d(TAG, "📱 =========================================");
        Log.d(TAG, "📱 HANDLE PHONE READY COMMAND");
        Log.d(TAG, "📱 =========================================");
        Log.d(TAG, "📱 Received phone_ready data: " + (data != null ? data.toString() : "null"));

        try {
            // Reset transport packet sizing to default on new connection.
            // Phone will send set_ble_mtu command after glasses_ready to set the correct size.
            ICompanionTransport transport =
                    serviceManager != null ? serviceManager.getBluetoothManager() : null;
            if (transport != null) {
                transport.onTransportReset();
            }

            Log.d(TAG, "📱 📱 Received phone_ready message - sending glasses_ready response");

            Log.d(TAG, "📱 🔨 Building glasses_ready response...");
            JSONObject response = responseBuilder.buildGlassesReadyResponse();
            K900BluetoothManager k900Manager = getK900BluetoothManager();
            if (k900Manager != null) {
                k900Manager.addPhoneWireCapsIfSupported(response);
            }
            Log.d(TAG, "📱 📤 Sending glasses_ready response: " + response.toString());

            boolean sent = communicationManager.sendBluetoothResponse(response);
            Log.d(
                    TAG,
                    "📱 "
                            + (sent
                                    ? "✅ Glasses ready response sent successfully"
                                    : "❌ Failed to send glasses ready response"));

            // Wire v2 activation is RESPONDER-ONLY on the glasses side. glasses_ready
            // advertises wire_caps (a harmless JSON key to old phones); a v2-capable
            // phone then initiates the binary handshake (maybeSendWireHandshake in the
            // phone SDK) and K900BluetoothManager.handleInboundBinaryFrame replies and
            // activates. Proactively handshaking here - gated on the BES firmware's
            // caps, which say nothing about the PHONE - flipped the entire phone-facing
            // TX path to binary frames that pre-v2 phone apps cannot parse, muting the
            // glasses toward them.
            if (sent && k900Manager != null) {
                Log.d(
                        TAG,
                        "📱 🤝 glasses_ready sent"
                                + (k900Manager.isBesBinaryRelaySupported()
                                        ? " with wire_caps; awaiting phone-initiated v2 handshake"
                                        : "; legacy wire path (BES binary relay not advertised)"));
            }

            // Auto-send WiFi status after glasses_ready
            Log.d(TAG, "📱 🔄 Scheduling WiFi status check in 500ms...");
            new Handler(Looper.getMainLooper())
                    .postDelayed(
                            () -> {
                                Log.d(TAG, "📱 📡 Checking WiFi connection status...");
                                if (stateManager.isConnectedToWifi()) {
                                    Log.d(TAG, "📱 ✅ WiFi connected, sending status...");
                                    communicationManager.sendWifiStatusOverBle(true);
                                } else {
                                    Log.d(TAG, "📱 ❌ WiFi not connected, skipping status send");
                                }

                                // Auto-send hotspot status after glasses_ready
                                Log.d(TAG, "📱 🔥 Sending hotspot status...");
                                sendHotspotStatusToPhone();

                                // Claim RGB LED control authority from BES - tactical timing!
                                Log.d(
                                        TAG,
                                        "📱 🚨 🎖️ CLAIMING RGB LED CONTROL AUTHORITY FROM BES!");
                                sendRgbLedControlAuthority(true);
                            },
                            500);

            return sent;
        } catch (Exception e) {
            Log.e(TAG, "📱 💥 Error handling phone ready command", e);
            return false;
        }
    }

    private K900BluetoothManager getK900BluetoothManager() {
        if (serviceManager == null
                || !(serviceManager.getBluetoothManager() instanceof K900BluetoothManager)) {
            return null;
        }
        return (K900BluetoothManager) serviceManager.getBluetoothManager();
    }

    /** Send current hotspot status to phone via BLE */
    private void sendHotspotStatusToPhone() {
        try {
            // Get network manager from service manager
            INetworkManager networkManager =
                    serviceManager != null ? serviceManager.getNetworkManager() : null;

            if (networkManager == null) {
                Log.w(TAG, "📱 🔥 Network manager not available for hotspot status");
                return;
            }

            // Build hotspot status JSON following same format as WifiCommandHandler
            JSONObject hotspotStatus = new JSONObject();
            hotspotStatus.put("type", "hotspot_status_update");
            hotspotStatus.put("hotspot_enabled", networkManager.isHotspotEnabled());

            if (networkManager.isHotspotEnabled()) {
                hotspotStatus.put("hotspot_ssid", networkManager.getHotspotSsid());
                hotspotStatus.put("hotspot_password", networkManager.getHotspotPassword());
                hotspotStatus.put("hotspot_gateway_ip", networkManager.getHotspotGatewayIp());
            } else {
                hotspotStatus.put("hotspot_ssid", "");
                hotspotStatus.put("hotspot_password", "");
                hotspotStatus.put("hotspot_gateway_ip", "");
            }

            Log.d(TAG, "📱 🔥 Sending hotspot status JSON: " + hotspotStatus.toString());
            boolean sent = communicationManager.sendBluetoothResponse(hotspotStatus);
            Log.d(
                    TAG,
                    "📱 🔥 "
                            + (sent
                                    ? "✅ Hotspot status sent successfully"
                                    : "❌ Failed to send hotspot status")
                            + ", enabled="
                            + networkManager.isHotspotEnabled());

        } catch (Exception e) {
            Log.e(TAG, "📱 🔥 Error sending hotspot status to phone", e);
        }
    }

    /**
     * Send RGB LED control authority command to BES chipset. This tells BES whether MTK (our app)
     * or BES should control the RGB LEDs.
     *
     * @param claimControl true = MTK claims control, false = BES resumes control
     */
    private void sendRgbLedControlAuthority(boolean claimControl) {
        Log.d(TAG, "🚨 sendRgbLedControlAuthority() called - Claim: " + claimControl);

        try {
            // Build full K900 format (C, V, B) to avoid double-wrapping
            JSONObject authorityCommand = new JSONObject();
            authorityCommand.put("C", "android_control_led");
            authorityCommand.put("V", 1); // Version field - REQUIRED to prevent double-wrapping

            // Create proper JSON object for B field
            JSONObject bField = new JSONObject();
            bField.put("on", claimControl);
            authorityCommand.put("B", bField.toString());

            String commandStr = authorityCommand.toString();
            Log.i(TAG, "🚨 Sending RGB LED authority command: " + commandStr);

            if (serviceManager == null || serviceManager.getBluetoothManager() == null) {
                Log.w(TAG, "⚠️ ServiceManager or Bluetooth manager unavailable");
                return;
            }

            if (!serviceManager.getBluetoothManager().isConnected()) {
                Log.w(
                        TAG,
                        "⚠️ Bluetooth not connected; RGB LED authority will be sent when connected");
                return;
            }

            boolean sent =
                    serviceManager
                            .getBluetoothManager()
                            .sendMessage(
                                    commandStr.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            if (sent) {
                Log.i(
                        TAG,
                        "✅ RGB LED control authority "
                                + (claimControl ? "CLAIMED" : "RELEASED")
                                + " successfully");
            } else {
                Log.e(TAG, "❌ Failed to send RGB LED authority command");
            }
        } catch (Exception e) {
            Log.e(TAG, "💥 Error sending RGB LED authority command", e);
        }
    }
}
