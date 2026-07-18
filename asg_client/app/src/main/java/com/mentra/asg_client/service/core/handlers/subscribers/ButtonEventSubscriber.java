package com.mentra.asg_client.service.core.handlers.subscribers;

import android.content.Context;
import android.os.PowerManager;
import android.util.Log;
import com.mentra.asg_client.audio.AudioAssets;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.io.peripheral.events.ButtonEvent;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.service.core.constants.BatteryConstants;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.settings.VideoSettings;
import com.mentra.asg_client.utils.WakeLockManager;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Reacts to {@link ButtonEvent}s. Camera presses are always forwarded to the phone and may trigger
 * local capture; a power-button short press announces the battery level over audio. Moved verbatim
 * from {@code K900CommandHandler.handleConfigurableButtonPress}/{@code handlePhotoCapture}/{@code
 * sendButtonPressToPhone}/{@code handleKeyEventReport}.
 */
public final class ButtonEventSubscriber implements IPeripheralBus.McuEventListener {

    private static final String TAG = "ButtonEventSubscriber";

    private final AsgClientServiceManager serviceManager;
    private final IHardwareManager hardwareManager;
    private final IStateManager stateManager;

    public ButtonEventSubscriber(
            AsgClientServiceManager serviceManager,
            IHardwareManager hardwareManager,
            IStateManager stateManager) {
        this.serviceManager = serviceManager;
        this.hardwareManager = hardwareManager;
        this.stateManager = stateManager;
    }

    @Override
    public void onMcuEvent(McuEvent event) {
        if (!(event instanceof ButtonEvent)) {
            return;
        }
        ButtonEvent buttonEvent = (ButtonEvent) event;
        switch (buttonEvent.getType()) {
            case CAMERA_SHORT_PRESS:
                Log.d(TAG, "📸 Camera button short pressed - handling with configurable mode");
                handleConfigurableButtonPress(false); // false = short press
                break;
            case CAMERA_LONG_PRESS:
                Log.d(TAG, "📹 Camera button long pressed - handling with configurable mode");
                handleConfigurableButtonPress(true); // true = long press
                break;
            case POWER_SHORT_PRESS:
                handlePowerButtonShortPress();
                break;
            default:
                break;
        }
    }

    /**
     * Handle button press with universal forwarding and gallery mode check Button presses are
     * ALWAYS forwarded to phone/apps Local capture only happens when camera/gallery app is active
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
     * Handle photo/video capture based on gallery mode state Only captures if camera/gallery app is
     * currently active OR if glasses are disconnected
     */
    private void handlePhotoCapture(boolean isLongPress) {
        // Check if gallery/camera app is active before capturing
        boolean isSaveInGalleryMode = serviceManager.getAsgSettings().isSaveInGalleryMode();

        // Check if glasses are connected to phone
        boolean isConnected = serviceManager.isConnected();

        // LOG CONNECTION STATE FOR DEBUGGING
        Log.i(
                TAG,
                "📸 Photo capture decision - Gallery Mode: "
                        + (isSaveInGalleryMode ? "ACTIVE" : "INACTIVE")
                        + ", Connection State: "
                        + (isConnected ? "CONNECTED" : "DISCONNECTED"));

        // Skip capture only if: camera app NOT running AND phone IS connected
        if (!isSaveInGalleryMode && isConnected) {
            Log.d(
                    TAG,
                    "📸 Camera app not active and connected to phone - skipping local capture (button press already forwarded to apps)");
            return;
        }

        if (!isConnected) {
            Log.d(
                    TAG,
                    "📸 Disconnected from phone - proceeding with local capture regardless of gallery mode");
        } else {
            Log.d(TAG, "📸 Camera app active - proceeding with local capture");
        }

        MediaCaptureService captureService = serviceManager.getMediaCaptureService();
        if (captureService == null) {
            Log.d(TAG, "MediaCaptureService is null, initializing");
            return;
        }

        // Capture light is mandatory for privacy.
        boolean ledEnabled = true;

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
                Log.d(
                        TAG,
                        "📹 Starting video recording (long press) with LED: "
                                + ledEnabled
                                + ", battery: "
                                + batteryLevel
                                + "%");

                // Check if battery is too low to start recording
                if (batteryLevel >= 0 && batteryLevel < BatteryConstants.MIN_BATTERY_LEVEL) {
                    Log.w(
                            TAG,
                            "🚫 Battery too low to start recording: "
                                    + batteryLevel
                                    + "% (minimum "
                                    + BatteryConstants.MIN_BATTERY_LEVEL
                                    + "% required)");

                    // Play audio feedback
                    captureService.playBatteryLowSound();

                    return;
                }

                // Get saved video settings for button press
                VideoSettings videoSettings =
                        serviceManager.getAsgSettings().getButtonVideoSettings();
                int maxRecordingTimeMinutes =
                        serviceManager.getAsgSettings().getButtonMaxRecordingTimeMinutes();
                captureService.startVideoRecording(
                        videoSettings, ledEnabled, maxRecordingTimeMinutes, batteryLevel);
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
                captureService.takePhotoLocally(photoSize, ledEnabled, true);
            }
        }
    }

    /** Send button press to phone via Bluetooth */
    private void sendButtonPressToPhone(boolean isLongPress) {
        if (serviceManager != null
                && serviceManager.getBluetoothManager() != null
                && serviceManager.getBluetoothManager().isConnected()) {
            try {
                JSONObject buttonObject = new JSONObject();
                buttonObject.put("type", "button_press");
                buttonObject.put("buttonId", "camera");
                buttonObject.put("pressType", isLongPress ? "long" : "short");
                buttonObject.put("timestamp", System.currentTimeMillis());

                String jsonString = buttonObject.toString();
                Log.d(TAG, "Formatted button press response: " + jsonString);

                serviceManager.getBluetoothManager().sendMessage(jsonString.getBytes());
            } catch (JSONException e) {
                Log.e(TAG, "Error creating button press response", e);
            }
        }
    }

    /**
     * Handle power button short press (sr_keyevt button=0 type=0). Announces current battery level
     * via audio.
     */
    private void handlePowerButtonShortPress() {
        Log.d(TAG, "🔘 Key event - power button short press");

        if (!hardwareManager.supportsAudioPlayback()) {
            Log.w(TAG, "⚠️ Hardware does not support audio playback");
            return;
        }

        // Check if device is awake, wake it if not (without interfering with existing wake
        // locks)
        Context context = serviceManager != null ? serviceManager.getContext() : null;
        if (context != null) {
            PowerManager powerManager =
                    (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (powerManager != null && !powerManager.isInteractive()) {
                // Device is asleep - acquire a short wake lock for battery query + audio
                // playback
                Log.d(
                        TAG,
                        "🔋 Device is asleep, acquiring short wake lock for battery announcement");
                WakeLockManager.acquireScreen(
                        context, WakeLockManager.WakeOwner.BATTERY_ANNOUNCE, 5000); // 5 seconds for query + audio
            }
        }

        // Use hardwareManager to get battery level - this will query BES if cache is stale
        int batteryLevel = hardwareManager.getBatteryLevel();
        if (batteryLevel >= 0) {
            String asset = AudioAssets.getBatteryLevelAsset(batteryLevel);
            Log.i(TAG, "🔋 Announcing battery level: " + batteryLevel + "% -> " + asset);

            // TODO: implement this at a later time
            hardwareManager.playAudioAsset(asset);
        } else {
            Log.w(TAG, "🔋 Battery level unknown, cannot announce");
        }
    }
}
