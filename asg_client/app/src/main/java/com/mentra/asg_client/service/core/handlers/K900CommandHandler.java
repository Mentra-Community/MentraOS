package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import com.mentra.asg_client.audio.AudioAssets;
import com.mentra.asg_client.utils.WakeLockManager;
import com.mentra.asg_client.io.bes.BesOtaManager;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.io.hardware.core.HardwareManagerFactory;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.hardware.managers.K900HardwareManager;
import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.settings.VideoSettings;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.service.core.constants.BatteryConstants;
import com.mentra.asg_client.service.utils.SysProp;
import com.mentra.asg_client.SysControl;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Handles K900 protocol commands.
 * Follows Single Responsibility Principle by handling only K900 protocol commands.
 * Follows Open/Closed Principle by being extensible for new K900 commands.
 */
public class K900CommandHandler {
    private static final String TAG = "K900CommandHandler";

    private final AsgClientServiceManager serviceManager;
    private final IStateManager stateManager;
    private final ICommunicationManager communicationManager;
    private final IHardwareManager hardwareManager;
    private final Handler mainHandler;

    public K900CommandHandler(AsgClientServiceManager serviceManager,
                              IStateManager stateManager,
                              ICommunicationManager communicationManager) {
        this.mainHandler = new Handler(Looper.getMainLooper());
        this.serviceManager = serviceManager;
        this.stateManager = stateManager;
        this.communicationManager = communicationManager;
        this.hardwareManager = HardwareManagerFactory.getInstance(serviceManager.getContext());
    }

    /**
     * Process K900 protocol commands
     *
     * @param json The K900 command JSON
     */
    public void processK900Command(JSONObject json) {
        try {
            String command = json.optString("C", "");
            JSONObject bData = json.optJSONObject("B");
            Log.d(TAG, "📦 Received K900 command: " + command);

            switch (command) {
                case "cs_pho":
                    handleCameraButtonShortPress();
                    break;

                case "cs_vdo":
                    handleCameraButtonLongPress();
                    break;

                case "hm_htsp":
                case "mh_htsp":
                    handleHotspotStart();
                    break;

                case "hm_batv":
                    handleBatteryVoltage(bData);
                    break;

                case "cs_flts":
                    // File transfer ACK - pass to K900BluetoothManager
                    handleFileTransferAck(bData);
                    break;

                // ---------------------------------------------
                // BES → MTK Response Handlers (Touch/Swipe Only)
                // ---------------------------------------------
                
                case "sr_swst":
                    // Switch status report (touch events)
                    handleSwitchStatusReport(bData);
                    break;

                case "sr_tpevt":
                    // Touch event report
                    handleTouchEventReport(bData);
                    break;

                case "sr_fbvol":
                    // Swipe volume status report
                    handleSwipeVolumeStatusReport(bData);
                    break;

                case "hm_ota":
                    // BES OTA authorization response
                    handleBesOtaAuthorizationResponse(bData);
                    break;

                case "hs_ntfy":
                    // Hardware notification (new firmware format for button presses)
                    handleHardwareNotification(bData);
                    break;

                case "sr_vad":
                    // Voice Activity Detection - acknowledge but don't process
                    handleVoiceActivityDetection(bData);
                    break;

                case "hs_syvr":
                    // System version report from BES chip
                    handleSystemVersionReport(bData);
                    break;

                case "sr_btaddr":
                    // BT MAC address response from BES chip
                    handleBtAddrResponse(bData);
                    break;

                case "sr_keyevt":
                    // Power button short press - announce battery level
                    handleKeyEventReport(bData);
                    break;

                case "cs_shut":
                    // BES requesting graceful shutdown - send acknowledgment and shutdown MTK
                    handleShutdownCommand();
                    break;

                default:
                    Log.d(TAG, "📦 Unknown K900 command: " + command);
                    break;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error processing K900 command", e);
        }
    }

    /**
     * Handle camera button short press
     * 1. Immediately send RGB LED authority claim
     * 2. After 5 seconds, activate blue LED
     */
    private void handleCameraButtonShortPress() {
        Log.d(TAG, "📸 Camera button short pressed - handling with configurable mode");

        handleConfigurableButtonPress(false); // false = short press
    }

    /**
     * Handle camera button long press
     */
    private void handleCameraButtonLongPress() {
        Log.d(TAG, "📹 Camera button long pressed - handling with configurable mode");
        handleConfigurableButtonPress(true); // true = long press
    }

    /**
     * Handle hardware notification (new firmware format for button presses)
     * Parses the notification message and routes to appropriate button handler
     */
    private void handleHardwareNotification(JSONObject bData) {
        if (bData == null) {
            Log.w(TAG, "📦 Hardware notification received but no B field data");
            return;
        }

        String message = bData.optString("msg", "");
        int type = bData.optInt("type", -1);

        Log.d(TAG, "📦 Hardware notification - Type: " + type + ", Message: " + message);

        // Route to appropriate handler based on message content
        if (message.equals("button click")) {
            Log.d(TAG, "📦 Routing to short button press handler (new firmware format)");
            handleCameraButtonShortPress();
        } else if (message.equals("button long click")) {
            Log.d(TAG, "📦 Routing to long button press handler (new firmware format)");
            handleCameraButtonLongPress();
        } else {
            Log.d(TAG, "📦 Unknown hardware notification message: " + message);
        }
    }

    /**
     * Handle voice activity detection events
     * Just log these - no processing needed
     */
    private void handleVoiceActivityDetection(JSONObject bData) {
        if (bData != null) {
            int on = bData.optInt("on", -1);
            Log.d(TAG, "🎤 Voice Activity Detection event received - VAD " + (on == 1 ? "ON" : "OFF"));
        } else {
            Log.d(TAG, "🎤 Voice Activity Detection event received");
        }
    }

    /**
     * Handle system version report from MCU
     * Logs firmware version and Bluetooth information, caches firmware version for sending to phone
     */
    private void handleSystemVersionReport(JSONObject bData) {
        if (bData != null) {
            String version = bData.optString("version", "unknown");
            String bleName = bData.optString("ble", "unknown");
            String btName = bData.optString("bt", "unknown");
            String btAddr = bData.optString("btaddr", "unknown");
            String bleAddr = bData.optString("bleaddr", "unknown");

            Log.i(TAG, "📋 System Version Report - Firmware: " + version);
            Log.i(TAG, "📋 BLE Name: " + bleName + ", BT Name: " + btName);
            Log.i(TAG, "📋 BT Address: " + btAddr + ", BLE Address: " + bleAddr);

            // Cache the MCU firmware version so it can be sent to phone when connected
            if (serviceManager != null && serviceManager.getAsgSettings() != null &&
                !version.equals("unknown") && !version.isEmpty()) {
                serviceManager.getAsgSettings().setMcuFirmwareVersion(version);
            }

            // Request BT MAC address from BES chip (if not already saved)
            // This is a good time to request since we know UART is working
            Context context = serviceManager != null ? serviceManager.getContext() : null;
            if (context != null) {
                String existingMac = SysProp.getBesBtMac(context);
                if (existingMac == null || existingMac.isEmpty()) {
                    Log.i(TAG, "📋 No BT MAC address cached - requesting from BES chip");
                    // Delay request slightly to allow BES to finish startup
                    mainHandler.postDelayed(() -> requestBtMacAddress(), 500);
                } else {
                    Log.d(TAG, "📋 BT MAC address already cached: " + existingMac);
                }
            }
        } else {
            Log.d(TAG, "📋 System version report received but no B field data");
        }
    }

    /**
     * Handle BT MAC address response from BES chip (sr_btaddr)
     * Saves the MAC address to system properties for persistent storage
     */
    private void handleBtAddrResponse(JSONObject bData) {
        if (bData != null) {
            String btAddr = bData.optString("btaddr", "");

            if (!btAddr.isEmpty()) {
                Log.i(TAG, "📋 BT MAC Address received from BES: " + btAddr);

                // Save to system properties (persistent across reboots)
                Context context = serviceManager != null ? serviceManager.getContext() : null;
                if (context != null) {
                    SysProp.setBesBtMac(context, btAddr);
                    Log.i(TAG, "✅ BT MAC Address saved to system properties");
                } else {
                    Log.w(TAG, "⚠️ Context not available - cannot save BT MAC to system properties");
                }
            } else {
                Log.w(TAG, "⚠️ BT MAC Address response received but btaddr field is empty");
            }
        } else {
            Log.d(TAG, "📋 BT MAC Address response received but no B field data");
        }
    }

    /**
     * Handle key event report (sr_keyevt) - power button short press
     * Announces current battery level via audio
     */
    private void handleKeyEventReport(JSONObject bData) {
        int button = bData != null ? bData.optInt("button", -1) : -1;
        int type = bData != null ? bData.optInt("type", -1) : -1;

        Log.d(TAG, "🔘 Key event - button: " + button + ", type: " + type);

        // button=0, type=0 = power button short press
        if (button == 0 && type == 0) {
            if (!hardwareManager.supportsAudioPlayback()) {
                Log.w(TAG, "⚠️ Hardware does not support audio playback");
                return;
            }

            // Check if device is awake, wake it if not (without interfering with existing wake locks)
            Context context = serviceManager != null ? serviceManager.getContext() : null;
            if (context != null) {
                PowerManager powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
                if (powerManager != null && !powerManager.isInteractive()) {
                    // Device is asleep - acquire a short wake lock for battery query + audio playback
                    Log.d(TAG, "🔋 Device is asleep, acquiring short wake lock for battery announcement");
                    WakeLockManager.acquireScreenWakeLock(context, 5000); // 5 seconds for query + audio
                }
            }

            // Use hardwareManager to get battery level - this will query BES if cache is stale
            int batteryLevel = hardwareManager.getBatteryLevel();
            if (batteryLevel >= 0) {
                String asset = AudioAssets.getBatteryLevelAsset(batteryLevel);
                Log.i(TAG, "🔋 Announcing battery level: " + batteryLevel + "% -> " + asset);
                
                // TODO: implement this at a later time
                //hardwareManager.playAudioAsset(asset);
            } else {
                Log.w(TAG, "🔋 Battery level unknown, cannot announce");
            }
        }
    }

    /**
     * Handle shutdown command from BES (cs_shut).
     * BES sends this when power button is held - we need to:
     * 1. Send sr_shut acknowledgment back to BES
     * 2. Perform graceful MTK shutdown
     *
     * This prevents sudden power cuts that could corrupt MTK firmware.
     * BES will wait up to 2 seconds for sr_shut before force-cutting power.
     */
    private void handleShutdownCommand() {
        Log.i(TAG, "🔌 Received shutdown command (cs_shut) from BES");

        // Step 1: Send acknowledgment back to BES
        sendShutdownAcknowledgment();

        // Step 2: Perform graceful shutdown after a small delay to ensure ACK is sent
        mainHandler.postDelayed(() -> {
            Log.i(TAG, "🔌 Initiating MTK shutdown...");
            Context context = serviceManager != null ? serviceManager.getContext() : null;
            if (context != null) {
                SysControl.shut(context);
            } else {
                Log.e(TAG, "🔌 Cannot shutdown - context not available");
            }
        }, 100); // 100ms delay to ensure sr_shut is sent first
    }

    /**
     * Send shutdown acknowledgment (sr_shut) back to BES.
     * This tells BES that MTK received the shutdown command and is shutting down.
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

            boolean sent = serviceManager.getBluetoothManager().sendData(
                commandStr.getBytes(java.nio.charset.StandardCharsets.UTF_8));

            if (sent) {
                Log.i(TAG, "✅ Shutdown acknowledgment (sr_shut) sent to BES");
            } else {
                Log.e(TAG, "❌ Failed to send shutdown acknowledgment");
            }
        } catch (JSONException e) {
            Log.e(TAG, "💥 Error creating shutdown acknowledgment", e);
        }
    }

    /**
     * Send request to BES chip to get BT MAC address (cs_btaddr)
     * Call this on startup/UART connection to retrieve the unique device identifier
     */
    public void requestBtMacAddress() {
        Log.i(TAG, "📋 Requesting BT MAC address from BES chip");

        try {
            JSONObject k900Command = new JSONObject();
            k900Command.put("C", "cs_btaddr");
            k900Command.put("V", 1);
            k900Command.put("B", "");

            String commandStr = k900Command.toString();
            Log.d(TAG, "📤 Sending BT MAC request: " + commandStr);

            if (serviceManager == null || serviceManager.getBluetoothManager() == null) {
                Log.w(TAG, "⚠️ ServiceManager or Bluetooth manager unavailable");
                return;
            }

            if (!serviceManager.getBluetoothManager().isConnected()) {
                Log.w(TAG, "⚠️ Bluetooth not connected; cannot request BT MAC address");
                return;
            }

            boolean sent = serviceManager.getBluetoothManager().sendData(
                commandStr.getBytes(java.nio.charset.StandardCharsets.UTF_8));

            if (sent) {
                Log.i(TAG, "✅ BT MAC address request sent");
            } else {
                Log.e(TAG, "❌ Failed to send BT MAC address request");
            }
        } catch (JSONException e) {
            Log.e(TAG, "💥 Error creating BT MAC address request", e);
        }
    }

    /**
     * Handle hotspot start command
     */
    private void handleHotspotStart() {
        Log.d(TAG, "📦 Starting hotspot from K900 command");
        if (serviceManager != null && serviceManager.getNetworkManager() != null) {
            serviceManager.getNetworkManager().startHotspot();
        }
    }

    /**
     * Handle battery voltage command
     */
    private void handleBatteryVoltage(JSONObject bData) {
        Log.d(TAG, "🔋 Processing battery voltage data from K900");
        if (bData != null) {
            int newBatteryPercentage = bData.optInt("pt", -1);
            int newBatteryVoltage = bData.optInt("vt", -1);

            if (newBatteryPercentage != -1) {
                Log.d(TAG, "🔋 Battery percentage: " + newBatteryPercentage + "%");
            }
            if (newBatteryVoltage != -1) {
                Log.d(TAG, "🔋 Battery voltage: " + newBatteryVoltage + "mV");
            }

            // Notify K900HardwareManager of battery response (for cache update)
            if (hardwareManager instanceof K900HardwareManager) {
                ((K900HardwareManager) hardwareManager).onBatteryResponse(newBatteryPercentage, newBatteryVoltage);
            }

            // Send battery status over BLE if we have valid data
            if (newBatteryPercentage != -1 || newBatteryVoltage != -1) {
                sendBatteryStatusOverBle(newBatteryPercentage, newBatteryVoltage);
            }
        } else {
            Log.w(TAG, "hm_batv received but no B field data");
        }
    }

    /**
     * Handle file transfer ACK from glasses
     */
    private void handleFileTransferAck(JSONObject bData) {
        if (bData != null && serviceManager != null) {
            int state = bData.optInt("state", -1);
            int index = bData.optInt("index", -1);

            if (state != -1 && index != -1) {
                Log.d(TAG, "📦 File transfer ACK: state=" + state + ", index=" + index);

                // Get K900BluetoothManager and forward the ACK
                K900BluetoothManager bluetoothManager = (K900BluetoothManager) serviceManager.getBluetoothManager();
                if (bluetoothManager != null) {
                    bluetoothManager.handleFileTransferAck(state, index);
                }
            } else {
                Log.w(TAG, "cs_flts received but missing state or index");
            }
        }
    }

    /**
     * Send BES OTA authorization request to BES chip
     * Must be called before starting BES firmware update
     */
    public void sendBesOtaAuthorizationRequest() {
        Log.i(TAG, "🔧 Sending BES OTA authorization request");
        
        try {
            // Build full K900 format: C, V, B (all three required to avoid double-wrapping!)
            JSONObject k900Command = new JSONObject();
            k900Command.put("C", "mh_ota");
            k900Command.put("V", 1);  // Version field - REQUIRED to prevent double-wrapping
            k900Command.put("B", "{}");  // Empty body for authorization request
            
            String commandStr = k900Command.toString();
            Log.i(TAG, "🔧 Sending BES OTA authorization command: " + commandStr);
            
            if (serviceManager == null || serviceManager.getBluetoothManager() == null) {
                Log.e(TAG, "❌ ServiceManager or Bluetooth manager unavailable");
                // Notify BesOtaManager of failure
                BesOtaManager manager = BesOtaManager.getInstance();
                if (manager != null) {
                    manager.onAuthorizationDenied();
                }
                return;
            }

            if (!serviceManager.getBluetoothManager().isConnected()) {
                Log.e(TAG, "❌ Bluetooth not connected; cannot send BES OTA authorization request");
                // Notify BesOtaManager of failure
                BesOtaManager manager = BesOtaManager.getInstance();
                if (manager != null) {
                    manager.onAuthorizationDenied();
                }
                return;
            }

            boolean sent = serviceManager.getBluetoothManager().sendData(
                commandStr.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            
            if (sent) {
                Log.i(TAG, "✅ BES OTA authorization request sent - waiting for response");
            } else {
                Log.e(TAG, "❌ Failed to send BES OTA authorization request");
                // Notify BesOtaManager of failure
                BesOtaManager manager = BesOtaManager.getInstance();
                if (manager != null) {
                    manager.onAuthorizationDenied();
                }
            }
        } catch (JSONException e) {
            Log.e(TAG, "💥 Error creating BES OTA authorization request", e);
            // Notify BesOtaManager of failure
            BesOtaManager manager = BesOtaManager.getInstance();
            if (manager != null) {
                manager.onAuthorizationDenied();
            }
        } catch (Exception e) {
            Log.e(TAG, "💥 Error sending BES OTA authorization request", e);
            // Notify BesOtaManager of failure
            BesOtaManager manager = BesOtaManager.getInstance();
            if (manager != null) {
                manager.onAuthorizationDenied();
            }
        }
    }

    /**
     * Handle BES OTA authorization response from BES chip
     * Response to our "mh_ota" request
     */
    private void handleBesOtaAuthorizationResponse(JSONObject bData) {
        Log.i(TAG, "🔧 Received BES OTA authorization response");
        
        boolean authorized = false;
        if (bData != null) {
            int result = bData.optInt("result", 0);
            authorized = (result == 1);
            Log.d(TAG, "🔧 BES OTA authorization: " + (authorized ? "GRANTED" : "DENIED") + " (result=" + result + ")");
        } else {
            Log.w(TAG, "⚠️ BES OTA authorization response received but no B field data");
        }
        
        // Notify BesOtaManager of authorization result
        BesOtaManager manager = BesOtaManager.getInstance();
        if (manager != null) {
            if (authorized) {
                manager.onAuthorizationGranted();
            } else {
                manager.onAuthorizationDenied();
            }
        } else {
            Log.e(TAG, "❌ BesOtaManager not available - cannot process authorization response");
        }
    }

    /**
     * Handle button press with universal forwarding and gallery mode check
     * Button presses are ALWAYS forwarded to phone/apps
     * Local capture only happens when camera/gallery app is active
     * Also enables BES touch/swipe event listening
     */
    private void handleConfigurableButtonPress(boolean isLongPress) {
        if (serviceManager != null && serviceManager.getAsgSettings() != null) {
            String pressType = isLongPress ? "long" : "short";
            Log.d(TAG, "Handling " + pressType + " button press");

            // ALWAYS send button press to phone/apps
            Log.d(TAG, "📱 Forwarding button press to phone/apps (universal forwarding)");
            sendButtonPressToPhone(isLongPress);

            // Check if camera/gallery app is active for local capture
            handlePhotoCapture(isLongPress);
        }
    }

    /**
     * Handle photo/video capture based on gallery mode state
     * Only captures if camera/gallery app is currently active OR if glasses are disconnected
     */
    private void handlePhotoCapture(boolean isLongPress) {
        // Check if gallery/camera app is active before capturing
        boolean isSaveInGalleryMode = serviceManager
            .getAsgSettings()
            .isSaveInGalleryMode();

        // Check if glasses are connected to phone
        boolean isConnected = serviceManager.isConnected();

        // LOG CONNECTION STATE FOR DEBUGGING
        Log.i(TAG, "📸 Photo capture decision - Gallery Mode: " + (isSaveInGalleryMode ? "ACTIVE" : "INACTIVE") +
                   ", Connection State: " + (isConnected ? "CONNECTED" : "DISCONNECTED"));

        // Skip capture only if: camera app NOT running AND phone IS connected
        if (!isSaveInGalleryMode && isConnected) {
            Log.d(TAG, "📸 Camera app not active and connected to phone - skipping local capture (button press already forwarded to apps)");
            return;
        }

        if (!isConnected) {
            Log.d(TAG, "📸 Disconnected from phone - proceeding with local capture regardless of gallery mode");
        } else {
            Log.d(TAG, "📸 Camera app active - proceeding with local capture");
        }

        MediaCaptureService captureService = serviceManager.getMediaCaptureService();
        if (captureService == null) {
            Log.d(TAG, "MediaCaptureService is null, initializing");
            return;
        }

        // Get LED setting
        boolean ledEnabled = serviceManager.getAsgSettings().getButtonCameraLedEnabled();

        // Get current battery level (with null check)
        int batteryLevel = -1;
        if (stateManager != null) {
            batteryLevel = stateManager.getBatteryLevel();
        } else {
            Log.w(TAG, "⚠️ StateManager not available - cannot check battery level");
        }

        if (isLongPress) {
            // Long press behavior:
            // - If video is recording, stop it (pause/stop with video stop feedback)
            // - If video is not recording, start it
            if (captureService.isRecordingVideo()) {
                Log.d(TAG, "⏹️ Stopping video recording (long press during recording)");
                captureService.stopVideoRecording();
            } else {
                Log.d(TAG, "📹 Starting video recording (long press) with LED: " + ledEnabled + ", battery: " + batteryLevel + "%");

                // Check if battery is too low to start recording
                if (batteryLevel >= 0 && batteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
                    Log.w(TAG, "🚫 Battery too low to start recording: " + batteryLevel + "% (minimum " + BatteryConstants.MIN_BATTERY_LEVEL + "% required)");

                    // Play audio feedback
                    captureService.playBatteryLowSound();

                    return;
                }

                // Get saved video settings for button press
                VideoSettings videoSettings = serviceManager.getAsgSettings().getButtonVideoSettings();
                int maxRecordingTimeMinutes = serviceManager.getAsgSettings().getButtonMaxRecordingTimeMinutes();
                captureService.startVideoRecording(videoSettings, ledEnabled, maxRecordingTimeMinutes, batteryLevel);
            }
        } else {
            // Short press behavior
            // If video is recording, stop it. Otherwise take a photo.
            if (captureService.isRecordingVideo()) {
                Log.d(TAG, "⏹️ Stopping video recording (short press during recording)");
                captureService.stopVideoRecording();
            } else {
                Log.d(TAG, "📸 Taking photo locally (short press) with LED: " + ledEnabled);
                // Get saved photo size for button press
                String photoSize = serviceManager.getAsgSettings().getButtonPhotoSize();
                captureService.takePhotoLocally(photoSize, ledEnabled);
            }
        }
    }

    /**
     * Send button press to phone via Bluetooth
     */
    private void sendButtonPressToPhone(boolean isLongPress) {
        if (serviceManager != null && serviceManager.getBluetoothManager() != null &&
                serviceManager.getBluetoothManager().isConnected()) {
            try {
                JSONObject buttonObject = new JSONObject();
                buttonObject.put("type", "button_press");
                buttonObject.put("buttonId", "camera");
                buttonObject.put("pressType", isLongPress ? "long" : "short");
                buttonObject.put("timestamp", System.currentTimeMillis());

                String jsonString = buttonObject.toString();
                Log.d(TAG, "Formatted button press response: " + jsonString);

                serviceManager.getBluetoothManager().sendData(jsonString.getBytes());
            } catch (JSONException e) {
                Log.e(TAG, "Error creating button press response", e);
            }
        }
    }

    /**
     * Send battery status over BLE
     */
    private void sendBatteryStatusOverBle(int batteryPercentage, int batteryVoltage) {
        // Calculate charging status based on voltage
        boolean isCharging = batteryVoltage > 3900;

        // Always update local state, regardless of BLE connection
        if (stateManager != null) {
            stateManager.updateBatteryStatus(batteryPercentage, isCharging, System.currentTimeMillis());
        }

        // Send to phone only if BLE is connected
        if (serviceManager != null && serviceManager.getBluetoothManager() != null &&
                serviceManager.getBluetoothManager().isConnected()) {
            try {
                JSONObject obj = new JSONObject();
                obj.put("type", "battery_status");
                obj.put("charging", isCharging);
                obj.put("percent", batteryPercentage);
                String jsonString = obj.toString();
                Log.d(TAG, "Formatted battery status message: " + jsonString);
                serviceManager.getBluetoothManager().sendData(jsonString.getBytes());
                Log.d(TAG, "Sent battery status via BLE");
            } catch (JSONException e) {
                Log.e(TAG, "Error creating battery status JSON", e);
            }
        }
    }

    /**
     * Activate blue RGB LED
     * Uses full K900 format (C, V, B) to avoid double-wrapping by K900ProtocolUtils
     */
    private void activateBlueRgbLedViaService() {
        Log.d(TAG, "🚨 💙 activateBlueRgbLedViaService() called");
        
        try {
            // Build LED parameters JSON string
            JSONObject ledParams = new JSONObject();
            ledParams.put("led", 2);  // Blue LED
            ledParams.put("ontime", 5000);  // 5 seconds on
            ledParams.put("offime", 1000);  // 1 second off
            ledParams.put("count", 1);  // Single cycle
            
            // Build full K900 format: C, V, B (all three required to avoid double-wrapping!)
            JSONObject k900Command = new JSONObject();
            k900Command.put("C", "cs_ledon");
            k900Command.put("V", 1);  // Version field - REQUIRED to prevent double-wrapping
            k900Command.put("B", ledParams.toString());
            
            String commandStr = k900Command.toString();
            Log.i(TAG, "🚨 💙 Sending blue RGB LED command: " + commandStr);
            
            if (serviceManager == null || serviceManager.getBluetoothManager() == null) {
                Log.w(TAG, "⚠️ ServiceManager or Bluetooth manager unavailable");
                return;
            }

            if (!serviceManager.getBluetoothManager().isConnected()) {
                Log.w(TAG, "⚠️ Bluetooth not connected; cannot activate blue RGB LED");
                return;
            }

            boolean sent = serviceManager.getBluetoothManager().sendData(
                commandStr.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            
            if (sent) {
                Log.i(TAG, "✅ 💙 Blue RGB LED activated successfully via camera button");
            } else {
                Log.e(TAG, "❌ 💙 Failed to activate blue RGB LED");
            }
        } catch (JSONException e) {
            Log.e(TAG, "💥 Error creating blue RGB LED command", e);
        } catch (Exception e) {
            Log.e(TAG, "💥 Error activating blue RGB LED", e);
        }
    }

    // ---------------------------------------------
    // BES → MTK Response Handlers (Touch/Swipe Only)
    // ---------------------------------------------

    /**
     * Handle switch status report (touch events)
     */
    private void handleSwitchStatusReport(JSONObject bData) {
        Log.d(TAG, "📦 Processing switch status report");
        
        if (bData != null) {
            int type = bData.optInt("type", -1);
            int switchValue = bData.optInt("switch", -1);
            
            Log.i(TAG, "📦 Switch status - Type: " + type + ", Switch: " + switchValue);
            
            // Send switch status over BLE
            sendSwitchStatusOverBle(type, switchValue);
        } else {
            Log.w(TAG, "📦 Switch status report received but no B field data");
        }
    }

    /**
     * Send RGB LED control authority command to BES chipset.
     * This tells BES whether MTK (our app) or BES should control the RGB LEDs.
     * 
     * @param claimControl true = MTK claims control, false = BES resumes control
     */
    private void sendRgbLedControlAuthority(boolean claimControl) {
        Log.d(TAG, "🚨 sendRgbLedControlAuthority() called - Claim: " + claimControl);
        
        try {
            // Build full K900 format (C, V, B) to avoid double-wrapping
            JSONObject authorityCommand = new JSONObject();
            authorityCommand.put("C", "android_control_led");
            authorityCommand.put("V", 1);  // Version field - REQUIRED to prevent double-wrapping
            
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
                Log.w(TAG, "⚠️ Bluetooth not connected; RGB LED authority will be sent when connected");
                return;
            }

            boolean sent = serviceManager.getBluetoothManager().sendData(commandStr.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            if (sent) {
                Log.i(TAG, "✅ RGB LED control authority " + (claimControl ? "CLAIMED" : "RELEASED") + " successfully");
            } else {
                Log.e(TAG, "❌ Failed to send RGB LED authority command");
            }
        } catch (JSONException e) {
            Log.e(TAG, "💥 Error creating RGB LED authority command", e);
        } catch (Exception e) {
            Log.e(TAG, "💥 Error sending RGB LED authority command", e);
        }
    }

    /**
     * Handle touch event report
     */
    private void handleTouchEventReport(JSONObject bData) {
        Log.d(TAG, "#@$@@$Processing touch event report");
        
        if (bData != null) {
            int type = bData.optInt("type", -1);
            
            String gestureType = getTouchGestureType(type);
            Log.i(TAG, "📦 Touch event - Type: " + gestureType + " (" + type + ")");
            
            // Send touch event over BLE
            sendTouchEventOverBle(type);
        } else {
            Log.w(TAG, "📦 Touch event report received but no B field data");
        }
    }

    /**
     * Handle swipe volume status report
     */
    private void handleSwipeVolumeStatusReport(JSONObject bData) {
        Log.d(TAG, "📦 Processing swipe volume status report");
        
        if (bData != null) {
            int switchValue = bData.optInt("switch", -1);
            boolean isEnabled = (switchValue == 1);
            
            Log.i(TAG, "📦 Swipe volume status - Enabled: " + isEnabled);
            
            // Send swipe volume status over BLE
            sendSwipeVolumeStatusOverBle(isEnabled);
        } else {
            Log.w(TAG, "📦 Swipe volume status report received but no B field data");
        }
    }

    // ---------------------------------------------
    // BLE Response Senders (Touch/Swipe Only)
    // ---------------------------------------------

    /**
     * Send switch status over BLE
     */
    private void sendSwitchStatusOverBle(int type, int switchValue) {
        if (serviceManager != null && serviceManager.getBluetoothManager() != null &&
                serviceManager.getBluetoothManager().isConnected()) {
            try {
                JSONObject obj = new JSONObject();
                obj.put("type", "switch_status");
                obj.put("switch_type", type);
                obj.put("switch_value", switchValue);
                obj.put("timestamp", System.currentTimeMillis());
                
                String jsonString = obj.toString();
                Log.d(TAG, "📤 Sending switch status: " + jsonString);
                serviceManager.getBluetoothManager().sendData(jsonString.getBytes());
            } catch (JSONException e) {
                Log.e(TAG, "Error creating switch status JSON", e);
            }
        }
    }

    /**
     * Send touch event over BLE
     */
    private void sendTouchEventOverBle(int type) {
        if (serviceManager != null && serviceManager.getBluetoothManager() != null &&
                serviceManager.getBluetoothManager().isConnected()) {
            try {
                JSONObject obj = new JSONObject();
                obj.put("type", "touch_event");
                obj.put("gesture_type", type);
                obj.put("gesture_name", getTouchGestureType(type));
                obj.put("timestamp", System.currentTimeMillis());
                
                String jsonString = obj.toString();
                Log.d(TAG, "📤 Sending touch event: " + jsonString);
                serviceManager.getBluetoothManager().sendData(jsonString.getBytes());
            } catch (JSONException e) {
                Log.e(TAG, "Error creating touch event JSON", e);
            }
        }
    }

    /**
     * Send swipe volume status over BLE
     */
    private void sendSwipeVolumeStatusOverBle(boolean isEnabled) {
        if (serviceManager != null && serviceManager.getBluetoothManager() != null &&
                serviceManager.getBluetoothManager().isConnected()) {
            try {
                JSONObject obj = new JSONObject();
                obj.put("type", "swipe_volume_status");
                obj.put("enabled", isEnabled);
                obj.put("timestamp", System.currentTimeMillis());
                
                String jsonString = obj.toString();
                Log.d(TAG, "📤 Sending swipe volume status: " + jsonString);
                serviceManager.getBluetoothManager().sendData(jsonString.getBytes());
            } catch (JSONException e) {
                Log.e(TAG, "Error creating swipe volume status JSON", e);
            }
        }
    }

    /**
     * Get touch gesture type name
     */
    private String getTouchGestureType(int type) {
        switch (type) {
            case 0: return "single_tap";
            case 1: return "double_tap";
            case 2: return "triple_tap";
            case 3: return "long_press";
            case 4: return "forward_swipe";
            case 5: return "backward_swipe";
            case 6: return "up_swipe";
            case 7: return "down_swipe";
            default: return "unknown";
        }
    }
} 