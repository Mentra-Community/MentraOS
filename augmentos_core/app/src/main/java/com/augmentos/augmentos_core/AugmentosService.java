package com.augmentos.augmentos_core;

import static com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators.EvenRealitiesG1SGC.deleteEvenSharedPreferences;
import static com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators.EvenRealitiesG1SGC.savePreferredG1DeviceId;
import static com.augmentos.augmentos_core.statushelpers.CoreVersionHelper.getCoreVersion;
import static com.augmentos.augmentos_core.statushelpers.JsonHelper.processJSONPlaceholders;
import static com.augmentos.augmentoslib.AugmentOSGlobalConstants.AUGMENTOS_NOTIFICATION_ID;
import static com.augmentos.augmentoslib.AugmentOSGlobalConstants.AugmentOSAsgClientPackageName;
import static com.augmentos.augmentoslib.AugmentOSGlobalConstants.AugmentOSManagerPackageName;
import static com.augmentos.augmentos_core.BatteryOptimizationHelper.handleBatteryOptimization;
import static com.augmentos.augmentos_core.BatteryOptimizationHelper.isSystemApp;
import static com.augmentos.augmentos_core.Constants.notificationFilterKey;
import static com.augmentos.augmentos_core.Constants.newsSummaryKey;
import static com.augmentos.augmentos_core.Constants.augmentOsMainServiceNotificationId;
import static com.augmentos.augmentoslib.AugmentOSGlobalConstants.GROUP_SUMMARY_NOTIFICATION_ID;
import static com.augmentos.augmentoslib.AugmentOSGlobalConstants.SERVICE_CORE_NOTIFICATION_ID;


import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.hardware.display.VirtualDisplay;
import android.icu.util.TimeZone;
import android.media.projection.MediaProjection;
import android.os.Binder;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.service.notification.NotificationListenerService;
import android.util.Log;

import java.io.IOException;

import androidx.core.app.NotificationCompat;
import androidx.lifecycle.Lifecycle;
import androidx.lifecycle.LifecycleOwner;
import androidx.lifecycle.LifecycleService;
import androidx.preference.PreferenceManager;

import com.augmentos.augmentos_core.augmentos_backend.AuthHandler;
import com.augmentos.augmentos_core.augmentos_backend.HTTPServerComms;
import com.augmentos.augmentos_core.augmentos_backend.ServerComms;
import com.augmentos.augmentos_core.augmentos_backend.ServerCommsCallback;
import com.augmentos.augmentos_core.augmentos_backend.ThirdPartyCloudApp;
import com.augmentos.augmentos_core.augmentos_backend.WebSocketLifecycleManager;
import com.augmentos.augmentos_core.augmentos_backend.WebSocketManager;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.BatteryLevelEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.BrightnessLevelEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.DisplayGlassesDashboardEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesBluetoothSearchDiscoverEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesBluetoothSearchStopEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesHeadDownEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesHeadUpEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.GlassesDisplayPowerEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.HeadUpAngleEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.MicModeChangedEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesDevice;
import com.augmentos.augmentos_core.smarterglassesmanager.utils.BitmapJavaUtils;
import com.augmentos.augmentos_core.smarterglassesmanager.utils.SmartGlassesConnectionState;
import com.augmentos.augmentos_core.smarterglassesmanager.SmartGlassesManager;
import com.augmentos.augmentoslib.ThirdPartyEdgeApp;
import com.augmentos.augmentos_core.comms.AugmentOsActionsCallback;
import com.augmentos.augmentos_core.comms.AugmentosBlePeripheral;
import com.augmentos.augmentos_core.events.NewScreenImageEvent;
import com.augmentos.augmentos_core.events.ThirdPartyEdgeAppErrorEvent;
import com.augmentos.augmentos_core.events.TriggerSendStatusToAugmentOsManagerEvent;
import com.augmentos.augmentos_core.statushelpers.BatteryStatusHelper;
import com.augmentos.augmentos_core.statushelpers.GsmStatusHelper;
import com.augmentos.augmentos_core.statushelpers.WifiStatusHelper;
import com.augmentos.augmentos_core.tpa.EdgeTPASystem;


import com.augmentos.augmentoslib.events.GlassesTapOutputEvent;
import com.augmentos.augmentoslib.events.HomeScreenEvent;
import com.augmentos.augmentoslib.events.SmartRingButtonOutputEvent;

import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.Subscribe;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Date;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Collections;
import java.util.List;
import java.util.Map;
//SpeechRecIntermediateOutputEvent

import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.isMicEnabledForFrontendEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.hci.PhoneMicrophoneManager;
import com.augmentos.augmentos_core.smarterglassesmanager.utils.EnvHelper;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.Response;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class AugmentosService extends LifecycleService implements AugmentOsActionsCallback {
    public static final String TAG = "AugmentOS_AugmentOSService";

   private final IBinder binder = new LocalBinder();

    private final String notificationAppName = "AugmentOS";
    private final String notificationDescription = "";
    private final String myChannelId = "augmentos_core";
    public static final String ACTION_START_CORE = "ACTION_START_CORE";
    public static final String ACTION_STOP_CORE = "ACTION_STOP_CORE";

    public static final String ACTION_START_FOREGROUND_SERVICE = "MY_ACTION_START_FOREGROUND_SERVICE";
    public static final String ACTION_STOP_FOREGROUND_SERVICE = "MY_ACTION_STOP_FOREGROUND_SERVICE";

    private BatteryStatusHelper batteryStatusHelper;
    private WifiStatusHelper wifiStatusHelper;
    private GsmStatusHelper gsmStatusHelper;

    private AuthHandler authHandler;
    private MediaProjection mediaProjection;
    private VirtualDisplay virtualDisplay;
    private final Handler screenCaptureHandler = new Handler();
    private Runnable screenCaptureRunnable;
    private LocationSystem locationSystem;
    private long currTime = 0;
    private long lastPressed = 0;
    private final long lastTapped = 0;

    // Double clicking constants
    private final long doublePressTimeConst = 420;
    private final long doubleTapTimeConst = 600;

    public EdgeTPASystem edgeTpaSystem;

    private String userId;
    public SmartGlassesConnectionState previousSmartGlassesConnectionState = SmartGlassesConnectionState.DISCONNECTED;


    public AugmentosBlePeripheral blePeripheral;

    public SmartGlassesManager smartGlassesManager;
    private final List<Runnable> smartGlassesReadyListeners = new ArrayList<>();
    private NotificationSystem notificationSystem;
    private CalendarSystem calendarSystem;

    private Integer batteryLevel;
    private Integer brightnessLevel;
    private Boolean autoBrightness;
    private Integer headUpAngle;

    private final boolean showingDashboardNow = false;
    private boolean contextualDashboardEnabled;
    private boolean alwaysOnStatusBarEnabled;
    private AsrPlanner asrPlanner;
    private HTTPServerComms httpServerComms;

    JSONObject cachedDashboardDisplayObject;
    private JSONObject cachedDisplayData;
    {
        cachedDisplayData = new JSONObject();
        try {
            JSONObject layout = new JSONObject();
            layout.put("layoutType", "empty");
            cachedDisplayData.put("layout", layout);
        } catch (JSONException e) {
            Log.e(TAG, "Failed to construct cachedDisplayData JSON", e);
        }
    }

    Runnable cachedDashboardDisplayRunnable;
    private String cachedDashboardTopLine;
 
    List<ThirdPartyCloudApp> cachedThirdPartyAppList = new ArrayList<>(); // Initialize here to avoid NPE
    private WebSocketManager.IncomingMessageHandler.WebSocketStatus webSocketStatus = WebSocketManager.IncomingMessageHandler.WebSocketStatus.DISCONNECTED;
    private final Handler serverCommsHandler = new Handler(Looper.getMainLooper());

    private WebSocketLifecycleManager webSocketLifecycleManager;
    private boolean isMicEnabledForFrontend = false;

    private boolean isInitializing = false;

    public AugmentosService() {
    }

    // Smart glasses event handler
    private final SmartGlassesManager.SmartGlassesEventHandler smartGlassesEventHandler = 
        new SmartGlassesManager.SmartGlassesEventHandler() {
            @Override
            public void onGlassesConnectionStateChanged(SmartGlassesDevice device, SmartGlassesConnectionState connectionState) {
                if (connectionState == previousSmartGlassesConnectionState) return;
                previousSmartGlassesConnectionState = connectionState;

                webSocketLifecycleManager.updateSmartGlassesState(connectionState);

                ServerComms.getInstance().sendGlassesConnectionState(device == null ? null : device.deviceModelName, connectionState.name());

                if (connectionState == SmartGlassesConnectionState.CONNECTED) {
                    Log.d(TAG, "Got event for onGlassesConnected.. CONNECTED ..");
                    Log.d(TAG, "****************** SENDING REFERENCE CARD: CONNECTED TO AUGMENT OS");
                    isInitializing = true;
                    playStartupSequenceOnSmartGlasses();
                    asrPlanner.updateAsrLanguages();
                } else if (connectionState == SmartGlassesConnectionState.DISCONNECTED) {
                    edgeTpaSystem.stopAllThirdPartyApps();
                }

                sendStatusToAugmentOsManager();
            }
        };

    public void onTriggerSendStatusToAugmentOsManagerEvent(TriggerSendStatusToAugmentOsManagerEvent event) {
        sendStatusToAugmentOsManager();
    }

    @Subscribe
    public void onGlassesHeadUpEvent(GlassesHeadUpEvent event){
        ServerComms.getInstance().sendHeadPosition("up");
        // BATTERY OPTIMIZATION: Directly call method instead of posting additional event
        if (contextualDashboardEnabled && smartGlassesManager != null) {
            try {
                displayGlassesDashboardEvent();
            } catch (JSONException e) {
                Log.e(TAG, "Error displaying dashboard", e);
            }
        }
    }

    @Subscribe
    public void onGlassesHeadDownEvent(GlassesHeadDownEvent event){
        ServerComms.getInstance().sendHeadPosition("down");
        if (smartGlassesManager != null)
            smartGlassesManager.windowManager.hideDashboard();
    }

    @Subscribe
    public void onGlassesTapSideEvent(GlassesTapOutputEvent event) {
        int numTaps = event.numTaps;
        boolean sideOfGlasses = event.sideOfGlasses;
        long time = event.timestamp;

        Log.d(TAG, "GLASSES TAPPED X TIMES: " + numTaps + " SIDEOFGLASSES: " + sideOfGlasses);
        
        if (smartGlassesManager == null) return;
        if (numTaps == 2 || numTaps == 3) {
            if (smartGlassesManager.windowManager.isDashboardShowing()) {
                smartGlassesManager.windowManager.hideDashboard();
            } else {
                // BATTERY OPTIMIZATION: Directly call method instead of posting additional event
                if (contextualDashboardEnabled) {
                    try {
                        Log.d(TAG, "GOT A DOUBLE+ TAP");
                        displayGlassesDashboardEvent();
                    } catch (JSONException e) {
                        Log.e(TAG, "Error displaying dashboard", e);
                    }
                }
            }
        }
    }

    @Subscribe
    public void onThirdPartyAppErrorEvent(ThirdPartyEdgeAppErrorEvent event) {
        if (blePeripheral != null) {
            blePeripheral.sendNotifyManager(event.text, "error");
        }
        if (edgeTpaSystem != null) {
            edgeTpaSystem.stopThirdPartyAppByPackageName(event.packageName);
        }
        if (smartGlassesManager != null) {
            smartGlassesManager.windowManager.showAppLayer("system", () -> smartGlassesManager.sendReferenceCard("App error", event.text), 10);
        }
        sendStatusToAugmentOsManager();
    }

    //TODO NO MORE PASTA
    public ArrayList<String> notificationList = new ArrayList<String>();
    public JSONArray latestNewsArray = new JSONArray();
    private int latestNewsIndex = 0;
    @Subscribe
    public void displayGlassesDashboardEvent() throws JSONException {
        if (!contextualDashboardEnabled) {
            return;
        }

        if (cachedDashboardDisplayObject != null) {
            if(smartGlassesManager != null) {
                Runnable dashboardDisplayRunnable = parseDisplayEventMessage(cachedDashboardDisplayObject);

                smartGlassesManager.windowManager.showDashboard(dashboardDisplayRunnable,
                        -1
                );
            }

            if(blePeripheral != null) {
                JSONObject newMsg = generateTemplatedJsonFromServer(cachedDashboardDisplayObject);
                blePeripheral.sendGlassesDisplayEventToManager(newMsg);
            }
            return;
        }

        // SHOW FALLBACK DASHBOARD

        // --- Build date/time line ---
        SimpleDateFormat currentTimeFormat = new SimpleDateFormat("h:mm", Locale.getDefault());
        SimpleDateFormat currentDateFormat = new SimpleDateFormat("MMM d", Locale.getDefault());
        String currentTime = currentTimeFormat.format(new Date());
        String currentDate = currentDateFormat.format(new Date());

        // Battery, date/time, etc.
        String leftHeaderLine = String.format(Locale.getDefault(), "◌ %s %s, %d%%\n", currentTime, currentDate, batteryLevel);

        String connString = webSocketStatus == null ? "Not connected" : webSocketStatus.name();;

        if (smartGlassesManager != null) {
            smartGlassesManager.windowManager.showDashboard(() ->
                            smartGlassesManager.sendDoubleTextWall(leftHeaderLine, connString),
                    -1
            );
        }
    }

    @Subscribe
    public void onGlassBatteryLevelEvent(BatteryLevelEvent event) {
        if (batteryLevel != null && event.batteryLevel == batteryLevel) return;
        batteryLevel = event.batteryLevel;
        ServerComms.getInstance().sendGlassesBatteryUpdate(event.batteryLevel, false, -1);
        sendStatusToAugmentOsManager();
    }

    @Subscribe
    public void onBrightnessLevelEvent(BrightnessLevelEvent event) {
        brightnessLevel = event.brightnessLevel;
        autoBrightness = event.autoBrightness;

        if (brightnessLevel != -1) {
            PreferenceManager.getDefaultSharedPreferences(this)
                .edit()
                .putString(this.getResources().getString(R.string.SHARED_PREF_BRIGHTNESS), String.valueOf(brightnessLevel))
                .apply();
            PreferenceManager.getDefaultSharedPreferences(this)
                .edit()
                .putBoolean(this.getResources().getString(R.string.SHARED_PREF_AUTO_BRIGHTNESS), false)
                .apply();
        } else {
            PreferenceManager.getDefaultSharedPreferences(this)
                .edit()
                .putBoolean(this.getResources().getString(R.string.SHARED_PREF_AUTO_BRIGHTNESS), autoBrightness)
                .apply();
        }
        sendStatusToAugmentOsManager();
    }

    @Subscribe
    public void onHeadUpAngleEvent(HeadUpAngleEvent event) {
//        Log.d(TAG, "BRIGHTNESS received");
        headUpAngle = event.headUpAngle;
        PreferenceManager.getDefaultSharedPreferences(this)
                .edit()
                .putString(this.getResources().getString(R.string.HEADUP_ANGLE), String.valueOf(headUpAngle))
                .apply();
        sendStatusToAugmentOsManager();
    }

    @Override
    public void onCreate() {
        super.onCreate();

//        EnvHelper.init(this);

        EventBus.getDefault().register(this);

        ServerComms.getInstance(this);

        authHandler = new AuthHandler(this);

        userId = authHandler.getUniqueIdForAnalytics();

        batteryStatusHelper = new BatteryStatusHelper(this);
        wifiStatusHelper = new WifiStatusHelper(this);
        gsmStatusHelper = new GsmStatusHelper(this);

        notificationSystem = new NotificationSystem(this, userId);
        calendarSystem = CalendarSystem.getInstance(this);

        Log.d(TAG, "Auto Brightness___: " + PreferenceManager.getDefaultSharedPreferences(this)
                .getBoolean(getResources().getString(R.string.SHARED_PREF_AUTO_BRIGHTNESS), false));
        brightnessLevel = Integer.parseInt(PreferenceManager.getDefaultSharedPreferences(this).getString(getResources().getString(R.string.SHARED_PREF_BRIGHTNESS), "50"));
        autoBrightness = PreferenceManager.getDefaultSharedPreferences(this)
                .getBoolean(getResources().getString(R.string.SHARED_PREF_AUTO_BRIGHTNESS), false);
        headUpAngle = Integer.parseInt(PreferenceManager.getDefaultSharedPreferences(this).getString(getResources().getString(R.string.HEADUP_ANGLE), "20"));

        contextualDashboardEnabled = getContextualDashboardEnabled();
        alwaysOnStatusBarEnabled = getAlwaysOnStatusBarEnabled();

        edgeTpaSystem = new EdgeTPASystem(this, null); // We'll set smartGlassesManager after it's created
        asrPlanner = new AsrPlanner(edgeTpaSystem);

        // Initialize BLE Peripheral
        blePeripheral = new AugmentosBlePeripheral(this, this);

        // If this is the ASG client, start the peripheral
        if (getPackageName().equals(AugmentOSAsgClientPackageName)) {
        //    blePeripheral.start();
        }

        // Whitelist AugmentOS from battery optimization when system app
        // If not system app, bring up the settings menu
        if (isSystemApp(this)) {
            handleBatteryOptimization(this);
        }

        // Automatically connect to glasses on service start
        String preferredWearable = SmartGlassesManager.getPreferredWearable(this);
        if(!preferredWearable.isEmpty()) {
            SmartGlassesDevice preferredDevice = SmartGlassesManager.getSmartGlassesDeviceFromModelName(preferredWearable);
            if (preferredDevice != null) {
                // Initialize SmartGlassesManager
                startSmartGlassesManager();
                // Connect to glasses
                smartGlassesManager.connectToSmartGlasses(preferredDevice);
                sendStatusToAugmentOsManager();
            } else {
                // We have some invalid device saved... delete from preferences
                SmartGlassesManager.savePreferredWearable(this, "");
            }
        }

        // cachedThirdPartyAppList is already initialized as a class member

        webSocketLifecycleManager = new WebSocketLifecycleManager(this, authHandler);

        // Set up backend comms
        this.httpServerComms = new HTTPServerComms();
        //if(authHandler.getCoreToken() != null)
        //    ServerComms.getInstance().connectWebSocket(authHandler.getCoreToken());
        initializeServerCommsCallbacks();

//        httpServerComms.getApps(new Callback() {
//            @Override
//            public void onFailure(Call call, IOException e) {
//                Log.e("HTTP", "GET /apps failed: " + e.getMessage());
//            }
//
//            @Override
//            public void onResponse(Call call, Response response) throws IOException {
//                if (response.isSuccessful()) {
//                    Log.d("HTTP", "Response: ");
//                }
//            }
//        });

        locationSystem = new LocationSystem(this);
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    myChannelId,
                    notificationAppName,
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription(notificationDescription);
            channel.enableLights(false);
            channel.enableVibration(false);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    // Flag to track if we should restart when killed
    private boolean shouldRestartOnKill = true;
    
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        super.onStartCommand(intent, flags, startId);

        if (intent == null || intent.getAction() == null) {
            Log.e(TAG, "Received null intent or null action");
            // If we get null intent/action, maintain the sticky behavior for embedded systems
            return shouldRestartOnKill ? Service.START_STICKY : Service.START_NOT_STICKY;
        }

        String action = intent.getAction();
        Bundle extras = intent.getExtras();

        switch (action) {
            case ACTION_START_CORE:
            case ACTION_START_FOREGROUND_SERVICE:
                // start the service in the foreground
                Log.d("TEST", "starting foreground");
                createNotificationChannel(); // New method to ensure one-time channel creation
                startForeground(AUGMENTOS_NOTIFICATION_ID, this.buildSharedForegroundNotification(this));
                
                // Reset restart flag to true when service starts
                shouldRestartOnKill = true;

                // Send out the status once AugmentOS_Core is ready :)
                edgeTpaSystem.startThirdPartyAppByPackageName(AugmentOSManagerPackageName);

                if (!NewPermissionUtils.areAllPermissionsGranted(this)) {
                    blePeripheral.sendPermissionsErrorToManager();
                }

                break;
            case ACTION_STOP_CORE:
            case ACTION_STOP_FOREGROUND_SERVICE:
                // Set flag to not restart - this is an explicit stop request
                shouldRestartOnKill = false;
                
                // Clean up resources before stopping
                Log.d(TAG, "Stopping service from ACTION_STOP");
                cleanupAllResources();
                stopForeground(true);
                stopSelf();
                break;
            default:
                Log.d(TAG, "Unknown action received in onStartCommand");
                Log.d(TAG, action);
        }
        
        // Return START_STICKY by default for embedded hardware,
        // but the shouldRestartOnKill flag will be checked in onTaskRemoved/onDestroy
        return shouldRestartOnKill ? Service.START_STICKY : Service.START_NOT_STICKY;
    }

    private Notification updateNotification() {
        Context context = getApplicationContext();

        PendingIntent action = PendingIntent.getActivity(context,
                0, new Intent(context, MainActivity.class),
                PendingIntent.FLAG_CANCEL_CURRENT | PendingIntent.FLAG_MUTABLE); // Flag indicating that if the described PendingIntent already exists, the current one should be canceled before generating a new one.

        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationCompat.Builder builder;

        String CHANNEL_ID = myChannelId;

        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, notificationAppName,
                NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription(notificationDescription);
        channel.enableVibration(false);
        channel.enableLights(false);
        manager.createNotificationChannel(channel);

        builder = new NotificationCompat.Builder(this, CHANNEL_ID);

        return builder.setContentIntent(action)
                .setContentTitle(notificationAppName)
                .setContentText(notificationDescription)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setTicker("...")
                .setContentIntent(action)
                .setOngoing(true).build();
    }
    
    // Replacement for buildSharedForegroundNotification that was previously imported from AugmentOSLib
    private Notification buildSharedForegroundNotification(Context context) {
        // Create a notification similar to updateNotification
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        
        // Create the notification channel if it doesn't exist
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    myChannelId,
                    notificationAppName,
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription(notificationDescription);
            channel.enableLights(false);
            channel.enableVibration(false);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
        
        // Create the intent for when notification is tapped
        PendingIntent pendingIntent = PendingIntent.getActivity(
                context,
                0,
                new Intent(context, MainActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE
        );
        
        // Build the notification
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, myChannelId)
                .setContentTitle(notificationAppName)
                .setContentText(notificationDescription)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(pendingIntent)
                .setOngoing(true);
                
        return builder.build();
    }

    // Method to initialize the SmartGlassesManager
    public void startSmartGlassesManager() {
        if (smartGlassesManager == null) {
            // Now we can pass 'this' as the LifecycleOwner since we extend LifecycleService
            smartGlassesManager = new SmartGlassesManager(this, this, smartGlassesEventHandler);
            edgeTpaSystem.setSmartGlassesManager(smartGlassesManager);
            // Execute any pending actions
            for (Runnable action : smartGlassesReadyListeners) {
                action.run();
            }
            smartGlassesReadyListeners.clear();
        }
    }

    // Method to clean up the SmartGlassesManager
    public void stopSmartGlassesManager() {
        if (smartGlassesManager != null) {
            smartGlassesManager.cleanup();
            smartGlassesManager = null;
            edgeTpaSystem.setSmartGlassesManager(null);
            webSocketLifecycleManager.updateSmartGlassesState(SmartGlassesConnectionState.DISCONNECTED);
        }
    }

    @Subscribe
    public void onGlassesDisplayPowerEvent(GlassesDisplayPowerEvent event) {
        if (smartGlassesManager == null) return;
        if (event.turnedOn) {
            // BATTERY OPTIMIZATION: Using direct lambda instead of creating a new Runnable object
            smartGlassesManager.windowManager.showAppLayer(
                "system", 
                () -> smartGlassesManager.sendReferenceCard("AugmentOS Connected", "Screen back on"), 
                4
            );
        }
    }

    private static final String[] ARROW_FRAMES = {
           // "↑", "↗", "–", "↘", "↓", "↙", "–", "↖"
            "↑", "↗", "↑", "↖"
    };

    // BATTERY OPTIMIZATION: Use a single Handler instance for the service
    private final Handler uiHandler = new Handler(Looper.getMainLooper());
    private Runnable animationRunnable;
    
    private void playStartupSequenceOnSmartGlasses() {
        if (smartGlassesManager == null || smartGlassesManager.windowManager == null) return;

        // Cancel any existing animation to prevent multiple animations running
        if (animationRunnable != null) {
            uiHandler.removeCallbacks(animationRunnable);
        }
        
        int delay = 250; // Frame delay
        int totalFrames = ARROW_FRAMES.length;
        int totalCycles = 3;

        animationRunnable = new Runnable() {
            int frameIndex = 0;
            int cycles = 0;

            @Override
            public void run() {
                // Check for null each time before updating the UI
                if (smartGlassesManager == null || smartGlassesManager.windowManager == null) {
                    return;
                }

                if (cycles >= totalCycles) {
                    // End animation with final message
                    smartGlassesManager.windowManager.showAppLayer(
                            "system",
                            () -> smartGlassesManager.sendTextWall("                  /// AugmentOS Connected \\\\\\"),
                            6
                    );

                    // Set isInitializing to false after booting sequence is finished, with 100ms delay
                    uiHandler.postDelayed(() -> isInitializing = false, 500);
                    return; // Stop looping
                }

                // Send current frame
                String currentAnimationTextFrame = "                    " + ARROW_FRAMES[frameIndex] + " AugmentOS Booting " + ARROW_FRAMES[frameIndex];
                smartGlassesManager.windowManager.showAppLayer(
                        "system",
                        () -> {
                                smartGlassesManager.sendTextWall(currentAnimationTextFrame);
                        },
                        6
                );
                // Send the same text wall to AugmentOS Manager in JSONObject format
                JSONObject displayJson = new JSONObject();
                try {
                    JSONObject layoutJson = new JSONObject();
                    layoutJson.put("layoutType", "text_wall");
                    layoutJson.put("text", currentAnimationTextFrame);
                    displayJson.put("layout", layoutJson);
                    //blePeripheral.sendGlassesDisplayEventToManager(displayJson);
                } catch (JSONException e) {
                    Log.e(TAG, "Error creating display JSON", e);
                }

                // Move to next frame
                frameIndex = (frameIndex + 1) % totalFrames;

                // Count full cycles
                if (frameIndex == 0) cycles++;

                // Schedule next frame
                uiHandler.postDelayed(this, delay);
            }
        };

        // Start animation with the reused handler
        uiHandler.postDelayed(animationRunnable, 350);
    }

    @Subscribe
    public void onSmartRingButtonEvent(SmartRingButtonOutputEvent event) {
        int buttonId = event.buttonId;
        long time = event.timestamp;
        boolean isDown = event.isDown;

        if(!isDown || buttonId != 1) return;
        Log.d(TAG,"DETECTED BUTTON PRESS W BUTTON ID: " + buttonId);
        currTime = System.currentTimeMillis();

        ServerComms.getInstance().sendButtonPress("ring", "single");

        //Detect double presses
        if(isDown && currTime - lastPressed < doublePressTimeConst) {
            Log.d(TAG, "Double tap - CurrTime-lastPressed: "+ (currTime-lastPressed));
            ServerComms.getInstance().sendButtonPress("ring", "double");
        }

        if(isDown) {
            lastPressed = System.currentTimeMillis();
        }
    }

    private JSONObject generateTemplatedJsonFromServer(JSONObject rawMsg) {
        // Process all placeholders in the entire JSON structure in a single pass
        SimpleDateFormat sdf = new SimpleDateFormat("M/dd, h:mm");
        String formattedDate = sdf.format(new Date());

        // 12-hour time format (with leading zeros for hours)
        SimpleDateFormat time12Format = new SimpleDateFormat("hh:mm");
        String time12 = time12Format.format(new Date());

        // 24-hour time format
        SimpleDateFormat time24Format = new SimpleDateFormat("HH:mm");
        String time24 = time24Format.format(new Date());

        // Current date with format MM/dd
        SimpleDateFormat dateFormat = new SimpleDateFormat("MM/dd");
        String currentDate = dateFormat.format(new Date());

        Map<String, String> placeholders = new HashMap<>();
        placeholders.put("$no_datetime$", formattedDate);
        placeholders.put("$DATE$", currentDate);
        placeholders.put("$TIME12$", time12);
        placeholders.put("$TIME24$", time24);
        placeholders.put("$GBATT$", (batteryLevel == null ? "" : batteryLevel + "%"));

        try {
            JSONObject msg = processJSONPlaceholders(rawMsg, placeholders);
            return msg;
        } catch (JSONException e) {
            //throw new RuntimeException(e);
            Log.d(TAG, "Error processing JSON placeholders: " + e.getMessage());
            return rawMsg;
        }
    }

    private void parseAugmentosResults(JSONObject jsonResponse) throws JSONException {
        JSONArray notificationArray = jsonResponse.getJSONArray(notificationFilterKey);
        JSONArray newsSummaryArray = jsonResponse.getJSONArray(newsSummaryKey);

        if (notificationArray.length() > 0) {
            JSONArray notifications = notificationArray.getJSONObject(0).getJSONArray("notification_data");
            Log.d(TAG, "Got notifications: " + notifications);

            List<JSONObject> sortedNotifications = new ArrayList<>();
            for (int i = 0; i < notifications.length(); i++) {
                sortedNotifications.add(notifications.getJSONObject(i));
            }

            Collections.sort(sortedNotifications, new Comparator<JSONObject>() {
                @Override
                public int compare(JSONObject a, JSONObject b) {
                    try {
                        return Integer.compare(a.getInt("rank"), b.getInt("rank"));
                    } catch (JSONException e) {
                        // If a rank is missing or unparsable, treat as equal
                        return 0;
                    }
                }
            });

            notificationList.clear();
//        Log.d(TAG, "Got notifications: " + sortedNotifications.toString());

            for (int i = 0; i < sortedNotifications.size(); i++) {
                JSONObject notification = sortedNotifications.get(i);
                String summary = notification.getString("summary");
                notificationList.add(summary);
            }
        }

        if (newsSummaryArray.length() > 0) {
            JSONObject newsSummary = newsSummaryArray.getJSONObject(0);
            latestNewsArray = newsSummary.getJSONObject("news_data").getJSONArray("news_summaries");
            Log.d(TAG, "Latest news: " + latestNewsArray);
        }
    }

    public Runnable parseDisplayEventMessage(JSONObject rawMsg) {
        if(isInitializing) {
            return () -> {};
        }

        try {
            JSONObject msg = generateTemplatedJsonFromServer(rawMsg);

//                Log.d(TAG, "Parsed message: " + msg.toString());

            JSONObject layout = msg.getJSONObject("layout");
            String layoutType = layout.getString("layoutType");
            String title;
            String text;
            switch (layoutType) {
                case "empty":
                    return () -> smartGlassesManager.sendTextWall(cachedDashboardTopLine);
                case "reference_card":
                    title = layout.getString("title");
                    text = layout.getString("text");
                    return () -> smartGlassesManager.sendReferenceCard(title, text);
                case "text_wall":
                case "text_line": // This assumes that the dashboard doesn't use textwall layout
                    text = layout.getString("text");
                    return () -> smartGlassesManager.sendTextWall(text);
                case "double_text_wall":
                    String topText = layout.getString("topText");
                    String bottomText = layout.getString("bottomText");
                    return () -> smartGlassesManager.sendDoubleTextWall(topText, bottomText);
                case "text_rows":
                    JSONArray rowsArray = layout.getJSONArray("text");
                    String[] stringsArray = new String[rowsArray.length()];
                    for (int k = 0; k < rowsArray.length(); k++)
                        stringsArray[k] = rowsArray.getString(k);
                    return () -> smartGlassesManager.sendRowsCard(stringsArray);
                case "bitmap_view":
                    String base64Data = layout.getString("data");
                    byte[] decodedBytes = android.util.Base64.decode(base64Data, android.util.Base64.DEFAULT);
                    Bitmap bmp = BitmapJavaUtils.bytesToBitmap(decodedBytes);
                    return () -> smartGlassesManager.sendBitmap(bmp);
                default:
                    Log.d(TAG, "ISSUE PARSING LAYOUT");
            }
        } catch (JSONException e) {
            e.printStackTrace();
        }
        return () -> {};
    }

    /**
     * Parses the top line of a dashboard display.
     * This function extracts and processes information specifically from the top line
     * of the dashboard display, which typically contains time, date, battery status, etc.
     * 
     * @param msg The JSON object containing the dashboard display data
     * @return The parsed top line string, or null if there was an error in parsing
     */
    public String parseDashboardTopLine(JSONObject msg) {
        try {
            // First check if this is a proper dashboard display with layout
            if (msg == null || !msg.has("layout")) {
                return generateFallbackDashboardTopLine();
            }
            
            JSONObject layout = msg.getJSONObject("layout");
            String layoutType = layout.getString("layoutType");
            
            // Most dashboards use double_text_wall layout
            if ("double_text_wall".equals(layoutType) && layout.has("topText")) {
                String topText = layout.getString("topText");
                if (topText.contains("\n")) {
                    topText = topText.split("\n")[0];
                }

                if (topText.contains("$GBATT$")) {
                    topText = topText.replace("$GBATT$", batteryLevel != null ? String.valueOf(batteryLevel) : "");
                }

                // Process special tokens in the top line if needed
                if (topText.contains("$no_datetime$")) {
                    SimpleDateFormat sdf = new SimpleDateFormat("M/dd, h:mm", Locale.getDefault());
                    String formatted = sdf.format(new Date());
                    topText = topText.replace("$no_datetime$", formatted);
                }
                
                return topText;
            } else if ("text_rows".equals(layoutType) && layout.has("text")) {
                // For text_rows layout, the first row is typically the header
                JSONArray rowsArray = layout.getJSONArray("text");
                if (rowsArray.length() > 0) {
                    return rowsArray.getString(0);
                }
            }
            
            // If we can't parse the dashboard format or it's not what we expect,
            // generate a fallback header line
            return generateFallbackDashboardTopLine();
            
        } catch (JSONException e) {
            Log.e(TAG, "Error parsing dashboard top line", e);
            return generateFallbackDashboardTopLine();
        }
    }
    
    /**
     * Generates a fallback dashboard top line when the normal parsing fails.
     * This ensures that even if there are issues with the dashboard data,
     * we still display useful information to the user.
     * 
     * @return A formatted string with time, date, and battery information
     */
    private String generateFallbackDashboardTopLine() {
        SimpleDateFormat currentTimeFormat = new SimpleDateFormat("h:mm", Locale.getDefault());
        SimpleDateFormat currentDateFormat = new SimpleDateFormat("MMM d", Locale.getDefault());
        String currentTime = currentTimeFormat.format(new Date());
        String currentDate = currentDateFormat.format(new Date());
        
        // Use a safe default if battery level is null
        int batteryPercentage = (batteryLevel != null) ? batteryLevel : 0;
        
        // Format: "◌ h:mm MMM d, XX%"
        return String.format(Locale.getDefault(), "◌ %s %s, %d%%", 
                currentTime, currentDate, batteryPercentage);
    }

    /**
     * Extracts specific information from a dashboard top line.
     * This function can identify and extract elements like time, battery level,
     * or other structured data from the dashboard top line.
     * 
     * @param topLine The dashboard top line string to analyze
     * @return A JSONObject containing the extracted information
     */
    public JSONObject extractDashboardTopLineInfo(String topLine) {
        JSONObject result = new JSONObject();
        
        try {
            // Check for null or empty input
            if (topLine == null || topLine.trim().isEmpty()) {
                return result;
            }
            
            // Extract time pattern (like "h:mm" or "hh:mm")
            Pattern timePattern = Pattern.compile("\\d{1,2}:\\d{2}");
            Matcher timeMatcher = timePattern.matcher(topLine);
            if (timeMatcher.find()) {
                result.put("time", timeMatcher.group());
            }
            
            // Extract date pattern (like "MMM d" or "Month day")
            Pattern datePattern = Pattern.compile("(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2}");
            Matcher dateMatcher = datePattern.matcher(topLine);
            if (dateMatcher.find()) {
                result.put("date", dateMatcher.group());
            }
            
            // Extract battery percentage (like "85%" or "100%")
            Pattern batteryPattern = Pattern.compile("(\\d{1,3})%");
            Matcher batteryMatcher = batteryPattern.matcher(topLine);
            if (batteryMatcher.find()) {
                result.put("battery", Integer.parseInt(batteryMatcher.group(1)));
            }
            
            // Detect if this is a status line (contains specific indicators)
            boolean isStatusLine = topLine.contains("◌") || 
                                 (result.has("time") && result.has("battery"));
            result.put("isStatusLine", isStatusLine);
            
        } catch (JSONException e) {
            Log.e(TAG, "Error creating dashboard top line info JSON", e);
        }
        
        return result;
    }

    @Subscribe
    public void onGlassesBluetoothSearchDiscoverEvent(GlassesBluetoothSearchDiscoverEvent event){
        blePeripheral.sendGlassesBluetoothDiscoverResultToManager(event.modelName, event.deviceName);
    }

    @Subscribe
    public void onGlassesBluetoothSearchStopEvent(GlassesBluetoothSearchStopEvent event){
        blePeripheral.sendGlassesBluetoothStopToManager(event.modelName);
    }

    @Subscribe
    public void onNewScreenImageEvent(NewScreenImageEvent event) {
        if (smartGlassesManager != null)
            smartGlassesManager.windowManager.showAppLayer("server", () -> smartGlassesManager.sendBitmap(event.bmp), -1);
    }

    private void startNotificationService() {
        Intent notificationServiceIntent = new Intent(this, MyNotificationListeners.class);
        startService(notificationServiceIntent);

        NotificationListenerService.requestRebind(
                new ComponentName(this, MyNotificationListeners.class));
    }

    private void stopNotificationService() {
        Intent notificationServiceIntent = new Intent(this, MyNotificationListeners.class);
        stopService(notificationServiceIntent);
    }

    public boolean getIsSearchingForGlasses() {
        return smartGlassesManager != null
                && smartGlassesManager.getSmartGlassesConnectState() != SmartGlassesConnectionState.DISCONNECTED
                && smartGlassesManager.getSmartGlassesConnectState() != SmartGlassesConnectionState.CONNECTED;
    }

    private void executeOnceSmartGlassesManagerReady(Context context, Runnable action) {
        if (smartGlassesManager != null) {
            // If the manager is already initialized, execute the action immediately
            action.run();
            return;
        }

        // Add the action to the queue
        smartGlassesReadyListeners.add(action);

        // Ensure the manager is started
        startSmartGlassesManager();
    }

    public JSONObject generateStatusJson() {
        try {
            // Creating the main status object
            JSONObject status = new JSONObject();

            // Adding puck battery life and charging status
            JSONObject coreInfo = new JSONObject();
            coreInfo.put("augmentos_core_version", getCoreVersion(this));
            coreInfo.put("core_token", authHandler.getCoreToken());
            coreInfo.put("cloud_connection_status", webSocketStatus.name());
            coreInfo.put("puck_battery_life", batteryStatusHelper.getBatteryLevel());
            coreInfo.put("charging_status", batteryStatusHelper.isBatteryCharging());
            coreInfo.put("sensing_enabled", SmartGlassesManager.getSensingEnabled(this));
            coreInfo.put("bypass_vad_for_debugging", SmartGlassesManager.getBypassVadForDebugging(this));
            coreInfo.put("bypass_audio_encoding_for_debugging", SmartGlassesManager.getBypassAudioEncodingForDebugging(this));
            coreInfo.put("contextual_dashboard_enabled", this.contextualDashboardEnabled);
            coreInfo.put("force_core_onboard_mic", SmartGlassesManager.getForceCoreOnboardMic(this));
            coreInfo.put("default_wearable", SmartGlassesManager.getPreferredWearable(this));
            coreInfo.put("is_mic_enabled_for_frontend", isMicEnabledForFrontend);
            status.put("core_info", coreInfo);
            //Log.d(TAG, "PREFER - Got default wearable: " + SmartGlassesManager.getPreferredWearable(this));

            // Adding connected glasses object
            JSONObject connectedGlasses = new JSONObject();
            if(smartGlassesManager != null && smartGlassesManager.getConnectedSmartGlasses() != null) {
                connectedGlasses.put("model_name", smartGlassesManager.getConnectedSmartGlasses().deviceModelName);
                connectedGlasses.put("battery_life", (batteryLevel == null) ? -1: batteryLevel); //-1 if unknown
                String brightnessString;
                if (brightnessLevel == null) {
                    brightnessString = "-";
                } else if (brightnessLevel == -1){
                    brightnessString = "AUTO";
                } else {
                    brightnessString = brightnessLevel + "%";
                }
                connectedGlasses.put("brightness", brightnessString);
                connectedGlasses.put("auto_brightness_enabled", autoBrightness);
//                Log.d(TAG, "Connected glasses info: " + headUpAngle);
                if (headUpAngle == null) {
                    headUpAngle = 20;
                }
                connectedGlasses.put("headUp_angle", headUpAngle);
            }
            else {
                connectedGlasses.put("is_searching", getIsSearchingForGlasses());
            }
            status.put("connected_glasses", connectedGlasses);

            // Adding wifi status
            JSONObject wifi = new JSONObject();
            wifi.put("is_connected", wifiStatusHelper.isWifiConnected());
            wifi.put("ssid", wifiStatusHelper.getSSID());
            wifi.put("signal_strength", wifiStatusHelper.getSignalStrength());
            status.put("wifi", wifi);

            // Adding gsm status
            JSONObject gsm = new JSONObject();
            gsm.put("is_connected", gsmStatusHelper.isConnected());
            gsm.put("carrier", gsmStatusHelper.getNetworkType());
            gsm.put("signal_strength", gsmStatusHelper.getSignalStrength());
            status.put("gsm", gsm);

            // Adding apps array
            JSONArray apps = new JSONArray();

//            for (ThirdPartyEdgeApp tpa : edgeTpaSystem.getThirdPartyApps()) {
//                if(tpa.appType != ThirdPartyAppType.APP) continue;
//
//                JSONObject tpaObj = tpa.toJson(false);
//                tpaObj.put("is_running", edgeTpaSystem.checkIsThirdPartyAppRunningByPackageName(tpa.packageName));
//                tpaObj.put("is_foreground", edgeTpaSystem.checkIsThirdPartyAppRunningByPackageName(tpa.packageName));
//                apps.put(tpaObj);
//            }

            // Check if cachedThirdPartyAppList is not null before iterating
            if (cachedThirdPartyAppList != null) {
                for (ThirdPartyCloudApp tpa : cachedThirdPartyAppList) {
                    JSONObject tpaObj = tpa.toJson(false);
                    tpaObj.put("is_foreground", false);//tpaSystem.checkIsThirdPartyAppRunningByPackageName(tpa.packageName));
                    apps.put(tpaObj);
                }
            }

            // Adding apps array to the status object
            status.put("apps", apps);

            // Add auth to status object
            status.put("auth", authHandler.toJson());

            // Wrapping the status object inside a main object (as shown in your example)
            JSONObject mainObject = new JSONObject();
            mainObject.put("status", status);

            return mainObject;
        } catch (JSONException e) {
            throw new RuntimeException(e);
        }
    }

    public void initializeServerCommsCallbacks() {
        ServerComms.getInstance().setServerCommsCallback(new ServerCommsCallback() {
            @Override
            public void onConnectionAck() {
                serverCommsHandler.postDelayed(() -> locationSystem.sendLocationToServer(), 500);
            }
            @Override
            public void onAppStateChange(List<ThirdPartyCloudApp> appList) {
                cachedThirdPartyAppList = appList;
                sendStatusToAugmentOsManager();
            }

            @Override
            public void onDisplayEvent(JSONObject displayData) {
                cachedDisplayData = displayData;
//                Log.d(TAG,"Received display data: " + displayData.toString());
                Runnable newRunnable = parseDisplayEventMessage(displayData);
//                Log.d(TAG, displayData.toString());
//                Log.d(TAG, "Parsed display event message: " + displayData.has("durationMs"));
                int durationMs = displayData.optInt("durationMs", -1);
//                Log.d(TAG, "Received display event with duration: " + durationMs);
//                Log.d("AugmentosService", "Received display event: " + displayData.toString());
                if (smartGlassesManager != null) {
                        smartGlassesManager.windowManager.showAppLayer("serverappid", newRunnable, durationMs / 1000); // TODO: either only use seconds or milliseconds
                }
                if (blePeripheral != null) {
                    JSONObject newMsg = generateTemplatedJsonFromServer(displayData);
                    blePeripheral.sendGlassesDisplayEventToManager(newMsg);  //THIS LINE RIGHT HERE ENDS UP TRIGGERING IT
                }
            }

            @Override
            public void onDashboardDisplayEvent(JSONObject dashboardDisplayData) {
                cachedDashboardDisplayObject = dashboardDisplayData;
                // Parse the top line for logging/debugging
                cachedDashboardTopLine = parseDashboardTopLine(dashboardDisplayData);

                // Create the runnable as before
                cachedDashboardDisplayRunnable = parseDisplayEventMessage(dashboardDisplayData);
            }

            @Override
            public void onConnectionError(String errorMsg) {
                if(blePeripheral != null) {
                    blePeripheral.sendNotifyManager("Connection error: " + errorMsg, "error");
                }
            }

            @Override
            public void onAuthError() {
                // TODO: do a thing
                // TODO: is this the way we want to do it? should just be in status maybe???
                // blePeripheral.sendAuthErrorToManager();
                authHandler.deleteAuthSecretKey();
                sendStatusToAugmentOsManager();
            }

            @Override
            public void onMicrophoneStateChange(boolean microphoneEnabled) {
                if (smartGlassesManager != null && SmartGlassesManager.getSensingEnabled(getApplicationContext())) {
                    smartGlassesManager.changeMicrophoneState(microphoneEnabled);
                }
            }

            @Override
            public void onConnectionStatusChange(WebSocketManager.IncomingMessageHandler.WebSocketStatus status) {
                webSocketStatus = status;
                sendStatusToAugmentOsManager();
            }

            @Override
            public void onRequestSingle(String dataType) {
                switch (dataType) {
                    case "core_status":
                        Log.d(TAG, "Server wants a core_status");
                        sendStatusToBackend();
                    break;
                    case "photo":
                        Log.d(TAG, "Server wants a photo");
                    default:
                        Log.d(TAG, "Unknown onRequestSingle dataType: " + dataType);
                        break;
                }
            }
        });
    }

    // AugmentOS_Manager Comms Callbacks
    public void sendStatusToBackend() {
        JSONObject status = generateStatusJson();
        ServerComms.getInstance().sendCoreStatus(status);
    }
    public void sendStatusToAugmentOsManager(){
        JSONObject status = generateStatusJson();
        blePeripheral.sendDataToAugmentOsManager(status.toString());
    }

    @Override
    public void requestPing() {
        blePeripheral.sendPing();
    }

    @Override
    public void requestStatus() {
        sendStatusToAugmentOsManager();
    }

    @Override
    public void searchForCompatibleDeviceNames(String modelName) {
        Log.d("AugmentOsService", "Searching for compatible device names for model: " + modelName);
        SmartGlassesDevice device = SmartGlassesManager.getSmartGlassesDeviceFromModelName(modelName);
        if (device == null) {
            blePeripheral.sendNotifyManager("Incorrect model name: " + modelName, "error");
            return;
        }

        executeOnceSmartGlassesManagerReady(this, () -> {
            smartGlassesManager.findCompatibleDeviceNames(device);
            // blePeripheral.sendGlassesSearchResultsToManager(modelName, compatibleDeviceNames);
        });
    }

    @Subscribe
    public void onMicStateForFrontendEvent(isMicEnabledForFrontendEvent event) {
        Log.d("AugmentOsService", "Received mic state for frontend event: " + event.micState);
        isMicEnabledForFrontend = event.micState;
        sendStatusToAugmentOsManager();
    }

        // TODO: This is for debug.. remove before pushing to prod
    @Subscribe
    public void handleMicModeChangedEvent(MicModeChangedEvent event) {
        Log.d(TAG, "Microphone mode changed: " + event.getStatus());
        
        // Log the new microphone status
        PhoneMicrophoneManager.MicStatus status = event.getStatus();
        //blePeripheral.sendNotifyManager(status.name(), "success");
        switch (status) {
            case SCO_MODE:
                Log.d(TAG, "Microphone using Bluetooth SCO mode");
                break;
            case NORMAL_MODE:
                Log.d(TAG, "Microphone using normal phone mic");
                break;
            case GLASSES_MIC:
                Log.d(TAG, "Microphone using glasses onboard mic");
                break;
            case PAUSED:
                Log.d(TAG, "Microphone recording paused (conflict detected)");
                break;
        }
    }

    @Override
    public void connectToWearable(String modelName, String deviceName) {
        Log.d("AugmentOsService", "Connecting to wearable: " + modelName + ". DeviceName: " + deviceName + ".");
        
        SmartGlassesDevice device = SmartGlassesManager.getSmartGlassesDeviceFromModelName(modelName);
        if (device == null) {
            blePeripheral.sendNotifyManager("Incorrect model name: " + modelName, "error");
            return;
        }

        // TODO: Good lord this is hacky
        // TODO: Find a good way to conditionally send a glasses bt device name to SGC
        if (!deviceName.isEmpty() && modelName.contains("Even Realities"))
            savePreferredG1DeviceId(this, deviceName);

        executeOnceSmartGlassesManagerReady(this, () -> {
            smartGlassesManager.connectToSmartGlasses(device);
            sendStatusToAugmentOsManager();
        });
    }

    @Override
    public void disconnectWearable(String wearableId) {
        Log.d("AugmentOsService", "Disconnecting from wearable: " + wearableId);
        // Instead of stopping the service, reset the state
        if (smartGlassesManager != null) {
            smartGlassesManager.resetState();
        }
        sendStatusToAugmentOsManager();
    }

    @Override
    public void forgetSmartGlasses() {
        Log.d("AugmentOsService", "Forgetting wearable");
        SmartGlassesManager.savePreferredWearable(this, "");
        deleteEvenSharedPreferences(this);
        brightnessLevel = null;
        batteryLevel = null;
        
        // Reset instead of stopping
        if (smartGlassesManager != null) {
            smartGlassesManager.resetState();
        }
        
        sendStatusToAugmentOsManager();
    }

    // TODO: Can remove this?
    @Override
    public void startApp(String packageName) {
        Log.d("AugmentOsService", "Starting app: " + packageName);
        // Logic to start the app by package name

        ServerComms.getInstance().startApp(packageName);
        if (smartGlassesManager == null || smartGlassesManager.getConnectedSmartGlasses() == null) {
        //    blePeripheral.sendNotifyManager("Connect glasses to use your app", "success");
        }
    }

    // TODO: Can remove this?
    @Override
    public void stopApp(String packageName) {
        Log.d("AugmentOsService", "Stopping app: " + packageName);
        ServerComms.getInstance().stopApp(packageName);
    }

    @Override
    public void setForceCoreOnboardMic(boolean toForceCoreOnboardMic) {
        SmartGlassesManager.saveForceCoreOnboardMic(this, toForceCoreOnboardMic);
        if(smartGlassesManager != null && smartGlassesManager.getConnectedSmartGlasses() != null) {
            blePeripheral.sendNotifyManager(this.getResources().getString(R.string.SETTING_WILL_APPLY_ON_NEXT_GLASSES_CONNECTION), "success");
        }
        sendStatusToBackend();
    }

    @Override
    public void setSensingEnabled(boolean sensingEnabled) {
        SmartGlassesManager.saveSensingEnabled(this, sensingEnabled);
        if(smartGlassesManager != null && smartGlassesManager.getConnectedSmartGlasses() != null) {
            blePeripheral.sendNotifyManager(this.getResources().getString(R.string.SETTING_WILL_APPLY_ON_NEXT_GLASSES_CONNECTION), "success");
        }
        sendStatusToBackend();
    }

    @Override
    public void setBypassVadForDebugging(boolean bypassVadForDebugging) {
        SmartGlassesManager.saveBypassVadForDebugging(this, bypassVadForDebugging);
        sendStatusToBackend();
    }

    @Override
    public void setBypassAudioEncodingForDebugging(boolean bypassAudioEncodingForDebugging) {
        SmartGlassesManager.saveBypassAudioEncodingForDebugging(this, bypassAudioEncodingForDebugging);
        sendStatusToBackend();
    }

    @Override
    public void setContextualDashboardEnabled(boolean contextualDashboardEnabled) {
        saveContextualDashboardEnabled(contextualDashboardEnabled);
        this.contextualDashboardEnabled = contextualDashboardEnabled;
    }

    @Override
    public void setAlwaysOnStatusBarEnabled(boolean alwaysOnStatusBarEnabled) {
        // if (alwaysOnStatusBarEnabled) {
        //     smartGlassesManager.windowManager.showAppLayer(
        //             "serverappid",
        //             () -> smartGlassesManager.sendTextWall(cachedDashboardTopLine),
        //             0
        //     );
        // }
        // else {
        //     EventBus.getDefault().post(new HomeScreenEvent());
        // }

        // saveAlwaysOnStatusBarEnabled(alwaysOnStatusBarEnabled);
        // this.alwaysOnStatusBarEnabled = alwaysOnStatusBarEnabled;
    }

    public boolean getContextualDashboardEnabled() {
        return this.getSharedPreferences("AugmentOSPrefs", Context.MODE_PRIVATE).getBoolean("contextual_dashboard_enabled", true);
    }

    public void saveContextualDashboardEnabled(boolean enabled) {
        SharedPreferences sharedPreferences = this.getSharedPreferences("AugmentOSPrefs", Context.MODE_PRIVATE);
        SharedPreferences.Editor editor = sharedPreferences.edit();
        editor.putBoolean("contextual_dashboard_enabled", enabled);
        editor.apply();
    }

    public boolean getAlwaysOnStatusBarEnabled() {
        return this.getSharedPreferences("AugmentOSPrefs", Context.MODE_PRIVATE)
                .getBoolean("always_on_status_bar_enabled", false); // Default to false if not set
    }

    public void saveAlwaysOnStatusBarEnabled(boolean enabled) {
        SharedPreferences sharedPreferences = this.getSharedPreferences("AugmentOSPrefs", Context.MODE_PRIVATE);
        SharedPreferences.Editor editor = sharedPreferences.edit();
        editor.putBoolean("always_on_status_bar_enabled", enabled);
        editor.apply();
    }

    // TODO: Can remove this?
    @Override
    public void installAppFromRepository(String repository, String packageName) throws JSONException {
        Log.d("AugmentOsService", "Installing app from repository: " + packageName);
        blePeripheral.sendNotifyManager("Not implemented", "error");
    }

    // TODO: Can remove this?
    @Override
    public void uninstallApp(String uninstallPackageName) {
        Log.d(TAG, "uninstallApp not implemented");
        blePeripheral.sendNotifyManager("Not implemented", "error");
    }

    @Override
    public void requestAppInfo(String packageNameToGetDetails) {
        ThirdPartyEdgeApp tpa = edgeTpaSystem.getThirdPartyAppByPackageName(packageNameToGetDetails);
        if (tpa == null) {
            blePeripheral.sendNotifyManager("Could not find app", "error");
            sendStatusToAugmentOsManager();
            return;
        }
        JSONArray settings = tpa.getSettings(this);
        if (settings == null) {
            blePeripheral.sendNotifyManager("Could not get app's details", "error");
            return;
        }
        blePeripheral.sendAppInfoToManager(tpa);
    }

    @Override
    public void handleNotificationData(JSONObject notificationData){
        try {
            if (notificationData != null) {
                String appName = notificationData.optString("app_name");
                String title = notificationData.getString("title");
                String text = notificationData.getString("text");
//                long timestamp = notificationData.getLong("timestamp");
                String uuid = java.util.UUID.randomUUID().toString();

                ServerComms.getInstance().sendPhoneNotification(uuid, appName, title, text, "high");

                //EventBus.getDefault().post(new NotificationEvent(title, text, appName, timestamp, uuid));
            } else {
                System.out.println("Notification Data is null");
            }
        } catch (JSONException e) {
            Log.d(TAG, "JSONException occurred while handling notification data: " + e.getMessage());
        }
    }

    @Override
    public void updateGlassesBrightness(int brightness) {
        Log.d("AugmentOsService", "Updating glasses brightness: " + brightness);
        if (smartGlassesManager != null) {
            String title = "Brightness Adjustment";
            String body = "Updating glasses brightness to " + brightness + "%.";
            smartGlassesManager.windowManager.showAppLayer("system", () -> smartGlassesManager.sendReferenceCard(title, body), 6);
            smartGlassesManager.updateGlassesBrightness(brightness);
        } else {
            blePeripheral.sendNotifyManager("Connect glasses to update brightness", "error");
        }
    }

    @Override
    public void updateGlassesAutoBrightness(boolean autoBrightness) {
        Log.d("AugmentOsService", "Updating glasses auto brightness: " + autoBrightness);
        if (smartGlassesManager != null) {
            smartGlassesManager.updateGlassesAutoBrightness(autoBrightness);
        }
    }

    @Override
    public void updateGlassesHeadUpAngle(int headUpAngle) {
        Log.d("AugmentOsService", "Updating glasses head up angle: " + headUpAngle);
        if (smartGlassesManager != null) {
            smartGlassesManager.updateGlassesHeadUpAngle(headUpAngle);
        } else {
            blePeripheral.sendNotifyManager("Connect glasses to update head up angle", "error");
        }
    }

    @Override
    public void setAuthSecretKey(String uniqueUserId, String authSecretKey) {
        Log.d("AugmentOsService", "Setting auth secret key: " + authSecretKey);
        if (authHandler.getCoreToken() == null ||!authHandler.getCoreToken().equals(authSecretKey)) {
            authHandler.setAuthSecretKey(authSecretKey);
            ServerComms.getInstance().disconnectWebSocket();
            ServerComms.getInstance().connectWebSocket(authHandler.getCoreToken());
        }
        authHandler.verifyAuthSecretKey(uniqueUserId);
        sendStatusToAugmentOsManager();
    }

    @Override
    public void verifyAuthSecretKey() {
        Log.d("AugmentOsService", "verify auth secret key");
    }

    @Override
    public void deleteAuthSecretKey() {
        Log.d("AugmentOsService", "Deleting auth secret key");
        authHandler.deleteAuthSecretKey();
        
        // When auth key is deleted (sign out), reset state for the next user
        if (smartGlassesManager != null) {
            smartGlassesManager.resetState();
        }
        
        // Stop all running apps
        if (edgeTpaSystem != null) {
            edgeTpaSystem.stopAllThirdPartyApps();
        }
        
        // Reset cached app data
        cachedThirdPartyAppList = new ArrayList<>();
        cachedDashboardDisplayObject = null;
        // When auth key is deleted (sign out), reset state for the next user
        if (smartGlassesManager != null) {
           smartGlassesManager.resetState();
        }

        // Stop all running apps
        if (edgeTpaSystem != null) {
            edgeTpaSystem.stopAllThirdPartyApps();
        }

        // Reset cached app data
        cachedThirdPartyAppList = new ArrayList<>();
        cachedDashboardDisplayObject = null;

        // Disconnect from server
        ServerComms.getInstance().disconnectWebSocket();
        webSocketLifecycleManager.updateSmartGlassesState(SmartGlassesConnectionState.DISCONNECTED);
        
        sendStatusToAugmentOsManager();
    }

    @Override
    public void updateAppSettings(String targetApp, JSONObject settings) {
        Log.d("AugmentOsService", "Updating settings for app: " + targetApp);
        ThirdPartyEdgeApp tpa = edgeTpaSystem.getThirdPartyAppByPackageName(targetApp);
        if (tpa == null) {
            blePeripheral.sendNotifyManager("Could not find app", "error");
            return;
        }

        boolean allSuccess = true;
        try {
            // New loop over all keys in the settings object
            Iterator<String> keys = settings.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                Object value = settings.get(key);
                if(!tpa.updateSetting(this, key, value)) {
                    allSuccess = false;
                }
            }
        } catch (JSONException e) {
            Log.e("AugmentOsService", "Failed to parse settings object", e);
            allSuccess = false;
        }

        if (!allSuccess) {
            blePeripheral.sendNotifyManager("Error updating settings", "error");
        }
    }

    /**
     * Helper method to clean up all resources, disconnect from devices, 
     * and reset the service state completely
     */
    private void cleanupAllResources() {
        Log.d(TAG, "Cleaning up all resources and connections");
        
        // Stop all running apps
        if(edgeTpaSystem != null) {
            edgeTpaSystem.stopAllThirdPartyApps();
        }
        
        // Stop location updates and cleanup
        if(locationSystem != null) {
            // BATTERY OPTIMIZATION: Use cleanup method instead of just stopping updates
            locationSystem.cleanup();
        }
        
        // Clean up screen capture resources
        if(screenCaptureRunnable != null) {
            screenCaptureHandler.removeCallbacks(screenCaptureRunnable);
        }
        if (virtualDisplay != null) {
            virtualDisplay.release();
            virtualDisplay = null;
        }
        if (mediaProjection != null) {
            mediaProjection.stop();
            mediaProjection = null;
        }
        
        // BATTERY OPTIMIZATION: Clean up our animation handler
        if (animationRunnable != null) {
            uiHandler.removeCallbacks(animationRunnable);
            animationRunnable = null;
        }
        // Remove all pending posts to avoid any UI updates after destruction
        uiHandler.removeCallbacksAndMessages(null);
        
        // Reset glasses connection
        if (smartGlassesManager != null) {
            smartGlassesManager.resetState();
            smartGlassesManager.cleanup();
            smartGlassesManager = null;
            edgeTpaSystem.setSmartGlassesManager(null);
        }
        
        // Reset cached data
        cachedThirdPartyAppList = new ArrayList<>();
        cachedDashboardDisplayObject = null;
        
        // Disconnect websockets
        if (webSocketLifecycleManager != null) {
            webSocketLifecycleManager.updateSmartGlassesState(SmartGlassesConnectionState.DISCONNECTED);
            webSocketLifecycleManager.cleanup();
        }
        ServerComms.getInstance().disconnectWebSocket();
        
        // Clear BLE connections
        if (blePeripheral != null) {
            blePeripheral.destroy();
        }
        
        if(edgeTpaSystem != null) {
            edgeTpaSystem.destroy();
        }
    }

    @Override
    public void onDestroy(){
        Log.d(TAG, "Service being destroyed");
        
        // BATTERY OPTIMIZATION: Cleanup resources first, then unregister from EventBus
        // This prevents unhandled EventBus events during cleanup
        cleanupAllResources();
        
        // Unregister from EventBus with proper error handling
        try {
            if (EventBus.getDefault().isRegistered(this)) {
                EventBus.getDefault().unregister(this);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error unregistering from EventBus", e);
        }
        
        super.onDestroy();
    }


    public class LocalBinder extends Binder {
        public AugmentosService getService() {
            // Return this instance of LocalService so clients can call public methods
            return AugmentosService.this;
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        super.onBind(intent);
        Log.d(TAG, "Something bound");
        return binder;
    }
}