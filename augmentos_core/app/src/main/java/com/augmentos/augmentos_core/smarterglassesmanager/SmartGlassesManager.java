package com.augmentos.augmentos_core.smarterglassesmanager;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.lifecycle.LifecycleOwner;

import com.augmentos.augmentos_core.AugmentosService;
import com.augmentos.augmentos_core.LocationSystem;
import com.augmentos.augmentos_core.MainActivity;
import com.augmentos.augmentos_core.R;
import com.augmentos.augmentos_core.WindowManagerWithTimeouts;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.BypassVadForDebuggingEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.MicModeChangedEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.NewAsrLanguagesEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.SmartGlassesConnectionEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.hci.PhoneMicrophoneManager;
import com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators.AndroidSGC;
import com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators.SmartGlassesFontSize;
import com.augmentos.augmentos_core.smarterglassesmanager.smartglassesconnection.SmartGlassesRepresentative;
import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.ASR_FRAMEWORKS;
import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.SpeechRecSwitchSystem;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.AudioWearable;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.EvenRealitiesG1;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.InmoAirOne;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.MentraMach1;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.MentraLive;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesDevice;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesOperatingSystem;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.TCLRayNeoXTwo;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.VuzixShield;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.VuzixUltralite;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.special.VirtualWearable;
import com.augmentos.augmentos_core.smarterglassesmanager.texttospeech.TextToSpeechSystem;
import com.augmentos.augmentos_core.smarterglassesmanager.utils.SmartGlassesConnectionState;
import com.augmentos.augmentoslib.events.DiarizationOutputEvent;
import com.augmentos.augmentoslib.events.DisconnectedFromCloudEvent;
import com.augmentos.augmentoslib.events.SmartRingButtonOutputEvent;
import com.augmentos.augmentoslib.events.SpeechRecOutputEvent;
import com.augmentos.augmentoslib.events.BulletPointListViewRequestEvent;
import com.augmentos.augmentoslib.events.DoubleTextWallViewRequestEvent;
import com.augmentos.augmentoslib.events.FinalScrollingTextRequestEvent;
import com.augmentos.augmentoslib.events.HomeScreenEvent;
import com.augmentos.augmentoslib.events.ReferenceCardImageViewRequestEvent;
import com.augmentos.augmentoslib.events.ReferenceCardSimpleViewRequestEvent;
import com.augmentos.augmentoslib.events.RowsCardViewRequestEvent;
import com.augmentos.augmentoslib.events.SendBitmapViewRequestEvent;
import com.augmentos.augmentoslib.events.TextLineViewRequestEvent;
import com.augmentos.augmentoslib.events.TextWallViewRequestEvent;
import com.augmentos.augmentoslib.events.ScrollingTextViewStartRequestEvent;
import com.augmentos.augmentoslib.events.ScrollingTextViewStopRequestEvent;

import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.EventBusException;
import org.greenrobot.eventbus.Subscribe;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;

import androidx.preference.PreferenceManager;

import android.content.SharedPreferences;
import android.graphics.Bitmap;

import io.reactivex.rxjava3.subjects.PublishSubject;

/**
 * Manages smart glasses functionality as a dedicated foreground service
 * Meets Android 14 (SDK 34) requirements for connectedDevice type services
 */
public class SmartGlassesManager extends Service {
    private static final String TAG = "SGM_Manager";
    private static final int NOTIFICATION_ID = 1003;
    private static final String CHANNEL_ID = "SmartGlassesServiceChannel";

    // Service binder
    private final IBinder binder = new SmartGlassesBinder();
    
    // Lifecycle owner reference (no need for context since we are a Service)
    private LifecycleOwner lifecycleOwner;

    // Components from original implementation
    private TextToSpeechSystem textToSpeechSystem;
    private SpeechRecSwitchSystem speechRecSwitchSystem;
    private PublishSubject<JSONObject> dataObservable;
    private SmartGlassesRepresentative smartGlassesRepresentative;
    
    // UI management
    public WindowManagerWithTimeouts windowManager;

    // Connection handling
    private String translationLanguage;
    private Handler micDebounceHandler;
    private Runnable micTurnOffRunnable;
    private boolean pendingMicTurnOff = false;
    
    // Get handler with lazy initialization
    private Handler getMicDebounceHandler() {
        if (micDebounceHandler == null) {
            micDebounceHandler = new Handler(Looper.getMainLooper());
        }
        return micDebounceHandler;
    }
    
    private long currTime = 0;
    private long lastPressed = 0;
    private final long lastTapped = 0;
    private final long doublePressTimeConst = 420;
    private final long doubleTapTimeConst = 600;
    
    // Event handler to notify outer service of state changes
    public interface SmartGlassesEventHandler {
        void onGlassesConnectionStateChanged(SmartGlassesDevice device, SmartGlassesConnectionState state);
    }
    
    private SmartGlassesEventHandler eventHandler;
    
    /**
     * Class for clients to access this service
     */
    public class SmartGlassesBinder extends Binder {
        public SmartGlassesManager getService() {
            return SmartGlassesManager.this;
        }
    }
    
    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, "SmartGlassesManager service created");
        createNotificationChannel();
        initialize();
    }
    
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.d(TAG, "Starting SmartGlassesManager as foreground service");
        startForeground(NOTIFICATION_ID, createNotification());
        
        // Start the LocationSystem service for location functionality
        // This is required for Android 14 (SDK 34) which requires separate services
        // for each foreground service type
        startLocationService();
        
        return START_NOT_STICKY; // Don't restart if killed
    }
    
    /**
     * Start the LocationSystem service for location functionality
     */
    private void startLocationService() {
        Log.d(TAG, "Starting LocationSystem service");
        Intent intent = new Intent(this, LocationSystem.class);
        
        // Start as foreground service for Android O+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent);
        } else {
            startService(intent);
        }
    }
    
    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }
    
    @Override
    public void onDestroy() {
        Log.d(TAG, "SmartGlassesManager service destroyed");
        
        // Stop the LocationSystem service
        stopLocationService();
        
        cleanup();
        super.onDestroy();
    }
    
    /**
     * Stop the LocationSystem service
     */
    private void stopLocationService() {
        Log.d(TAG, "Stopping LocationSystem service");
        Intent intent = new Intent(this, LocationSystem.class);
        stopService(intent);
    }
    
    /**
     * Set the lifecycle owner and event handler after binding
     */
    public void setLifecycleOwnerAndEventHandler(LifecycleOwner lifecycleOwner, SmartGlassesEventHandler eventHandler) {
        this.lifecycleOwner = lifecycleOwner;
        this.eventHandler = eventHandler;
    }

    /**
     * Initialize all components
     */
    public void initialize() {
        saveChosenAsrFramework(this, ASR_FRAMEWORKS.AUGMENTOS_ASR_FRAMEWORK);

        // Start speech recognition
        speechRecSwitchSystem = new SpeechRecSwitchSystem(this);
        ASR_FRAMEWORKS asrFramework = getChosenAsrFramework(this);
        speechRecSwitchSystem.startAsrFramework(asrFramework);

        // Setup data observable
        dataObservable = PublishSubject.create();

        // Start text to speech
        textToSpeechSystem = new TextToSpeechSystem(this);
        textToSpeechSystem.setup();
        
        // Create window manager for UI
        windowManager = new WindowManagerWithTimeouts(
                19, // globalTimeoutSeconds
                this::sendHomeScreen // what to do when globally timed out
        );
        
        // Register for EventBus events
        try {
            EventBus.getDefault().register(this);
        } catch(EventBusException e) {
            Log.e(TAG, "Error registering with EventBus", e);
        }
    }
    
    /**
     * Create notification for the foreground service
     */
    private Notification createNotification() {
        String title = "Smart Glasses";
        String content = "Searching for glasses";
        
        if (smartGlassesRepresentative != null && 
            smartGlassesRepresentative.getConnectionState() == SmartGlassesConnectionState.CONNECTED) {
            SmartGlassesDevice device = smartGlassesRepresentative.smartGlassesDevice;
            title = device.deviceModelName;
            content = "Connected";
        }
        
        Intent notificationIntent = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                this, 
                0, 
                notificationIntent,
                PendingIntent.FLAG_IMMUTABLE
        );
        
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(content)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentIntent(pendingIntent)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .build();
    }
    
    /**
     * Create the notification channel for Android O and above
     */
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Smart Glasses Service",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Used for maintaining smart glasses connectivity");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    /**
     * Cleanup all resources - replaces onDestroy from service
     */
    public void cleanup() {
        // BATTERY OPTIMIZATION: Try-catch for EventBus unregister to prevent crashes
        // Also ensures we don't attempt to unregister if not registered
        try {
            if (EventBus.getDefault().isRegistered(this)) {
                EventBus.getDefault().unregister(this);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error unregistering from EventBus", e);
        }

        // Kill speech rec
        if (speechRecSwitchSystem != null) {
            speechRecSwitchSystem.destroy();
            speechRecSwitchSystem = null; // BATTERY OPTIMIZATION: Set to null to avoid memory leaks
        }

        // Kill smart glasses connection
        if (smartGlassesRepresentative != null) {
            smartGlassesRepresentative.destroy();
            smartGlassesRepresentative = null;
        }

        // Kill data transmitters
        if (dataObservable != null) {
            dataObservable.onComplete();
            dataObservable = null; // BATTERY OPTIMIZATION: Set to null to avoid memory leaks
        }

        // Kill textToSpeech
        if (textToSpeechSystem != null) {
            textToSpeechSystem.destroy();
            textToSpeechSystem = null; // BATTERY OPTIMIZATION: Set to null to avoid memory leaks
        }

        // Clean up micDebounceHandler
        if (micDebounceHandler != null) {
            micDebounceHandler.removeCallbacksAndMessages(null);
            micDebounceHandler = null;
        }
        
        // Clear window manager
        if (windowManager != null) {
            windowManager.shutdown();
            windowManager = null; // BATTERY OPTIMIZATION: Set to null to avoid memory leaks
        }
        
        // BATTERY OPTIMIZATION: Explicitly remove any references
        lifecycleOwner = null;
        eventHandler = null;
    }

    /**
     * Reset state without destroying - for disconnectWearable implementation
     */
    public void resetState() {
        // Kill smart glasses connection but keep manager alive
        if (smartGlassesRepresentative != null) {
            smartGlassesRepresentative.destroy();
            smartGlassesRepresentative = null;
        }

        if (eventHandler != null) {
            eventHandler.onGlassesConnectionStateChanged(null, SmartGlassesConnectionState.DISCONNECTED);
        }
    }

    @Subscribe
    public void handleConnectionEvent(SmartGlassesConnectionEvent event) {
        sendUiUpdate();
    }

    public void connectToSmartGlasses(SmartGlassesDevice device) {
        // Check that we have a lifecycle owner set
        if (lifecycleOwner == null) {
            Log.e(TAG, "Cannot connect to smart glasses: lifecycleOwner is null");
            return;
        }
        
        // In Android 14, we need to be very careful about service/object lifecycle
        // Always create a fresh representative to avoid stale objects with null fields
        if (smartGlassesRepresentative != null) {
            Log.d(TAG, "Destroying old SmartGlassesRepresentative before connecting to new glasses");
            smartGlassesRepresentative.destroy();
            smartGlassesRepresentative = null;
        }
            
        // Create a new representative with a fresh state
        smartGlassesRepresentative = new SmartGlassesRepresentative(
                this, // Use service as context
                device,
                lifecycleOwner,
                dataObservable,
                speechRecSwitchSystem // Pass SpeechRecSwitchSystem as the audio processing callback
        );

        // Connect directly instead of using a handler
        Log.d(TAG, "CONNECTING TO SMART GLASSES");
        smartGlassesRepresentative.connectToSmartGlasses();
        
        // BATTERY OPTIMIZATION: Explicitly register callback with the communicator
        // This ensures it's immediately available when audio events start coming in
        if (smartGlassesRepresentative != null && 
            smartGlassesRepresentative.smartGlassesCommunicator != null && 
            speechRecSwitchSystem != null) {
            
            // Force-setting the callback directly to bypass any potential registration issues
            smartGlassesRepresentative.smartGlassesCommunicator.audioProcessingCallback = speechRecSwitchSystem;
            
            // Also use the standard registration method
            smartGlassesRepresentative.smartGlassesCommunicator.registerAudioProcessingCallback(speechRecSwitchSystem);
            
            Log.d(TAG, "BATTERY OPTIMIZATION: Explicitly registered and set audio processing callback for " + 
                device.getGlassesOs().name() + " - Callback is: " + (speechRecSwitchSystem != null ? "NOT NULL" : "NULL"));
            
            // Special additional setup for AndroidSGC
            if (smartGlassesRepresentative.smartGlassesCommunicator instanceof AndroidSGC) {
                ((AndroidSGC) smartGlassesRepresentative.smartGlassesCommunicator)
                    .registerSpeechRecSystem(speechRecSwitchSystem);
                Log.d(TAG, "BATTERY OPTIMIZATION: Also registered special AndroidSGC callback");
            }
        }
        
        // Update the notification to show connected state
        NotificationManager notificationManager = getSystemService(NotificationManager.class);
        if (notificationManager != null) {
            notificationManager.notify(NOTIFICATION_ID, createNotification());
        }
    }

    public void findCompatibleDeviceNames(SmartGlassesDevice device) {
        // Check that we have a lifecycle owner set
        if (lifecycleOwner == null) {
            Log.e(TAG, "Cannot find compatible devices: lifecycleOwner is null");
            return;
        }
        
        // In Android 14, we need to be very careful about service/object lifecycle
        // Always create a fresh representative when searching for devices to prevent stale objects
        if (smartGlassesRepresentative != null) {
            Log.d(TAG, "Destroying old SmartGlassesRepresentative before creating new one");
            smartGlassesRepresentative.destroy();
            smartGlassesRepresentative = null;
        }
            
        // Create a new representative with a fresh state
        smartGlassesRepresentative = new SmartGlassesRepresentative(
                this, // Use service as context
                device,
                lifecycleOwner,
                dataObservable,
                speechRecSwitchSystem // Pass SpeechRecSwitchSystem as the audio processing callback
        );

        Log.d(TAG, "FINDING COMPATIBLE SMART GLASSES DEVICE NAMES");
        smartGlassesRepresentative.findCompatibleDeviceNames();
        
        // Update notification to show we're searching
        NotificationManager notificationManager = getSystemService(NotificationManager.class);
        if (notificationManager != null) {
            notificationManager.notify(NOTIFICATION_ID, createNotification());
        }
    }

    public void sendUiUpdate() {
        SmartGlassesConnectionState connectionState;
        if (smartGlassesRepresentative != null) {
            connectionState = smartGlassesRepresentative.getConnectionState();
            
            // Update event handler
            if (eventHandler != null) {
                eventHandler.onGlassesConnectionStateChanged(
                        smartGlassesRepresentative.smartGlassesDevice,
                        connectionState
                );
            }
            
            // Save preferred wearable if connected
            if (connectionState == SmartGlassesConnectionState.CONNECTED) {
                savePreferredWearable(this, smartGlassesRepresentative.smartGlassesDevice.deviceModelName);
                
                setFontSize(SmartGlassesFontSize.MEDIUM);
            }
        } else {
            connectionState = SmartGlassesConnectionState.DISCONNECTED;
            
            // Notify with null device and disconnected state
            if (eventHandler != null) {
                eventHandler.onGlassesConnectionStateChanged(null, connectionState);
            }
        }
    }

    @Subscribe
    public void handleDisconnectedFromCloudEvent(DisconnectedFromCloudEvent event) {
        Log.d(TAG, "Disconnected from cloud event received");
        sendHomeScreen();
    }

    public static void savePreferredWearable(Context context, String wearableName) {
        PreferenceManager.getDefaultSharedPreferences(context)
                .edit()
                .putString(context.getResources().getString(R.string.PREFERRED_WEARABLE), wearableName)
                .apply();
    }

    public static String getPreferredWearable(Context context) {
        return PreferenceManager.getDefaultSharedPreferences(context)
                .getString(context.getResources().getString(R.string.PREFERRED_WEARABLE), "");
    }

    public static ASR_FRAMEWORKS getChosenAsrFramework(Context context) {
        String asrString = PreferenceManager.getDefaultSharedPreferences(context)
                .getString(context.getResources().getString(R.string.SHARED_PREF_ASR_KEY), "");
        if (asrString.equals("")) {
            saveChosenAsrFramework(context, ASR_FRAMEWORKS.AUGMENTOS_ASR_FRAMEWORK);
            asrString = ASR_FRAMEWORKS.AUGMENTOS_ASR_FRAMEWORK.name();
        }
        return ASR_FRAMEWORKS.valueOf(asrString);
    }

    public static void saveChosenAsrFramework(Context context, ASR_FRAMEWORKS asrFramework) {
        PreferenceManager.getDefaultSharedPreferences(context)
                .edit()
                .putString(context.getResources().getString(R.string.SHARED_PREF_ASR_KEY), asrFramework.name())
                .apply();
    }
    
    public static boolean getSensingEnabled(Context context) {
        SharedPreferences sharedPreferences = context.getSharedPreferences("AugmentOSPrefs", Context.MODE_PRIVATE);
        return sharedPreferences.getBoolean(context.getResources().getString(R.string.SENSING_ENABLED), true);
    }

    public static void saveSensingEnabled(Context context, boolean enabled) {
        SharedPreferences sharedPreferences = context.getSharedPreferences("AugmentOSPrefs", Context.MODE_PRIVATE);
        SharedPreferences.Editor editor = sharedPreferences.edit();
        editor.putBoolean(context.getResources().getString(R.string.SENSING_ENABLED), enabled);
        editor.apply();
    }

    public static boolean getForceCoreOnboardMic(Context context) {
        return PreferenceManager.getDefaultSharedPreferences(context)
                .getBoolean(context.getResources().getString(R.string.FORCE_CORE_ONBOARD_MIC), false);
    }

    public static void setForceCoreOnboardMic(Context context, boolean toForce) {
        saveForceCoreOnboardMic(context, toForce);
    }
    
    public static void saveForceCoreOnboardMic(Context context, boolean toForce) {
        PreferenceManager.getDefaultSharedPreferences(context)
                .edit()
                .putBoolean(context.getResources().getString(R.string.FORCE_CORE_ONBOARD_MIC), toForce)
                .apply();
    }

    public static String getPreferredMic(Context context) {
        return PreferenceManager.getDefaultSharedPreferences(context)
                .getString(context.getResources().getString(R.string.PREFERRED_MIC), "glasses");
    }

    public static void setPreferredMic(Context context, String mic) {
        PreferenceManager.getDefaultSharedPreferences(context)
                .edit()
                .putString(context.getResources().getString(R.string.PREFERRED_MIC), mic)
                .apply();
    }
    
    public static boolean getBypassVadForDebugging(Context context) {
        SharedPreferences sharedPreferences = context.getSharedPreferences("AugmentOSPrefs", Context.MODE_PRIVATE);
        //Log.d("AugmentOSPrefs", "Getting bypass VAD for debugging: " + sharedPreferences.getBoolean(context.getResources().getString(R.string.BYPASS_VAD_FOR_DEBUGGING), false));
        return sharedPreferences.getBoolean(context.getResources().getString(R.string.BYPASS_VAD_FOR_DEBUGGING), false);
    }
    
    public static void saveBypassVadForDebugging(Context context, boolean enabled) {
        SharedPreferences sharedPreferences = context.getSharedPreferences("AugmentOSPrefs", Context.MODE_PRIVATE);
        SharedPreferences.Editor editor = sharedPreferences.edit();
        editor.putBoolean(context.getResources().getString(R.string.BYPASS_VAD_FOR_DEBUGGING), enabled);
        editor.apply();

        // BATTERY OPTIMIZATION: Direct callback instead of EventBus
        // We'll use the callback pattern in the SpeechRecSwitchSystem
        if (context instanceof AugmentosService) {
            AugmentosService service = (AugmentosService) context;
            if (service.smartGlassesManager != null && 
                service.smartGlassesManager.speechRecSwitchSystem != null) {
                service.smartGlassesManager.speechRecSwitchSystem.setBypassVad(enabled);
            }
        } else {
            // Fallback to EventBus when we don't have direct access to the service
            EventBus.getDefault().post(new BypassVadForDebuggingEvent(enabled));
        }
    }
    
    public static boolean getBypassAudioEncodingForDebugging(Context context) {
        SharedPreferences sharedPreferences = context.getSharedPreferences("AugmentOSPrefs", Context.MODE_PRIVATE);
        return sharedPreferences.getBoolean(context.getResources().getString(R.string.BYPASS_AUDIO_ENCODING_FOR_DEBUGGING), false);
    }

    public static void saveBypassAudioEncodingForDebugging(Context context, boolean enabled) {
        SharedPreferences sharedPreferences = context.getSharedPreferences("AugmentOSPrefs", Context.MODE_PRIVATE);
        SharedPreferences.Editor editor = sharedPreferences.edit();
        editor.putBoolean(context.getResources().getString(R.string.BYPASS_AUDIO_ENCODING_FOR_DEBUGGING), enabled);
        editor.apply();
    }

    public SmartGlassesConnectionState getSmartGlassesConnectState() {
        if (smartGlassesRepresentative != null) {
            return smartGlassesRepresentative.getConnectionState();
        } else {
            return SmartGlassesConnectionState.DISCONNECTED;
        }
    }

    public SmartGlassesDevice getConnectedSmartGlasses() {
        if (smartGlassesRepresentative == null) return null;
        if (smartGlassesRepresentative.getConnectionState() != SmartGlassesConnectionState.CONNECTED) return null;
        return smartGlassesRepresentative.smartGlassesDevice;
    }

    public SmartGlassesOperatingSystem getConnectedDeviceModelOs() {
        if (smartGlassesRepresentative == null) return null;
        if (smartGlassesRepresentative.getConnectionState() != SmartGlassesConnectionState.CONNECTED) return null;
        return smartGlassesRepresentative.smartGlassesDevice.glassesOs;
    }

    public void updateGlassesBrightness(int brightness) {
        if (smartGlassesRepresentative != null) {
            smartGlassesRepresentative.updateGlassesBrightness(brightness);
        }
    }

    public void updateGlassesAutoBrightness(boolean autoBrightness) {
        if (smartGlassesRepresentative != null) {
            smartGlassesRepresentative.updateGlassesAutoBrightness(autoBrightness);
        }
    }

    public void updateGlassesHeadUpAngle(int headUpAngle) {
        if (smartGlassesRepresentative != null) {
            smartGlassesRepresentative.updateGlassesHeadUpAngle(headUpAngle);
        }
    }

    public void sendReferenceCard(String title, String body) {
        if (smartGlassesRepresentative != null && smartGlassesRepresentative.smartGlassesCommunicator != null) {
            smartGlassesRepresentative.smartGlassesCommunicator.displayReferenceCardSimple(title, body);
        }
    }
    
    public void sendTextWall(String text) {
        if (smartGlassesRepresentative != null && smartGlassesRepresentative.smartGlassesCommunicator != null) {
            smartGlassesRepresentative.smartGlassesCommunicator.displayTextWall(text);
        }
    }

    public void sendDoubleTextWall(String textTop, String textBottom) {
        if (smartGlassesRepresentative != null && smartGlassesRepresentative.smartGlassesCommunicator != null) {
            smartGlassesRepresentative.smartGlassesCommunicator.displayDoubleTextWall(textTop, textBottom);
        }
    }

    public void sendRowsCard(String[] rowStrings) {
        if (smartGlassesRepresentative != null && smartGlassesRepresentative.smartGlassesCommunicator != null) {
            smartGlassesRepresentative.smartGlassesCommunicator.displayRowsCard(rowStrings);
        }
    }

    public void sendBulletPointList(String title, String[] bullets) {
        if (smartGlassesRepresentative != null && smartGlassesRepresentative.smartGlassesCommunicator != null) {
            smartGlassesRepresentative.smartGlassesCommunicator.displayBulletList(title, bullets);
        }
    }

    public void sendReferenceCard(String title, String body, String imgUrl) {
        if (smartGlassesRepresentative != null && smartGlassesRepresentative.smartGlassesCommunicator != null) {
            smartGlassesRepresentative.smartGlassesCommunicator.displayReferenceCardImage(title, body, imgUrl);
        }
    }

    public void sendBitmap(Bitmap bitmap) {
        if (smartGlassesRepresentative != null && smartGlassesRepresentative.smartGlassesCommunicator != null) {
            smartGlassesRepresentative.smartGlassesCommunicator.displayBitmap(bitmap);
        }
    }

    public void startScrollingText(String title) {
        if (smartGlassesRepresentative != null && smartGlassesRepresentative.smartGlassesCommunicator != null) {
            smartGlassesRepresentative.smartGlassesCommunicator.startScrollingTextViewMode(title);
            smartGlassesRepresentative.smartGlassesCommunicator.scrollingTextViewFinalText(title);
        }
    }

    public void pushScrollingText(String text) {
        if (smartGlassesRepresentative != null && smartGlassesRepresentative.smartGlassesCommunicator != null) {
            smartGlassesRepresentative.smartGlassesCommunicator.scrollingTextViewFinalText(text);
        }
    }

    public void stopScrollingText() {
        if (smartGlassesRepresentative != null && smartGlassesRepresentative.smartGlassesCommunicator != null) {
            smartGlassesRepresentative.smartGlassesCommunicator.stopScrollingTextViewMode();
        }
    }

    public void sendTextLine(String text) {
        if (smartGlassesRepresentative != null && smartGlassesRepresentative.smartGlassesCommunicator != null) {
            smartGlassesRepresentative.smartGlassesCommunicator.displayTextLine(text);
        }
    }

    public void sendTextToSpeech(String text, String languageString) {
        if (textToSpeechSystem != null) {
            textToSpeechSystem.speak(text, languageString);
        }
    }

    public void sendHomeScreen() {
        if (smartGlassesRepresentative != null && smartGlassesRepresentative.smartGlassesCommunicator != null) {
            smartGlassesRepresentative.smartGlassesCommunicator.showHomeScreen();
        }
    }

    public void setFontSize(SmartGlassesFontSize fontSize) {
        if (smartGlassesRepresentative != null && smartGlassesRepresentative.smartGlassesCommunicator != null) {
            smartGlassesRepresentative.smartGlassesCommunicator.setFontSize(fontSize);
        }
    }

    public void requestWifiScan() {
        if (smartGlassesRepresentative != null && smartGlassesRepresentative.smartGlassesCommunicator != null) {
            smartGlassesRepresentative.smartGlassesCommunicator.requestWifiScan();
        }
    }

    public void sendWifiCredentials(String ssid, String password) {
        if (smartGlassesRepresentative != null && smartGlassesRepresentative.smartGlassesCommunicator != null) {
            smartGlassesRepresentative.smartGlassesCommunicator.sendWifiCredentials(ssid, password);
        }
    }


    public void changeMicrophoneState(boolean isMicrophoneEnabled) {
        Log.d(TAG, "Want to changing microphone state to " + isMicrophoneEnabled);
        Log.d(TAG, "Force core onboard mic: " + getForceCoreOnboardMic(this));

        if (smartGlassesRepresentative == null || smartGlassesRepresentative.smartGlassesDevice == null) {
            Log.d(TAG, "Cannot change microphone state: smartGlassesRepresentative or smartGlassesDevice is null");
            return;
        }

        // If we're trying to turn ON the microphone
        if (isMicrophoneEnabled) {
            // Cancel any pending turn-off operations
            if (pendingMicTurnOff) {
                Log.d(TAG, "Cancelling pending microphone turn-off");
                getMicDebounceHandler().removeCallbacks(micTurnOffRunnable);
                pendingMicTurnOff = false;
            }

            // Immediately turn on the microphone
            applyMicrophoneState(true);
        }
        // If we're trying to turn OFF the microphone
        else {
            // If there's already a pending turn-off, do nothing (debounce is already in progress)
            if (!pendingMicTurnOff) {
                Log.d(TAG, "Scheduling microphone turn-off with debounce");
                pendingMicTurnOff = true;

                // Define the runnable that will turn off the mic after the delay
                micTurnOffRunnable = new Runnable() {
                    @Override
                    public void run() {
                        Log.d(TAG, "Executing debounced microphone turn-off");
                        pendingMicTurnOff = false;
                        applyMicrophoneState(false);
                    }
                };

                // Schedule the delayed turn-off
                getMicDebounceHandler().postDelayed(micTurnOffRunnable, 10000); // 10 seconds
            }
        }
    }

    public void applyMicrophoneState(boolean isMicrophoneEnabled) {
        Log.d(TAG, "Want to change microphone state to " + isMicrophoneEnabled);
        Log.d(TAG, "Force core onboard mic: " + getForceCoreOnboardMic(this));

        // Prevent NullPointerException
        if (smartGlassesRepresentative == null || smartGlassesRepresentative.smartGlassesDevice == null) {
            Log.e(TAG, "SmartGlassesRepresentative or its device is null, cannot apply microphone state");
            return;
        }

        if (smartGlassesRepresentative.smartGlassesDevice.getHasInMic() && !getForceCoreOnboardMic(this)) {
            // If we should be using the glasses microphone
            smartGlassesRepresentative.smartGlassesCommunicator.changeSmartGlassesMicrophoneState(isMicrophoneEnabled);
        } else {
            if (smartGlassesRepresentative.smartGlassesDevice.getHasInMic()) {
                smartGlassesRepresentative.smartGlassesCommunicator.changeSmartGlassesMicrophoneState(false);
            }

            // If we should be using the phone's mic
            Log.d(TAG, "111 Changing microphone state to " + isMicrophoneEnabled);
            smartGlassesRepresentative.changeBluetoothMicState(isMicrophoneEnabled);
        }

        // Tell speech rec system that we stopped
        speechRecSwitchSystem.microphoneStateChanged(isMicrophoneEnabled);
    }

    public void clearScreen() {
        sendHomeScreen();
    }
    
    /**
     * Sends a custom command to the connected smart glasses
     * This is used for device-specific commands like WiFi configuration
     * 
     * @param commandJson The command in JSON string format
     * @return boolean True if the command was sent, false otherwise
     */
    public boolean sendCustomCommand(String commandJson) {
        if (smartGlassesRepresentative != null && 
            smartGlassesRepresentative.smartGlassesCommunicator != null && 
            smartGlassesRepresentative.getConnectionState() == SmartGlassesConnectionState.CONNECTED) {
            
            Log.d(TAG, "Sending custom command to glasses: " + commandJson);
            
            // Pass the command to the smart glasses communicator
            // Each device-specific communicator will handle it appropriately
            smartGlassesRepresentative.smartGlassesCommunicator.sendCustomCommand(commandJson);
            return true;
        } else {
            Log.e(TAG, "Cannot send custom command - glasses not connected");
            return false;
        }
    }
    
    /**
     * Request a photo from the connected smart glasses
     * 
     * @param requestId The unique ID for this photo request
     * @param appId The ID of the app requesting the photo
     * @return true if request was sent, false if glasses not connected
     */
    public boolean requestPhoto(String requestId, String appId) {
        if (smartGlassesRepresentative != null && 
            smartGlassesRepresentative.smartGlassesCommunicator != null && 
            smartGlassesRepresentative.getConnectionState() == SmartGlassesConnectionState.CONNECTED) {
            
            Log.d(TAG, "Requesting photo from glasses, requestId: " + requestId + ", appId: " + appId);
            
            // Pass the request to the smart glasses communicator
            smartGlassesRepresentative.smartGlassesCommunicator.requestPhoto(requestId, appId);
            return true;
        } else {
            Log.e(TAG, "Cannot request photo - glasses not connected");
            return false;
        }
    }
    
    /**
     * Request a video stream from the connected smart glasses
     * 
     * @return true if request was sent, false if glasses not connected
     */
    public boolean requestVideoStream() {
        if (smartGlassesRepresentative != null && 
            smartGlassesRepresentative.smartGlassesCommunicator != null && 
            smartGlassesRepresentative.getConnectionState() == SmartGlassesConnectionState.CONNECTED) {
            
            Log.d(TAG, "Requesting video stream from glasses");
            
            // Pass the request to the smart glasses communicator
            smartGlassesRepresentative.smartGlassesCommunicator.requestVideoStream();
            return true;
        } else {
            Log.e(TAG, "Cannot request video stream - glasses not connected");
            return false;
        }
    }
    
    @Subscribe
    public void handleNewAsrLanguagesEvent(NewAsrLanguagesEvent event) {
        Log.d(TAG, "NewAsrLanguages: " + event.languages.toString());
        speechRecSwitchSystem.updateConfig(event.languages);
    }
    
    public static SmartGlassesDevice getSmartGlassesDeviceFromModelName(String modelName) {
        ArrayList<SmartGlassesDevice> allDevices = new ArrayList<>(
                Arrays.asList(
                        new VuzixUltralite(),
                        new MentraMach1(),
                        new MentraLive(),
                        new EvenRealitiesG1(),
                        new VuzixShield(),
                        new InmoAirOne(),
                        new TCLRayNeoXTwo(),
                        new AudioWearable(),
                        new VirtualWearable()
                )
        );

        for (SmartGlassesDevice device : allDevices) {
            if (device.deviceModelName.equals(modelName)) {
                return device;
            }
        }

        return null;
    }
}