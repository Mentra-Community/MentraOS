package com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators;

import android.graphics.Bitmap;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.augmentos.augmentoslib.events.GlassesTapOutputEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.SmartGlassesConnectionEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.hci.AudioProcessingCallback;
import com.augmentos.augmentos_core.smarterglassesmanager.utils.SmartGlassesConnectionState;

import org.greenrobot.eventbus.EventBus;
import org.json.JSONObject;

public abstract class SmartGlassesCommunicator {
    //basic glasses utils/settings
    public SmartGlassesConnectionState mConnectState = SmartGlassesConnectionState.DISCONNECTED;
    protected SmartGlassesModes currentMode;
    
    // Audio callback for direct processing (replacing EventBus)
    public AudioProcessingCallback audioProcessingCallback;
    
    public abstract void connectToSmartGlasses();
    public abstract void findCompatibleDeviceNames();
    public abstract void blankScreen();
    public abstract void destroy();
    public final String commandNaturalLanguageString = "Command: ";
    public final String finishNaturalLanguageString = "'finish command' when done";

    //reference card
    public abstract void displayReferenceCardSimple(String title, String body);

    //display text wall
    public abstract void displayTextWall(String text);
    public abstract void displayDoubleTextWall(String textTop, String textBottom);

    public abstract void displayReferenceCardImage(String title, String body, String imgUrl);
    public abstract void displayBulletList(String title, String [] bullets);
    public abstract void displayRowsCard(String[] rowStrings);

    //voice command UI
    public abstract void showNaturalLanguageCommandScreen(String prompt, String naturalLanguageArgs);
    public abstract void updateNaturalLanguageCommandScreen(String naturalLanguageArgs);

    //scrolling text view
    public void startScrollingTextViewMode(String title){
        setMode(SmartGlassesModes.SCROLLING_TEXT_VIEW);
    }

    public abstract void scrollingTextViewIntermediateText(String text);
    public abstract void scrollingTextViewFinalText(String text);
    public abstract void stopScrollingTextViewMode();

    //prompt view card
    public abstract void displayPromptView(String title, String [] options);

    //display text line
    public abstract void displayTextLine(String text);

    public abstract void displayBitmap(Bitmap bmp);

    public abstract void displayCustomContent(String json);

    //home screen
    public abstract void showHomeScreen();

    public abstract void setFontSize(SmartGlassesFontSize fontSize);

    //fonts
    public int LARGE_FONT;
    public int MEDIUM_FONT;
    public int SMALL_FONT;

    public SmartGlassesCommunicator(){
        setFontSizes();
    }

    //must be run and set font sizes
    protected abstract void setFontSizes();

    public SmartGlassesConnectionState getConnectionState(){
        return mConnectState;
    }

    protected boolean isConnected(){
        return (mConnectState == SmartGlassesConnectionState.CONNECTED);
    }

    private static final long DEBOUNCE_DELAY_MS = 500; // Adjust as needed
    private final Handler debounceHandler = new Handler(Looper.getMainLooper());
    private SmartGlassesConnectionState lastConnectState = null; // Tracks the last state processed
    private boolean isPending = false;

    public void connectionEvent(SmartGlassesConnectionState connectState) {
        if (connectState == lastConnectState && isPending) {
            // Ignore duplicate calls within debounce period
            return;
        }

        // Update the last state and mark as pending
        lastConnectState = connectState;
        isPending = true;

        // Cancel any previously scheduled execution
        debounceHandler.removeCallbacksAndMessages(null);

        // Schedule the actual logic execution after the debounce delay
        debounceHandler.postDelayed(() -> {
            // Perform the actual connection logic
            mConnectState = connectState;
            EventBus.getDefault().post(new SmartGlassesConnectionEvent(mConnectState));
//            if (isConnected()) {
//                showHomeScreen();
//            }

            // Reset the pending flag after execution
            isPending = false;
        }, DEBOUNCE_DELAY_MS);
    }
    public void tapEvent(int num){
        EventBus.getDefault().post(new GlassesTapOutputEvent(num, false, System.currentTimeMillis()));
    }

    public void setMode(SmartGlassesModes mode){
        currentMode = mode;
    }

    public void updateGlassesBrightness(int brightness) {}
    public void updateGlassesAutoBrightness(boolean autoBrightness) {}
    public void updateGlassesHeadUpAngle(int headUpAngle) {}
    public void updateGlassesDepthHeight(int depth, int height) {}
    public void sendExitCommand() {}

    public void changeSmartGlassesMicrophoneState(boolean isMicrophoneEnabled) {}
    
    /**
     * Registers an audio processing callback to receive audio data directly
     * instead of using EventBus. This is a battery optimization.
     * 
     * @param callback The callback to register
     */
    public void registerAudioProcessingCallback(AudioProcessingCallback callback) {
        this.audioProcessingCallback = callback;
        Log.e("SmartGlassesCommunicator", "⭐⭐⭐ REGISTERED AUDIO CALLBACK: " +
              (callback != null ? "NOT NULL" : "NULL") + " in " + this.getClass().getSimpleName());
    }
    
    /**
     * Sends a custom command to the smart glasses
     * This is a default implementation that can be overridden by specific communicators
     * 
     * @param commandJson The command in JSON string format
     */
    public void sendCustomCommand(String commandJson) {
        // Default implementation does nothing
        // Device-specific communicators should override this method
        // e.g., MentraLiveSGC will handle WiFi credentials commands
    }
    
    /**
     * Requests the smart glasses to take a photo
     * Default implementation does nothing - specific communicators should override
     * 
     * @param requestId The unique ID for this photo request
     * @param appId The ID of the app requesting the photo
     */
    public void requestPhoto(String requestId, String appId) {
        // Default implementation does nothing
        Log.d("SmartGlassesCommunicator", "Photo request not implemented for this device");
    }
    
    /**
     * Requests the smart glasses to start an RTMP stream
     * Default implementation does nothing - specific communicators should override
     * 
     * @param parameters Optional parameters for the stream
     */
    public void requestRtmpStreamStart(JSONObject parameters) {
        // Default implementation does nothing
        Log.d("SmartGlassesCommunicator", "RTMP stream request not implemented for this device");
    }
    
    /**
     * Requests the smart glasses to stop the current RTMP stream
     * Default implementation does nothing - specific communicators should override
     */
    public void stopRtmpStream() {
        // Default implementation does nothing
        Log.d("SmartGlassesCommunicator", "RTMP stream stop not implemented for this device");
    }
    
    /**
     * Sends a keep alive message for the current RTMP stream
     * Default implementation does nothing - specific communicators should override
     * 
     * @param message The keep alive message with streamId, ackId, and timestamp
     */
    public void sendRtmpStreamKeepAlive(JSONObject message) {
        // Default implementation does nothing
        Log.d("SmartGlassesCommunicator", "RTMP stream keep alive not implemented for this device");
    }
    
    /**
     * Requests the smart glasses to scan for available WiFi networks
     * Default implementation does nothing - specific communicators should override
     */
    public void requestWifiScan() {
        // Default implementation does nothing
        Log.d("SmartGlassesCommunicator", "WiFi scan request not implemented for this device");
    }
    
    /**
     * Sends WiFi credentials to the smart glasses
     * Default implementation does nothing - specific communicators should override
     * 
     * @param ssid The WiFi network name
     * @param password The WiFi password
     */
    public void sendWifiCredentials(String ssid, String password) {
        // Default implementation does nothing
        Log.d("SmartGlassesCommunicator", "WiFi credential setting not implemented for this device");
    }
}
