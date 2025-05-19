package com.augmentos.augmentos_core.smarterglassesmanager.hci;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothDevice;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioRecord;
import android.media.AudioRecordingConfiguration;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.telephony.PhoneStateListener;
import android.telephony.TelephonyManager;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;

import androidx.annotation.RequiresApi;
import androidx.core.content.ContextCompat;

import com.augmentos.augmentos_core.smarterglassesmanager.SmartGlassesManager;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.MicModeChangedEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.smartglassesconnection.SmartGlassesRepresentative;

import org.greenrobot.eventbus.EventBus;

import java.nio.ByteBuffer;

/**
 * Dynamic microphone manager that prioritizes SCO mode but gracefully handles conflicts.
 * 
 * Priorities (when using phone mic):
 * 1. SCO mode by default (high quality, supports Bluetooth headsets)
 * 2. Normal phone mic if SCO unavailable or conflicts
 * 3. Glasses mic as last resort if available
 */
public class PhoneMicrophoneManager {
    private static final String TAG = "WearableAi_PhoneMicrophoneManager";
    
    public enum MicStatus { 
        SCO_MODE,      // Using Bluetooth SCO mode 
        NORMAL_MODE,  // Using normal phone mic
        GLASSES_MIC,  // Using glasses onboard mic
        PAUSED        // Microphone recording paused
    }
    
    /**
     * Listener interface for PhoneMicrophoneManager events
     */
    public interface PhoneMicListener {
        /**
         * Called when a permission error occurs
         */
        void onPermissionError();
    }
    
    private MicStatus currentStatus = MicStatus.PAUSED;
    
    private final Context context;
    private final AudioChunkCallback audioChunkCallback;
    private final AudioProcessingCallback audioProcessingCallback;
    private MicrophoneLocalAndBluetooth micInstance;
    private SmartGlassesRepresentative glassesRep;
    private PhoneMicListener phoneMicListener;
    
    // Phone call detection
    private TelephonyManager telephonyManager;
    private PhoneStateListener phoneStateListener;
    private boolean isPhoneCallActive = false;

    // Audio conflict detection 
    private AudioManager audioManager;
    private BroadcastReceiver audioStateReceiver;
    private boolean isExternalAudioActive = false;
    private boolean isReceiverRegistered = false;
    
    // Audio recording detection (API 23+)
    private AudioManager.AudioRecordingCallback audioRecordingCallback;
    private final List<Integer> ourAudioClientIds = new ArrayList<>();
    private boolean isAudioRecordingCallbackRegistered = false;
    
    // Debounce for mode changes to prevent feedback loops
    private long lastModeChangeTime = 0;
    private static final long MODE_CHANGE_DEBOUNCE_MS = 2000; // 2 second minimum between mode changes
    
    // Retry logic
    private int scoRetries = 0;
    private static final int MAX_SCO_RETRIES = 3;
    
    // Handler for running operations on the main thread
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    
    /**
     * Creates a new PhoneMicrophoneManager that handles dynamic switching between microphone modes.
     * 
     * @param context Application context
     * @param audioProcessingCallback Callback for processed audio data
     * @param glassesRep SmartGlassesRepresentative for accessing glasses mic
     */
    public PhoneMicrophoneManager(Context context, AudioProcessingCallback audioProcessingCallback, 
                                SmartGlassesRepresentative glassesRep) {
        this(context, audioProcessingCallback, glassesRep, null);
    }
    
    /**
     * Creates a new PhoneMicrophoneManager with a permission error listener.
     * 
     * @param context Application context
     * @param audioProcessingCallback Callback for processed audio data
     * @param glassesRep SmartGlassesRepresentative for accessing glasses mic
     * @param phoneMicListener Listener for permission errors
     */
    public PhoneMicrophoneManager(Context context, AudioProcessingCallback audioProcessingCallback, 
                                SmartGlassesRepresentative glassesRep, PhoneMicListener phoneMicListener) {
        this.context = context;
        this.audioProcessingCallback = audioProcessingCallback;
        this.glassesRep = glassesRep;
        this.phoneMicListener = phoneMicListener;
        
        Log.d(TAG, "Initializing PhoneMicrophoneManager");
        
        // Create a chunk callback that forwards data through the SmartGlassesRepresentative's receiveChunk
        this.audioChunkCallback = new AudioChunkCallback() {
            @Override
            public void onSuccess(ByteBuffer data) {
                if (glassesRep != null) {
                    // Use the existing receiveChunk method to handle PCM -> LC3 conversion and callbacks
                    glassesRep.receiveChunk(data);
//                    Log.d(TAG, "✅ PCM audio forwarded to SmartGlassesRepresentative.receiveChunk() for LC3 conversion");
                } else {
                    // Fallback to direct callback if glassesRep is not available
                    if (audioProcessingCallback != null) {
                        audioProcessingCallback.onAudioDataAvailable(data.array());
                        Log.d(TAG, "⚠️ SmartGlassesRepresentative not available, using direct callback");
                    }
                }
            }
        };
        
        try {
            // Check for audio permission first
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
                    != PackageManager.PERMISSION_GRANTED) {
                Log.e(TAG, "Missing RECORD_AUDIO permission");
                handleMissingPermissions();
                return;
            }
            
            // Initialize managers
            initCallDetection();
            initAudioConflictDetection();
            
            // Start with preferred mode
            startPreferredMicMode();
        } catch (SecurityException se) {
            Log.e(TAG, "Security exception during initialization: " + se.getMessage());
            handleMissingPermissions();
        } catch (Exception e) {
            Log.e(TAG, "Error during initialization: " + e.getMessage());
        }
    }
    
    /**
     * Handle missing permissions by notifying listener
     */
    private void handleMissingPermissions() {
        Log.e(TAG, "Handling missing permissions");
        
        // Clean up resources
        cleanUpCurrentMic();
        
        if (phoneStateListener != null && telephonyManager != null) {
            try {
                telephonyManager.listen(phoneStateListener, PhoneStateListener.LISTEN_NONE);
            } catch (Exception e) {
                Log.e(TAG, "Error removing phone state listener: " + e.getMessage());
            }
        }
        
        // Notify listener about the permission error
        if (phoneMicListener != null) {
            phoneMicListener.onPermissionError();
        }
    }
    
    /**
     * Starts recording with the preferred microphone mode (SCO first, with fallbacks)
     */
    public void startPreferredMicMode() {
        // Always execute on main thread to prevent Handler threading issues
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post(this::startPreferredMicMode);
            return;
        }
        
        // Check if we've changed modes too recently (debounce)
        long now = System.currentTimeMillis();
        if (now - lastModeChangeTime < MODE_CHANGE_DEBOUNCE_MS) {
            Log.d(TAG, "Ignoring mode change request - too soon after previous change");
            return;
        }
        
        // Try SCO first (will fall back if unavailable)
        switchToScoMode();
    }
    
    /**
     * Attempts to switch to SCO mode for best audio quality
     */
    public void switchToScoMode() {
        // Always execute on main thread to prevent Handler threading issues
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post(this::switchToScoMode);
            return;
        }
        
        if (isPhoneCallActive || isExternalAudioActive) {
            // Can't use SCO during conflicts
            Log.d(TAG, "Cannot use SCO mode due to active conflicts, falling back to normal mode");
            switchToNormalMode();
            return;
        }
        
        // Clean up existing instance
        cleanUpCurrentMic();
        
        // Create new microphone with SCO enabled
        try {
            Log.d(TAG, "Switching to SCO mode");
            // Create new microphone with SCO enabled - this should forward audio to the speech recognition system
            micInstance = new MicrophoneLocalAndBluetooth(context, true, audioChunkCallback, this);
            Log.d(TAG, "✅ Phone SCO mic initialized - audio should now flow to speech recognition");
            currentStatus = MicStatus.SCO_MODE;
            lastModeChangeTime = System.currentTimeMillis(); // Track mode change time
            notifyStatusChange();
            scoRetries = 0; // Reset retry counter on success
        } catch (Exception e) {
            Log.e(TAG, "Failed to start SCO mode", e);
            attemptFallback();
        }
    }
    
    /**
     * Switches to normal phone microphone mode
     */
    public void switchToNormalMode() {
        // Always execute on main thread to prevent Handler threading issues
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post(this::switchToNormalMode);
            return;
        }
        
        // Check if normal mode is possible
        if (isPhoneCallActive) {
            // Can't use microphone during call
            Log.d(TAG, "Cannot use normal mode due to active phone call, pausing recording");
            pauseRecording();
            return;
        }
        
        // Clean up existing instance
        cleanUpCurrentMic();
        
        try {
            Log.d(TAG, "Switching to normal phone microphone mode");
            // Create new microphone with SCO disabled
            micInstance = new MicrophoneLocalAndBluetooth(context, false, audioChunkCallback, this);
            Log.d(TAG, "✅ Normal phone mic initialized - audio should now flow to speech recognition");
            
            currentStatus = MicStatus.NORMAL_MODE;
            lastModeChangeTime = System.currentTimeMillis(); // Track mode change time
            notifyStatusChange();
        } catch (Exception e) {
            Log.e(TAG, "Failed to start normal mode", e);
            switchToGlassesMic(); // Try glasses mic as a last resort
        }
    }
    
    /**
     * Switches to using the glasses' onboard microphone if available
     */
    public void switchToGlassesMic() {
        // Always execute on main thread to prevent Handler threading issues
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post(this::switchToGlassesMic);
            return;
        }
        
        // Check if glasses mic is available
        if (glassesRep == null || !glassesRep.smartGlassesDevice.getHasInMic()) {
            // No glasses mic available, we've exhausted all options
            Log.e(TAG, "No glasses microphone available, pausing recording");
            pauseRecording();
            return;
        }
        
        // Clean up existing instance
        cleanUpCurrentMic();
        
        try {
            Log.d(TAG, "Switching to glasses onboard microphone");
            // Tell system to use glasses mic
            SmartGlassesManager.setForceCoreOnboardMic(context, false);
            
            currentStatus = MicStatus.GLASSES_MIC;
            lastModeChangeTime = System.currentTimeMillis(); // Track mode change time  
            notifyStatusChange();
        } catch (Exception e) {
            Log.e(TAG, "Failed to switch to glasses mic", e);
            pauseRecording();
        }
    }
    
    /**
     * Temporarily pauses microphone recording
     */
    public void pauseRecording() {
        // Always execute on main thread to prevent Handler threading issues
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post(this::pauseRecording);
            return;
        }
        
        Log.d(TAG, "Pausing microphone recording");
        
        // Check if we're coming from SCO mode
        boolean wasScoMode = currentStatus == MicStatus.SCO_MODE;
        
        // Stop any active recording
        cleanUpCurrentMic();
        
        // Make sure all audio-related resources are released
        if (audioManager != null) {
            try {
                // Stop SCO if it was active
                if (wasScoMode) {
                    Log.d(TAG, "Coming from SCO mode - stopping Bluetooth SCO");
                }
                
                audioManager.stopBluetoothSco();
                audioManager.setMode(AudioManager.MODE_NORMAL);
            } catch (Exception e) {
                Log.e(TAG, "Error stopping SCO audio", e);
            }
        }
        
        // Update status
        currentStatus = MicStatus.PAUSED;
        lastModeChangeTime = System.currentTimeMillis(); // Track mode change time
        notifyStatusChange();
        
        Log.d(TAG, "Microphone recording fully paused");
    }
    
    /**
     * Attempts to fall back to next best microphone option after a failure
     */
    private void attemptFallback() {
        if (currentStatus == MicStatus.SCO_MODE && scoRetries < MAX_SCO_RETRIES) {
            // Retry SCO mode a few times before falling back
            scoRetries++;
            Log.d(TAG, "Retrying SCO mode, attempt " + scoRetries);
            switchToScoMode();
        } else {
            // Fall back to normal mode
            switchToNormalMode();
        }
    }
    
    /**
     * Cleans up current microphone instance
     */
    private void cleanUpCurrentMic() {
        if (micInstance != null) {
            try {
                // Make sure we fully destroy the mic instance
                micInstance.destroy();
            } catch (Exception e) {
                Log.e(TAG, "Error destroying microphone instance", e);
            } finally {
                // Always clear the reference even if destroy fails
                micInstance = null;
            }
        }
    }
    
    /**
     * Registers an AudioRecord's session ID as belonging to us
     * This helps us filter out our own recordings in the AudioRecordingCallback
     */
    public void registerOurAudioRecord(AudioRecord audioRecord) {
        if (audioRecord != null) {
            int clientId = audioRecord.getAudioSessionId();
            Log.d(TAG, "Registering our audio client ID: " + clientId);
            
            if (!ourAudioClientIds.contains(clientId)) {
                ourAudioClientIds.add(clientId);
            }
        }
    }
    
    /**
     * Unregisters an AudioRecord's session ID when we're done with it
     */
    public void unregisterOurAudioRecord(AudioRecord audioRecord) {
        if (audioRecord != null) {
            int clientId = audioRecord.getAudioSessionId();
            Log.d(TAG, "Unregistering our audio client ID: " + clientId);
            
            ourAudioClientIds.remove(Integer.valueOf(clientId));
        }
    }
    
    /**
     * Notifies system about microphone mode changes
     */
    private void notifyStatusChange() {
        // Send status update to system
        EventBus.getDefault().post(new MicModeChangedEvent(currentStatus));
    }
    
    /**
     * Initializes phone call detection
     */
    private void initCallDetection() {
        try {
            // Check for telephony permissions before proceeding
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE)
                    != PackageManager.PERMISSION_GRANTED) {
                Log.e(TAG, "Missing READ_PHONE_STATE permission, skipping call detection");
                // Continue without call detection - we'll just miss the call detection feature
                // but the rest of the mic functionality should work
                return;
            }

            // On newer Android (11+), check for additional permissions but don't fail
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PRECISE_PHONE_STATE)
                        != PackageManager.PERMISSION_GRANTED) {
                    Log.w(TAG, "Missing READ_PRECISE_PHONE_STATE permission, call detection might be limited");
                    // Continue anyway as basic functionality might work
                }
            }

            telephonyManager = (TelephonyManager) context.getSystemService(Context.TELEPHONY_SERVICE);
            phoneStateListener = new PhoneStateListener() {
                @Override
                public void onCallStateChanged(int state, String phoneNumber) {
                    boolean wasCallActive = isPhoneCallActive;
                    isPhoneCallActive = (state != TelephonyManager.CALL_STATE_IDLE);
                    
                    Log.d(TAG, "Phone call state changed: " + (isPhoneCallActive ? "ACTIVE" : "IDLE"));
                    
                    // If call state changed, update mic mode
                    if (wasCallActive != isPhoneCallActive) {
                        if (isPhoneCallActive) {
                            // Check if we can switch to glasses mic during the call
                            boolean usingForcedPhoneMic = SmartGlassesManager.getForceCoreOnboardMic(context);
                            boolean glassesWithMicAvailable = glassesRep != null && 
                                                           glassesRep.smartGlassesDevice != null && 
                                                           glassesRep.smartGlassesDevice.getHasInMic();
                            
                            if (usingForcedPhoneMic && glassesWithMicAvailable) {
                                // User was using forced phone mic but has glasses with mic - switch temporarily
                                Log.d(TAG, "🔄 Phone call active - temporarily switching to glasses mic");
                                switchToGlassesMic();
                            } else {
                                // No glasses mic available - need to pause recording
                                Log.d(TAG, "Phone call active - pausing recording (no glasses mic available)");
                                pauseRecording();
                            }
                        } else {
                            // Call ended, resume with preferred mode
                            Log.d(TAG, "Phone call ended - resuming preferred microphone mode");
                            startPreferredMicMode();
                        }
                    }
                }
            };
            telephonyManager.listen(phoneStateListener, PhoneStateListener.LISTEN_CALL_STATE);
        } catch (SecurityException se) {
            Log.e(TAG, "Security exception in call detection: " + se.getMessage());
            // Continue without call detection - we'll just miss the feature
        } catch (Exception e) {
            Log.e(TAG, "Error in call detection: " + e.getMessage());
            // Continue without call detection
        }
    }
    
    /**
     * Initializes audio conflict detection
     */
    private void initAudioConflictDetection() {
        audioManager = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
        
        // Register for audio events
        IntentFilter filter = new IntentFilter();
        filter.addAction(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
        filter.addAction(BluetoothDevice.ACTION_ACL_CONNECTED);
        filter.addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED);
        
        audioStateReceiver = new BroadcastReceiver() {
            @SuppressLint("MissingPermission")
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                Log.d(TAG, "Audio state changed: " + action);
                if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(action)) {
                    // Audio route changed - possible conflict
                    Log.d(TAG, "Audio becoming noisy - possible conflict detected");
                    isExternalAudioActive = true;
                    
                    if (currentStatus == MicStatus.SCO_MODE) {
                        // Switch to normal mode temporarily
                        switchToNormalMode();
                    }
                } else if (BluetoothDevice.ACTION_ACL_CONNECTED.equals(action)) {
                    // New BT device - check if it's an audio device
                    BluetoothDevice device = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                    Log.d(TAG, "Bluetooth device connected: " + 
                          (device != null ? device.getName() : "Unknown"));
                    
                    if (device != null && isSupportedBluetoothMic(device)) {
                        // If in normal mode, try SCO again since a new BT mic is available
                        if (currentStatus == MicStatus.NORMAL_MODE) {
                            switchToScoMode();
                        }
                    }
                } else if (BluetoothDevice.ACTION_ACL_DISCONNECTED.equals(action)) {
                    BluetoothDevice device = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                    Log.d(TAG, "Bluetooth device disconnected: " + 
                          (device != null ? device.getName() : "Unknown"));
                    
                    // Reset external audio flag if this was causing the conflict
                    isExternalAudioActive = false;
                    
                    // If not in SCO mode already and no conflicts, try SCO again
                    if (currentStatus != MicStatus.SCO_MODE && !isPhoneCallActive) {
                        switchToScoMode();
                    }
                }
            }
        };
        
        try {
            context.registerReceiver(audioStateReceiver, filter);
            isReceiverRegistered = true;
        } catch (Exception e) {
            Log.e(TAG, "Failed to register audio state receiver", e);
        }
        
        // Register AudioRecordingCallback to detect when other apps use microphone
        try {
            audioRecordingCallback = new AudioManager.AudioRecordingCallback() {
                @Override
                public void onRecordingConfigChanged(List<AudioRecordingConfiguration> configs) {
                    if (configs == null) {
                        Log.d(TAG, "Recording configuration update: null configs");
                        return;
                    }
                    
                    // Filter out our own audio recordings by client ID 
                    List<AudioRecordingConfiguration> otherAppRecordings = new ArrayList<>();
                    for (AudioRecordingConfiguration config : configs) {
                        int clientId = config.getClientAudioSessionId();
                        if (!ourAudioClientIds.contains(clientId)) {
                            otherAppRecordings.add(config);
                        }
                    }
                    
                    boolean otherAppsRecording = !otherAppRecordings.isEmpty();
                    
                    // Log what's happening but only when there's a change or there are external recordings
                    if (otherAppsRecording || otherAppsRecording != isExternalAudioActive) {
                        Log.d(TAG, "Recording configuration change detected:");
                        Log.d(TAG, "- Total recordings: " + configs.size());
                        Log.d(TAG, "- Our recordings: " + (configs.size() - otherAppRecordings.size()));
                        Log.d(TAG, "- Other app recordings: " + otherAppRecordings.size());
                        
                        // For debugging, log details about the other recordings
                        for (AudioRecordingConfiguration config : otherAppRecordings) {
                            Log.d(TAG, "  - Client: " + config.getClientAudioSessionId() +
                                  ", Source: " + config.getAudioSource());
                        }
                    }
                    
                    // Only take action if this represents a change in state
                    if (otherAppsRecording != isExternalAudioActive) {
                        isExternalAudioActive = otherAppsRecording;
                        
                        // Check if we've changed modes too recently (debounce)
                        long now = System.currentTimeMillis();
                        if (now - lastModeChangeTime < MODE_CHANGE_DEBOUNCE_MS) {
                            Log.d(TAG, "Detected audio configuration change but ignoring (debounce active)");
                            return;
                        }
                        
                        if (isExternalAudioActive) {
                            Log.d(TAG, "🎤 External app now using microphone - adjusting our recording");
                            
                            // For any phone-based recording (SCO or normal), try to use glasses mic or pause entirely
                            if (currentStatus == MicStatus.SCO_MODE || currentStatus == MicStatus.NORMAL_MODE) {
                                // Check if glasses onboard mic is available
                                if (glassesRep != null && glassesRep.smartGlassesDevice.getHasInMic()) {
                                    Log.d(TAG, "External app needs mic - switching to glasses onboard mic");
                                    switchToGlassesMic();
                                } else {
                                    Log.d(TAG, "External app needs mic - no glasses mic available, pausing recording");
                                    pauseRecording();
                                }
                            }
                            
                            // We're either using glasses mic or fully paused now
                        } else {
                            Log.d(TAG, "🎤 External apps released microphone - can return to preferred mode");
                            
                            // Only switch back if we're not already in SCO and there's no phone call
                            if (currentStatus != MicStatus.SCO_MODE && !isPhoneCallActive) {
                                // Add a slightly longer delay before reclaiming preferred mode
                                mainHandler.postDelayed(() -> {
                                    // Double-check we still want to do this and that debounce has passed
                                    if (!isExternalAudioActive && !isPhoneCallActive && 
                                        System.currentTimeMillis() - lastModeChangeTime >= MODE_CHANGE_DEBOUNCE_MS) {
                                        Log.d(TAG, "Returning to preferred mode after external mic release");
                                        startPreferredMicMode();
                                    }
                                }, 1000); // 1000ms delay to let other app fully release resources
                            }
                        }
                    }
                }
            };
            
            audioManager.registerAudioRecordingCallback(audioRecordingCallback, mainHandler);
            isAudioRecordingCallbackRegistered = true;
            Log.d(TAG, "Successfully registered AudioRecordingCallback");
            
            // Get initial state
            List<AudioRecordingConfiguration> initialConfigs = 
                    audioManager.getActiveRecordingConfigurations();
            
            // Count how many external recordings are already happening
            int externalRecordings = 0;
            for (AudioRecordingConfiguration config : initialConfigs) {
                if (!ourAudioClientIds.contains(config.getClientAudioSessionId())) {
                    externalRecordings++;
                }
            }
            
            isExternalAudioActive = externalRecordings > 0;
            if (isExternalAudioActive) {
                Log.d(TAG, "🎤 Detected " + externalRecordings + 
                      " active external recordings at initialization");
            }
        } catch (Exception e) {
            Log.e(TAG, "Failed to register AudioRecordingCallback", e);
            // Continue without this feature - it's enhanced functionality
        }
    }
    
    /**
     * Checks if a Bluetooth device is a supported microphone device
     */
    private boolean isSupportedBluetoothMic(BluetoothDevice device) {
        // In a full implementation, we would check for headset profile support
        // For now we'll assume any BT device could be a mic to be safe
        return true;
    }
    
    /**
     * Gets the current microphone status
     */
    public MicStatus getCurrentStatus() {
        return currentStatus;
    }
    
    /**
     * Clean up resources and stop recording
     */
    public void destroy() {
        Log.d(TAG, "Destroying PhoneMicrophoneManager");
        
        cleanUpCurrentMic();
        
        // Unregister listeners
        if (phoneStateListener != null) {
            try {
                telephonyManager.listen(phoneStateListener, PhoneStateListener.LISTEN_NONE);
            } catch (Exception e) {
                Log.e(TAG, "Error unregistering phone state listener", e);
            }
        }
        
        if (audioStateReceiver != null && isReceiverRegistered) {
            try {
                context.unregisterReceiver(audioStateReceiver);
                isReceiverRegistered = false;
            } catch (Exception e) {
                Log.e(TAG, "Error unregistering audio state receiver", e);
            }
        }
        
        // Unregister AudioRecordingCallback
        if (audioManager != null && audioRecordingCallback != null && isAudioRecordingCallbackRegistered) {
            try {
                audioManager.unregisterAudioRecordingCallback(audioRecordingCallback);
                isAudioRecordingCallbackRegistered = false;
                Log.d(TAG, "Successfully unregistered AudioRecordingCallback");
            } catch (Exception e) {
                Log.e(TAG, "Error unregistering AudioRecordingCallback", e);
            }
        }
        
        // Clear tracked audio client IDs
        ourAudioClientIds.clear();
    }
}
