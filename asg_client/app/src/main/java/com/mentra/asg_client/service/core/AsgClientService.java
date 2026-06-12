package com.mentra.asg_client.service.core;

import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.MediaRecorder;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;
import android.util.Size;

import com.dev.api.DevApi;
import com.mentra.asg_client.SysControl;
import com.mentra.asg_client.io.bluetooth.interfaces.BluetoothStateListener;
import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.io.media.interfaces.ServiceCallbackInterface;
import com.mentra.asg_client.io.media.managers.MediaUploadQueueManager;
import com.mentra.asg_client.io.network.interfaces.NetworkStateListener;
import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import com.mentra.asg_client.io.ota.utils.OtaConstants;
import com.mentra.asg_client.io.streaming.events.StreamingEvent;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.core.processors.CommandProcessor;
import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;
import com.mentra.asg_client.service.system.interfaces.IServiceLifecycle;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.service.media.interfaces.IMediaManager;
// Note: AugmentosService removed - legacy dependency no longer needed
// import com.augmentos.augmentos_core.AugmentosService;
import com.mentra.asg_client.service.utils.ServiceUtils;
import com.mentra.asg_client.service.utils.SysProp;

import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.Subscribe;
import org.greenrobot.eventbus.ThreadMode;
import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.Objects;

/**
 * Fully refactored AsgClientService that follows SOLID principles.
 * <p>
 * This service demonstrates:
 * - Single Responsibility Principle: Each manager handles one concern
 * - Open/Closed Principle: Easy to extend with new managers
 * - Liskov Substitution Principle: All managers implement interfaces
 * - Interface Segregation Principle: Focused interfaces for each concern
 * - Dependency Inversion Principle: Depends on abstractions, not concretions
 */
public class AsgClientService extends Service implements NetworkStateListener, BluetoothStateListener {

    // ---------------------------------------------
    // Constants //TODO: Extract all the Constants and Magic Number/Text to AsgConstants
    // ---------------------------------------------
    public static final String TAG = "AsgClientServiceV2";

    // Service actions
    public static final String ACTION_START_CORE = "ACTION_START_CORE";
    public static final String ACTION_STOP_CORE = "ACTION_STOP_CORE";
    public static final String ACTION_START_FOREGROUND_SERVICE = "MY_ACTION_START_FOREGROUND_SERVICE";
    public static final String ACTION_STOP_FOREGROUND_SERVICE = "MY_ACTION_STOP_FOREGROUND_SERVICE";
    public static final String ACTION_RESTART_SERVICE = "com.mentra.asg_client.ACTION_RESTART_SERVICE";
    public static final String ACTION_RESTART_COMPLETE = "com.mentra.asg_client.ACTION_RESTART_COMPLETE";
    public static final String ACTION_RESTART_CAMERA = "com.mentra.asg_client.ACTION_RESTART_CAMERA";
    public static final String ACTION_I2S_AUDIO_STATE = "com.mentra.asg_client.ACTION_I2S_AUDIO_STATE";
    public static final String EXTRA_I2S_AUDIO_PLAYING = "extra_i2s_audio_playing";
    public static final String ACTION_START_OTA_UPDATER = "ACTION_START_OTA_UPDATER";

    // OTA Update progress actions
    public static final String ACTION_DOWNLOAD_PROGRESS = "com.augmentos.otaupdater.ACTION_DOWNLOAD_PROGRESS";
    public static final String ACTION_INSTALLATION_PROGRESS = "com.augmentos.otaupdater.ACTION_INSTALLATION_PROGRESS";
    public static final String ACTION_OTA_HEARTBEAT = "com.augmentos.otaupdater.ACTION_HEARTBEAT";

    // Service health monitoring
    private static final String ACTION_HEARTBEAT = "com.mentra.asg_client.ACTION_HEARTBEAT";
    private static final String ACTION_HEARTBEAT_ACK = "com.mentra.asg_client.ACTION_HEARTBEAT_ACK";
    private static final long HEARTBEAT_TIMEOUT_MS = 35000; // 35 seconds timeout

    // ---------------------------------------------
    // Dependency Injection Container
    // ---------------------------------------------
    private ServiceContainer serviceContainer;

    // Interface references (Dependency Inversion Principle)
    private IServiceLifecycle lifecycleManager;
    private ICommunicationManager communicationManager;
    private IConfigurationManager configurationManager;
    private IStateManager stateManager;
    private IMediaManager streamingManager;

    private CommandProcessor commandProcessor;

    // ---------------------------------------------
    // Service State
    // ---------------------------------------------
    private static AsgClientService instance;
    private boolean lastI2sPlaying = false;
    private boolean isConnected = false; // Track connection state based on heartbeat

    // ---------------------------------------------
    // WiFi State Management
    // ---------------------------------------------
    private static final long WIFI_STATE_DEBOUNCE_MS = 1000;
    private Handler wifiDebounceHandler;
    private Runnable wifiDebounceRunnable;
    private boolean lastWifiState = false;
    private boolean pendingWifiState = false;

    // ---------------------------------------------
    // Broadcast Receivers
    // ---------------------------------------------
    private BroadcastReceiver heartbeatReceiver;
    private BroadcastReceiver restartReceiver;
    private BroadcastReceiver otaProgressReceiver;
    private BroadcastReceiver mtkUpdateReceiver;

    // ---------------------------------------------
    // Heartbeat Timeout Management
    // ---------------------------------------------
    private Handler heartbeatTimeoutHandler;
    private Runnable heartbeatTimeoutRunnable;

    // ---------------------------------------------
    // Lifecycle Methods
    // ---------------------------------------------
    @Override
    public void onCreate() {
        super.onCreate();
        Log.i(TAG, "🚀 AsgClientServiceV2 onCreate() started");
        Log.d(TAG, "📊 Android API Level: " + Build.VERSION.SDK_INT);

        instance = this;

        try {
            // Register for EventBus events
            Log.d(TAG, "📡 Registering for EventBus events");
            EventBus.getDefault().register(this);
            Log.d(TAG, "✅ EventBus registration successful");

            // EIS is toggled on/off at point of use:
            // - Enabled before video recording (CameraNeoService)
            // - Disabled before streaming (StreamCommandHandler)
            SysControl.setEisEnable(this, false);

            // Initialize dependency injection container
            Log.d(TAG, "🔧 Initializing service container");
            initializeServiceContainer();

            // Apply saved camera FOV on start (K900) so last user choice survives reboot
            applySavedCameraFovOnStart();

            // Initialize WiFi debouncing
            Log.d(TAG, "📶 Initializing WiFi debouncing");
            initializeWifiDebouncing();

            // Enable 5 GHz WiFi scanning after a short delay so system UI / WiFi stack is ready
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                Log.d(TAG, "📶 Enabling 5 GHz Hotspot scan via SysControl");
                SysControl.setHotspot5G(this, true);
            }, 3000);

            // Register receivers
            Log.d(TAG, "📻 Registering broadcast receivers");
            registerReceivers();

            // Send version info
            Log.d(TAG, "📋 Sending initial version information");
            sendVersionInfo();

            // Start heartbeat monitoring
            Log.d(TAG, "💓 Starting heartbeat monitoring");
            startHeartbeatMonitoring();

            // Clean up orphaned BLE transfer files from previous sessions
            Log.d(TAG, "🗑️ Cleaning up orphaned BLE transfer files");
            cleanupOrphanedBleTransfers();

            // Log all available video resolutions
            Log.d(TAG, "📹 Querying available video resolutions");
            logAvailableVideoResolutions();

            Log.i(TAG, "✅ AsgClientServiceV2 onCreate() completed successfully");
        } catch (Exception e) {
            Log.e(TAG, "💥 Error in onCreate()", e);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.d(TAG, "🎯 onStartCommand() called - StartId: " + startId + ", Flags: " + flags);

        super.onStartCommand(intent, flags, startId);

        try {
            // Ensure foreground service on API 26+
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Log.d(TAG, "📱 API 26+ detected - setting up foreground service");
                serviceContainer.getNotificationManager().createNotificationChannel();
                startForeground(serviceContainer.getNotificationManager().getDefaultNotificationId(),
                        serviceContainer.getNotificationManager().createForegroundNotification());
                Log.d(TAG, "✅ Foreground service started");
            } else {
                Log.d(TAG, "📱 API < 26 - skipping foreground service setup");
            }

            if (intent == null || intent.getAction() == null) {
                Log.w(TAG, "⚠️ Received null intent or null action");
                return START_STICKY;
            }

            String action = intent.getAction();
            Log.i(TAG, "🎯 Processing action: " + action);

            if (ACTION_I2S_AUDIO_STATE.equals(action)) {
                boolean playing = intent.getBooleanExtra(EXTRA_I2S_AUDIO_PLAYING, false);
                handleI2SAudioState(playing);
                return START_STICKY;
            }

            // Delegate action handling to lifecycle manager
            lifecycleManager.handleAction(action, intent.getExtras());
            Log.d(TAG, "✅ Action processed successfully");

        } catch (Exception e) {
            Log.e(TAG, "💥 Error in onStartCommand()", e);
        }

        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        Log.i(TAG, "🛑 AsgClientServiceV2 onDestroy() started");

        try {
            // Unregister from EventBus
            if (EventBus.getDefault().isRegistered(this)) {
                Log.d(TAG, "📡 Unregistering from EventBus");
                EventBus.getDefault().unregister(this);
                Log.d(TAG, "✅ EventBus unregistration successful");
            } else {
                Log.d(TAG, "⏭️ Not registered with EventBus - skipping unregistration");
            }

            // Clean up service container
            if (serviceContainer != null) {
                Log.d(TAG, "🧹 Cleaning up service container");
                serviceContainer.cleanup();
                Log.d(TAG, "✅ Service container cleanup completed");
            } else {
                Log.d(TAG, "⏭️ Service container is null - skipping cleanup");
            }

            // Unregister receivers
            Log.d(TAG, "📻 Unregistering broadcast receivers");
            unregisterReceivers();

            // Clean up WiFi debouncing
            if (wifiDebounceHandler != null && wifiDebounceRunnable != null) {
                Log.d(TAG, "📶 Cleaning up WiFi debouncing");
                wifiDebounceHandler.removeCallbacks(wifiDebounceRunnable);
                Log.d(TAG, "✅ WiFi debouncing cleanup completed");
            }

            // Stop any active stream
            Log.d(TAG, "📹 Stopping active stream");
            streamingManager.stopStreaming();
            Log.d(TAG, "✅ Stream stopped");

            // Release RGB LED control authority back to BES
            Log.d(TAG, "🚨 Releasing RGB LED control authority back to BES");
            sendRgbLedControlAuthority(false);

            // Disable touch/swipe event reporting on service destroy
            Log.d(TAG, "🎯 Disabling touch event reporting on service destroy");
            handleTouchEventControl(true);

            Log.d(TAG, "🎯 Disabling swipe volume control on service destroy");
            handleSwipeVolumeControl(true);

            Log.i(TAG, "✅ AsgClientServiceV2 onDestroy() completed successfully");
        } catch (Exception e) {
            Log.e(TAG, "💥 Error in onDestroy()", e);
        }

        instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        Log.d(TAG, "🔗 onBind() called");
        return new LocalBinder();
    }

    public static AsgClientService getInstance() {
        return instance;
    }

    public void handleI2SAudioState(boolean playing) {
        Log.i(TAG, "I2S audio state request: " + (playing ? "start" : "stop"));

        if (playing == lastI2sPlaying) {
            Log.d(TAG, "I2S state unchanged, skipping command");
            return;
        }

        final String command = playing ? "mh_starti2s" : "mh_stopi2s";

        try {
            JSONObject payload = new JSONObject();
            payload.put("C", command);
            payload.put("V", 1);
            payload.put("B", new JSONObject());

            boolean sent = sendK900Command(payload.toString());
            if (sent) {
                lastI2sPlaying = playing;
            }
            Log.i(TAG, "I2S command sent (" + payload.toString() + ") result=" + sent);
        } catch (JSONException e) {
            Log.e(TAG, "Failed to construct I2S command payload", e);
        }
    }

    // ---------------------------------------------
    // Touch/Swipe Event Commands
    // ---------------------------------------------

    /**
     * Enable or disable touch event reporting
     * @param enable true to enable touch events, false to disable
     */
    public void handleTouchEventControl(boolean enable) {
        Log.i(TAG, "Touch event control request: " + (enable ? "enable" : "disable"));

        try {
            JSONObject payload = new JSONObject();
            payload.put("C", "cs_swit");
            payload.put("V", 1);
            JSONObject bData = new JSONObject();
            bData.put("type", 26);
            bData.put("switch", enable);
            payload.put("B", bData.toString());

            boolean sent = sendK900Command(payload.toString());
            if (sent) {
                Log.i(TAG, "Touch event control command sent successfully");
            }
        } catch (JSONException e) {
            Log.e(TAG, "Failed to construct touch event control payload", e);
        }
    }

    /**
     * Enable or disable swipe volume control
     * @param enable true to enable swipe volume control, false to disable
     */
    public void handleSwipeVolumeControl(boolean enable) {
        Log.i(TAG, "Swipe volume control request: " + (enable ? "enable" : "disable"));

        try {
            JSONObject payload = new JSONObject();
            payload.put("C", "cs_fbvol");
            payload.put("V", 1);
            JSONObject bData = new JSONObject();
            bData.put("switch", enable);
            payload.put("B", bData.toString());

            boolean sent = sendK900Command(payload.toString());
            if (sent) {
                Log.i(TAG, "Swipe volume control command sent successfully");
            }
        } catch (JSONException e) {
            Log.e(TAG, "Failed to construct swipe volume control payload", e);
        }
    }

    private boolean sendK900Command(String payload) {
        if (serviceContainer == null || serviceContainer.getServiceManager() == null) {
            Log.w(TAG, "ServiceContainer not initialized; cannot send I2S command");
            return false;
        }

        var bluetoothManager = serviceContainer.getServiceManager().getBluetoothManager();
        if (bluetoothManager == null) {
            Log.w(TAG, "Bluetooth manager unavailable; cannot send I2S command");
            return false;
        }

        if (!bluetoothManager.isConnected()) {
            Log.w(TAG, "Bluetooth manager not connected; cannot send I2S command");
            return false;
        }

        boolean sent = bluetoothManager.sendData(payload.getBytes(StandardCharsets.UTF_8));
        Log.i(TAG, "I2S command sent (" + payload + ") result=" + sent);
        return sent;
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
            JSONObject authorityCommand = new JSONObject();
            authorityCommand.put("C", "android_control_led");
            authorityCommand.put("V", 1);

            JSONObject bField = new JSONObject();
            bField.put("on", claimControl);
            authorityCommand.put("B", bField.toString());

            String commandStr = authorityCommand.toString();
            Log.i(TAG, "🚨 Sending RGB LED authority command: " + commandStr);

            if (serviceContainer == null || serviceContainer.getServiceManager() == null) {
                Log.w(TAG, "⚠️ ServiceContainer not initialized; deferring RGB LED authority claim");
                return;
            }

            var bluetoothManager = serviceContainer.getServiceManager().getBluetoothManager();
            if (bluetoothManager == null) {
                Log.w(TAG, "⚠️ Bluetooth manager unavailable; cannot send RGB LED authority command");
                return;
            }

            if (!bluetoothManager.isConnected()) {
                Log.w(TAG, "⚠️ Bluetooth not connected; RGB LED authority will be sent when connected");
                return;
            }

            boolean sent = bluetoothManager.sendData(commandStr.getBytes(StandardCharsets.UTF_8));
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

    // ---------------------------------------------
    // Initialization Methods
    // ---------------------------------------------
    private void initializeServiceContainer() {
        Log.d(TAG, "🔧 initializeServiceContainer() started");

        try {
            serviceContainer = new ServiceContainer(this, this);
            Log.d(TAG, "✅ ServiceContainer created successfully");

            // Initialize container
            Log.d(TAG, "🚀 Initializing service container");
            serviceContainer.initialize();
            Log.d(TAG, "✅ Service container initialization completed");

            // Wait for 1 second
            Thread.sleep(1000);

            // Get interface references
            Log.d(TAG, "📋 Getting interface references from service container");
            lifecycleManager = serviceContainer.getLifecycleManager();
            communicationManager = serviceContainer.getCommunicationManager();
            configurationManager = serviceContainer.getConfigurationManager();
            stateManager = serviceContainer.getStateManager();
            streamingManager = serviceContainer.getStreamingManager();
            commandProcessor = serviceContainer.getCommandProcessor();

            Log.d(TAG, "✅ All interface references obtained");
            Log.d(TAG, "📊 Interface status - LifecycleManager: " + (lifecycleManager != null ? "valid" : "null") +
                    ", CommunicationManager: " + (communicationManager != null ? "valid" : "null") +
                    ", ConfigurationManager: " + (configurationManager != null ? "valid" : "null") +
                    ", StateManager: " + (stateManager != null ? "valid" : "null") +
                    ", StreamingManager: " + (streamingManager != null ? "valid" : "null") +
                    ", CommandProcessor: " + (commandProcessor != null ? "valid" : "null"));

            // ---------------------------------------------------------------
            // START BLE ADVERTISING
            // The iOS companion app scans for "INMO GO2" and connects as the
            // BLE central. Without this call the GATT server never becomes
            // visible and the iOS readiness-check loop runs forever.
            // ---------------------------------------------------------------
            Log.i(TAG, "📡 Starting BLE advertising for iOS companion connection");
            var btManager = serviceContainer.getServiceManager().getBluetoothManager();
            if (btManager != null) {
                btManager.startAdvertising();
                Log.i(TAG, "✅ BLE advertising started successfully");
            } else {
                Log.e(TAG, "❌ Bluetooth manager is null — cannot start advertising");
            }

        } catch (Exception e) {
            Log.e(TAG, "💥 Error initializing service container", e);
            try {
                throw e;
            } catch (InterruptedException ex) {
                throw new RuntimeException(ex);
            }
        }
    }

    /**
     * Initialize WiFi debouncing
     */
    private void initializeWifiDebouncing() {
        Log.d(TAG, "📶 initializeWifiDebouncing() started");

        try {
            wifiDebounceHandler = new Handler(Looper.getMainLooper());
            wifiDebounceRunnable = () -> {
                if (pendingWifiState != lastWifiState) {
                    Log.i(TAG, "🔄 WiFi debounce timeout - sending final state: " +
                            (pendingWifiState ? "CONNECTED" : "DISCONNECTED"));
                    lastWifiState = pendingWifiState;
                    communicationManager.sendWifiStatusOverBle(pendingWifiState);
                    Log.d(TAG, "✅ WiFi status sent over BLE");
                } else {
                    Log.d(TAG, "⏭️ WiFi state unchanged - no action needed");
                }
            };
            Log.d(TAG, "✅ WiFi debouncing initialized successfully");
        } catch (Exception e) {
            Log.e(TAG, "💥 Error initializing WiFi debouncing", e);
        }
    }

    /**
     * Apply saved camera FOV on service start (K900). Ensures last user-chosen FOV is applied after reboot.
     * No-op on non-K900 devices (UnsatisfiedLinkError from libxydev).
     */
    private void applySavedCameraFovOnStart() {
        try {
            if (serviceContainer == null || serviceContainer.getServiceManager() == null) {
                return;
            }
            var asgSettings = serviceContainer.getServiceManager().getAsgSettings();
            if (asgSettings == null) {
                return;
            }
            int fov = asgSettings.getCameraFov();
            int roiPosition = asgSettings.getCameraRoiPosition();
            try {
                DevApi.setCameraFov(fov, roiPosition);
                SysControl.restartCameraHal(this);
                CameraRestartCooldown.setCooldown();
                Log.d(TAG, "Applied saved camera FOV on start: fov=" + fov + ", roi_position=" + roiPosition);
            } catch (UnsatisfiedLinkError e) {
                Log.d(TAG, "libxydev not available (non-K900?), skipping apply saved FOV");
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not apply saved camera FOV on start", e);
        }
    }

    /**
     * Register all receivers
     */
    private void registerReceivers() {
        Log.d(TAG, "📻 registerReceivers() started");

        try {
            registerHeartbeatReceiver();
            registerRestartReceiver();
            registerOtaProgressReceiver();
            registerMtkUpdateReceiver();
            Log.d(TAG, "✅ All receivers registered successfully");
        } catch (Exception e) {
            Log.e(TAG, "💥 Error registering receivers", e);
        }
    }

    /**
     * Unregister all receivers
     */
    private void unregisterReceivers() {
        Log.d(TAG, "📻 unregisterReceivers() started");

        try {
            if (heartbeatReceiver != null) {
                unregisterReceiver(heartbeatReceiver);
                Log.d(TAG, "✅ Heartbeat receiver unregistered");
            }
            if (restartReceiver != null) {
                unregisterReceiver(restartReceiver);
                Log.d(TAG, "✅ Restart receiver unregistered");
            }
            if (otaProgressReceiver != null) {
                unregisterReceiver(otaProgressReceiver);
                Log.d(TAG, "✅ OTA progress receiver unregistered");
            }
            if (mtkUpdateReceiver != null) {
                unregisterReceiver(mtkUpdateReceiver);
                Log.d(TAG, "✅ MTK update receiver unregistered");
            }

            stopHeartbeatMonitoring();

            Log.d(TAG, "✅ All receivers unregistered successfully");
        } catch (IllegalArgumentException e) {
            Log.w(TAG, "⚠️ Receiver was not registered: " + e.getMessage());
        } catch (Exception e) {
            Log.e(TAG, "💥 Error unregistering receivers", e);
        }
    }

    // ---------------------------------------------
    // NetworkStateListener Implementation
    // ---------------------------------------------
    @Override
    public void onWifiStateChanged(boolean isConnected) {
        Log.i(TAG, "🔄 WiFi state changed: " + (isConnected ? "CONNECTED" : "DISCONNECTED"));
        Log.d(TAG, "📊 Previous state: " + (lastWifiState ? "CONNECTED" : "DISCONNECTED") +
                ", Pending state: " + (pendingWifiState ? "CONNECTED" : "DISCONNECTED"));

        pendingWifiState = isConnected;

        if (wifiDebounceHandler != null && wifiDebounceRunnable != null) {
            Log.d(TAG, "⏱️ Removing existing WiFi debounce callback");
            wifiDebounceHandler.removeCallbacks(wifiDebounceRunnable);
            Log.d(TAG, "⏱️ Scheduling new WiFi debounce callback in " + WIFI_STATE_DEBOUNCE_MS + "ms");
            wifiDebounceHandler.postDelayed(wifiDebounceRunnable, WIFI_STATE_DEBOUNCE_MS);
        } else {
            Log.w(TAG, "⚠️ WiFi debouncing not initialized - sending state immediately");
            communicationManager.sendWifiStatusOverBle(isConnected);
        }

        if (isConnected) {
            Log.d(TAG, "🌐 WiFi connected - triggering connected actions");
            onWifiConnected();
            processMediaQueue();
        } else {
            Log.d(TAG, "📶 WiFi disconnected - no additional actions needed");
        }
    }

    @Override
    public void onHotspotStateChanged(boolean isEnabled) {
        Log.i(TAG, "📡 Hotspot state changed: " + (isEnabled ? "ENABLED" : "DISABLED"));

        try {
            if (serviceContainer != null && serviceContainer.getServiceManager() != null) {
                var networkManager = serviceContainer.getServiceManager().getNetworkManager();
                var commManager = serviceContainer.getCommunicationManager();

                if (networkManager != null && commManager != null) {
                    JSONObject hotspotStatus = new JSONObject();
                    hotspotStatus.put("type", "hotspot_status_update");
                    hotspotStatus.put("hotspot_enabled", isEnabled);

                    if (isEnabled) {
                        hotspotStatus.put("hotspot_ssid", networkManager.getHotspotSsid());
                        hotspotStatus.put("hotspot_password", networkManager.getHotspotPassword());
                        hotspotStatus.put("hotspot_gateway_ip", networkManager.getHotspotGatewayIp());
                    }

                    Log.d(TAG, "📡 🔥 Sending hotspot status update: " + hotspotStatus.toString());
                    boolean sent = commManager.sendBluetoothResponse(hotspotStatus);
                    Log.d(TAG, "📡 🔥 " + (sent ? "✅ Hotspot status sent successfully" : "❌ Failed to send hotspot status"));
                } else {
                    Log.w(TAG, "📡 🔥 Cannot send hotspot status - managers not available");
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "📡 🔥 Error sending hotspot status update", e);
        }
    }

    @Override
    public void onWifiCredentialsReceived(String ssid, String password, String authToken) {
        Log.i(TAG, "🔑 WiFi credentials received for network: " + ssid);
    }

    @Override
    public void onHotspotError(String errorMessage) {
        Log.e(TAG, "📡 🔥 ❌ Hotspot error occurred: " + errorMessage);

        try {
            if (serviceContainer != null && serviceContainer.getServiceManager() != null) {
                var commManager = serviceContainer.getCommunicationManager();

                if (commManager != null) {
                    JSONObject hotspotError = new JSONObject();
                    hotspotError.put("type", "hotspot_error");
                    hotspotError.put("error_message", errorMessage);
                    hotspotError.put("timestamp", System.currentTimeMillis());

                    Log.d(TAG, "📡 🔥 Sending hotspot error: " + hotspotError.toString());
                    boolean sent = commManager.sendBluetoothResponse(hotspotError);
                    Log.d(TAG, "📡 🔥 " + (sent ? "✅ Hotspot error sent successfully" : "❌ Failed to send hotspot error"));
                } else {
                    Log.w(TAG, "📡 🔥 Cannot send hotspot error - communication manager not available");
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "📡 🔥 Error sending hotspot error message", e);
        }
    }

    // ---------------------------------------------
    // BluetoothStateListener Implementation
    // ---------------------------------------------
    @Override
    public void onConnectionStateChanged(boolean connected) {
        Log.i(TAG, "📶 Bluetooth connection state changed: " + (connected ? "CONNECTED" : "DISCONNECTED"));

        if (connected) {
            OtaHelper otaHelper = OtaHelper.getInstance();
            if (otaHelper != null) {
                otaHelper.onPhoneConnected();
            }

            Log.d(TAG, "⏱️ Scheduling WiFi status send in 3 seconds");
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                Log.d(TAG, "📤 Sending WiFi status after Bluetooth connection");
                if (stateManager.isConnectedToWifi()) {
                    communicationManager.sendWifiStatusOverBle(true);
                } else {
                    communicationManager.sendWifiStatusOverBle(false);
                }
            }, 3000);

            Log.d(TAG, "📋 Sending version information after Bluetooth connection");
            sendVersionInfo();

            Log.d(TAG, "🚨 Claiming RGB LED control authority on Bluetooth connection");
            sendRgbLedControlAuthority(true);

            Log.d(TAG, "🎯 Enabling touch event reporting on Bluetooth connection");
            handleTouchEventControl(true);

            Log.d(TAG, "🎯 Enabling swipe volume control on Bluetooth connection");
            handleSwipeVolumeControl(false);
        } else {
            Log.d(TAG, "📶 Bluetooth disconnected - no additional actions needed");
        }
    }

    @Override
    public void onDataReceived(byte[] data) {
        Log.d(TAG, "📥 Bluetooth onDataReceived() called");

        if (data == null || data.length == 0) {
            Log.w(TAG, "⚠️ Received empty data packet from Bluetooth");
            return;
        }

        Log.i(TAG, "📥 Received " + data.length + " bytes from Bluetooth");
        String incomingPayload = new String(data, StandardCharsets.UTF_8);
        Log.d(TAG, "📋 Data preview: " + incomingPayload.substring(0, Math.min(incomingPayload.length(), 100)) +
                (incomingPayload.length() > 100 ? "..." : ""));

        final CommandProcessor processor = commandProcessor;
        if (processor == null) {
            Log.w(TAG, "⚠️ CommandProcessor not yet initialized - dropping " + data.length
                    + " bytes (interface refs not yet obtained)");
            return;
        }
        try {
            processor.processCommand(data);
            Log.d(TAG, "✅ Data processing delegated successfully");
        } catch (Exception e) {
            Log.e(TAG, "💥 Error processing received data", e);
        }
    }

    // ---------------------------------------------
    // Helper Methods
    // ---------------------------------------------

    private void onWifiConnected() {
        Log.i(TAG, "🌐 Connected to WiFi network");
    }

    private void processMediaQueue() {
        Log.d(TAG, "📁 processMediaQueue() called");

        if (serviceContainer.getServiceManager().getMediaQueueManager() != null) {
            if (!serviceContainer.getServiceManager().getMediaQueueManager().isQueueEmpty()) {
                Log.i(TAG, "📁 WiFi connected - processing media upload queue");
                serviceContainer.getServiceManager().getMediaQueueManager().processQueue();
                Log.d(TAG, "✅ Media queue processing initiated");
            } else {
                Log.d(TAG, "📁 Media queue is empty - no processing needed");
            }
        } else {
            Log.w(TAG, "⚠️ Media queue manager is null - cannot process queue");
        }
    }

    /**
     * Send version information to phone in two chunks to work around BLE MTU limitations.
     */
    public void sendVersionInfo() {
        Log.i(TAG, "📊 Sending version information (chunked for MTU)");

        try {
            String appVersion = "1.0.0";
            String buildNumber = "1";

            try {
                appVersion = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
                buildNumber = String.valueOf(getPackageManager().getPackageInfo(getPackageName(), 0).versionCode);
                Log.d(TAG, "✅ Retrieved app version: " + appVersion + ", Build number: " + buildNumber);
            } catch (Exception e) {
                Log.e(TAG, "💥 Error getting app version - using defaults", e);
            }

            String deviceModel = ServiceUtils.getDeviceTypeString(this);
            String androidVersion = android.os.Build.VERSION.RELEASE;
            String otaVersionUrl = OtaConstants.VERSION_JSON_URL;

            String besFirmwareVersion = "";
            if (serviceContainer.getServiceManager() != null &&
                    serviceContainer.getServiceManager().getAsgSettings() != null) {
                besFirmwareVersion = serviceContainer.getServiceManager().getAsgSettings().getBesFirmwareVersion();
            }

            String mtkFirmwareVersion = SysControl.getSystemCurrentVersion(this);
            String besBtMac = SysProp.getBesBtMac(this);

            Log.d(TAG, "📋 Version info prepared - Device: " + deviceModel +
                    ", Android: " + androidVersion +
                    ", BES Firmware: " + besFirmwareVersion +
                    ", MTK Firmware: " + mtkFirmwareVersion +
                    ", BT MAC: " + besBtMac +
                    ", OTA URL: " + otaVersionUrl);

            if (serviceContainer.getServiceManager().getBluetoothManager() != null &&
                    serviceContainer.getServiceManager().getBluetoothManager().isConnected()) {

                JSONObject chunk1 = new JSONObject();
                chunk1.put("type", "version_info_1");
                chunk1.put("app_version", appVersion);
                chunk1.put("build_number", buildNumber);
                chunk1.put("device_model", deviceModel);
                chunk1.put("android_version", androidVersion);
                chunk1.put("system_time_ms", System.currentTimeMillis());

                Log.d(TAG, "📤 Sending version_info_1: " + chunk1.toString());
                serviceContainer.getServiceManager().getBluetoothManager().sendData(chunk1.toString().getBytes(StandardCharsets.UTF_8));

                try { Thread.sleep(100); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }

                JSONObject chunk2 = new JSONObject();
                chunk2.put("type", "version_info_2");
                chunk2.put("ota_version_url", otaVersionUrl);

                Log.d(TAG, "📤 Sending version_info_2: " + chunk2.toString());
                serviceContainer.getServiceManager().getBluetoothManager().sendData(chunk2.toString().getBytes(StandardCharsets.UTF_8));

                try { Thread.sleep(100); } catch (InterruptedException e) { Thread.currentThread().interrupt(); }

                JSONObject chunk3 = new JSONObject();
                chunk3.put("type", "version_info_3");
                chunk3.put("bes_fw_version", besFirmwareVersion);
                chunk3.put("mtk_fw_version", mtkFirmwareVersion);
                chunk3.put("bt_mac_address", besBtMac);

                Log.d(TAG, "📤 Sending version_info_3: " + chunk3.toString());
                serviceContainer.getServiceManager().getBluetoothManager().sendData(chunk3.toString().getBytes(StandardCharsets.UTF_8));

                Log.i(TAG, "✅ Sent version info chunks to phone successfully");
            } else {
                Log.w(TAG, "⚠️ Bluetooth manager not available or not connected - cannot send version info");
            }
        } catch (JSONException e) {
            Log.e(TAG, "💥 Error creating version info JSON", e);
        } catch (Exception e) {
            Log.e(TAG, "💥 Error sending version info", e);
        }
    }

    // ---------------------------------------------
    // Public API Methods
    // ---------------------------------------------

    public MediaCaptureService.MediaCaptureListener getMediaCaptureListener() {
        Log.d(TAG, "📸 Creating media capture listener");

        return new MediaCaptureService.MediaCaptureListener() {
            @Override
            public void onPhotoCapturing(String requestId) {
                Log.i(TAG, "📸 Photo capturing started - ID: " + requestId);
            }

            @Override
            public void onPhotoCaptured(String requestId, String filePath) {
                Log.i(TAG, "✅ Photo captured successfully - ID: " + requestId + ", Path: " + filePath);
            }

            @Override
            public void onPhotoUploading(String requestId) {
                Log.i(TAG, "📤 Photo uploading started - ID: " + requestId);
            }

            @Override
            public void onPhotoUploaded(String requestId, String url) {
                Log.i(TAG, "✅ Photo uploaded successfully - ID: " + requestId + ", URL: " + url);
            }

            @Override
            public void onVideoRecordingStarted(String requestId, String filePath) {
                Log.i(TAG, "🎥 Video recording started - ID: " + requestId + ", Path: " + filePath);
            }

            @Override
            public void onVideoRecordingStopped(String requestId, String filePath) {
                Log.i(TAG, "⏹️ Video recording stopped - ID: " + requestId + ", Path: " + filePath);
            }

            @Override
            public void onVideoUploading(String requestId) {
                Log.i(TAG, "📤 Video uploading started - ID: " + requestId);
            }

            @Override
            public void onVideoUploaded(String requestId, String url) {
                Log.i(TAG, "✅ Video uploaded successfully - ID: " + requestId + ", URL: " + url);
            }

            @Override
            public void onMediaError(String requestId, String error, int mediaType) {
                String mediaTypeName = mediaType == MediaUploadQueueManager.MEDIA_TYPE_PHOTO ? "Photo" : "Video";
                Log.e(TAG, "❌ " + mediaTypeName + " error - ID: " + requestId + ", Error: " + error);
            }
        };
    }

    public CommandProcessor getCommandProcessor() {
        return commandProcessor;
    }

    public ServiceCallbackInterface getServiceCallback() {
        Log.d(TAG, "📡 Creating service callback interface");

        return new ServiceCallbackInterface() {
            @Override
            public void sendThroughBluetooth(byte[] data) {
                if (serviceContainer.getServiceManager().getBluetoothManager() != null) {
                    serviceContainer.getServiceManager().getBluetoothManager().sendData(data);
                } else {
                    Log.w(TAG, "⚠️ Bluetooth manager is null - cannot send data");
                }
            }

            @Override
            public boolean sendFileViaBluetooth(String filePath) {
                if (serviceContainer.getServiceManager().getBluetoothManager() != null) {
                    boolean started = serviceContainer.getServiceManager().getBluetoothManager().sendImageFile(filePath);
                    if (started) {
                        Log.i(TAG, "✅ BLE file transfer started successfully for: " + filePath);
                    } else {
                        Log.e(TAG, "❌ Failed to start BLE file transfer for: " + filePath);
                    }
                    return started;
                } else {
                    Log.w(TAG, "⚠️ Bluetooth manager is null - cannot send file");
                    return false;
                }
            }

            @Override
            public boolean isBleTransferInProgress() {
                if (serviceContainer.getServiceManager().getBluetoothManager() != null) {
                    return serviceContainer.getServiceManager().getBluetoothManager().isFileTransferInProgress();
                } else {
                    Log.w(TAG, "⚠️ Bluetooth manager is null - cannot check transfer status");
                    return false;
                }
            }
        };
    }

    // ---------------------------------------------
    // Broadcast Receiver Registration Methods
    // ---------------------------------------------
    private void registerHeartbeatReceiver() {
        Log.d(TAG, "💓 registerHeartbeatReceiver() started");

        try {
            heartbeatReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    String action = intent.getAction();
                    Log.d(TAG, "💓 Heartbeat receiver triggered - Action: " + action);

                    if (ACTION_HEARTBEAT.equals(action) ||
                            "com.augmentos.otaupdater.ACTION_HEARTBEAT".equals(action)) {

                        Log.i(TAG, "💓 Heartbeat received - sending acknowledgment");

                        try {
                            Intent ackIntent = new Intent(ACTION_HEARTBEAT_ACK);
                            ackIntent.setPackage("com.augmentos.otaupdater");
                            sendBroadcast(ackIntent);
                            Log.i(TAG, "✅ Heartbeat acknowledgment sent successfully");
                        } catch (Exception e) {
                            Log.e(TAG, "💥 Error sending heartbeat acknowledgment", e);
                        }
                    }
                }
            };

            IntentFilter heartbeatFilter = new IntentFilter();
            heartbeatFilter.addAction(ACTION_HEARTBEAT);
            heartbeatFilter.addAction(ACTION_OTA_HEARTBEAT);
            registerReceiver(heartbeatReceiver, heartbeatFilter);
            Log.d(TAG, "✅ Heartbeat receiver registered successfully");
        } catch (Exception e) {
            Log.e(TAG, "💥 Error registering heartbeat receiver", e);
        }
    }

    private void resetHeartbeatTimeout() {
        Log.d(TAG, "💓 Resetting heartbeat timeout");

        try {
            heartbeatTimeoutHandler.removeCallbacks(heartbeatTimeoutRunnable);
            isConnected = true;
            heartbeatTimeoutHandler.postDelayed(heartbeatTimeoutRunnable, HEARTBEAT_TIMEOUT_MS);
        } catch (Exception e) {
            Log.e(TAG, "💥 Error resetting heartbeat timeout", e);
        }
    }

    public void startHeartbeatMonitoring() {
        Log.d(TAG, "💓 Starting heartbeat monitoring");

        try {
            if (heartbeatTimeoutHandler == null) {
                Log.d(TAG, "💓 Initializing heartbeat timeout handler");
                heartbeatTimeoutHandler = new Handler(Looper.getMainLooper());
                heartbeatTimeoutRunnable = () -> {
                    Log.w(TAG, "⚠️ Heartbeat timeout - marking as disconnected");
                    isConnected = false;
                    Log.i(TAG, "🔌 Connection state changed to DISCONNECTED due to heartbeat timeout");
                };
            }

            heartbeatTimeoutHandler.removeCallbacks(heartbeatTimeoutRunnable);
            isConnected = false;
            Log.d(TAG, "🔌 Connection state initialized as DISCONNECTED - waiting for first heartbeat");
            heartbeatTimeoutHandler.postDelayed(heartbeatTimeoutRunnable, HEARTBEAT_TIMEOUT_MS);
            Log.d(TAG, "⏰ Initial heartbeat timeout scheduled for " + HEARTBEAT_TIMEOUT_MS + "ms");

        } catch (Exception e) {
            Log.e(TAG, "💥 Error starting heartbeat monitoring", e);
        }
    }

    public void stopHeartbeatMonitoring() {
        Log.d(TAG, "💓 Stopping heartbeat monitoring");

        try {
            heartbeatTimeoutHandler.removeCallbacks(heartbeatTimeoutRunnable);
            isConnected = false;
        } catch (Exception e) {
            Log.e(TAG, "💥 Error stopping heartbeat monitoring", e);
        }
    }

    public boolean isConnected() {
        return isConnected;
    }

    public void onPhoneReadyHandshakeComplete() {
        Log.d(TAG, "📱 Phone ready handshake complete - marking phone connection active");
        resetHeartbeatTimeout();
    }

    public void onServiceHeartbeatReceived() {
        Log.d(TAG, "💓 Service heartbeat received from MentraLiveSGC");
        resetHeartbeatTimeout();
    }

    private void registerRestartReceiver() {
        Log.d(TAG, "🔄 registerRestartReceiver() started");

        try {
            restartReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    String action = intent.getAction();
                    if (ACTION_RESTART_SERVICE.equals(action)) {
                        Log.i(TAG, "🔄 Received restart request from OTA updater");
                    }
                }
            };

            IntentFilter restartFilter = new IntentFilter(ACTION_RESTART_SERVICE);
            registerReceiver(restartReceiver, restartFilter);
            Log.d(TAG, "✅ Restart receiver registered successfully");
        } catch (Exception e) {
            Log.e(TAG, "💥 Error registering restart receiver", e);
        }
    }

    private void registerOtaProgressReceiver() {
        Log.d(TAG, "📥 registerOtaProgressReceiver() started");

        try {
            otaProgressReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    String action = intent.getAction();
                    switch (Objects.requireNonNull(action)) {
                        case ACTION_DOWNLOAD_PROGRESS:
                            handleDownloadProgress(intent);
                            break;
                        case ACTION_INSTALLATION_PROGRESS:
                            handleInstallationProgress(intent);
                            break;
                        default:
                            Log.d(TAG, "⏭️ Unknown OTA action: " + action);
                            break;
                    }
                }
            };

            IntentFilter otaFilter = new IntentFilter();
            otaFilter.addAction(ACTION_DOWNLOAD_PROGRESS);
            otaFilter.addAction(ACTION_INSTALLATION_PROGRESS);
            registerReceiver(otaProgressReceiver, otaFilter);
            Log.d(TAG, "✅ OTA progress receiver registered successfully");
        } catch (Exception e) {
            Log.e(TAG, "💥 Error registering OTA progress receiver", e);
        }
    }

    private void handleDownloadProgress(Intent intent) {
        try {
            String status = intent.getStringExtra("status");
            int progress = intent.getIntExtra("progress", 0);
            long bytesDownloaded = intent.getLongExtra("bytes_downloaded", 0);
            long totalBytes = intent.getLongExtra("total_bytes", 0);
            String errorMessage = intent.getStringExtra("error_message");
            long timestamp = intent.getLongExtra("timestamp", System.currentTimeMillis());

            Log.i(TAG, "📥 Download progress: " + status + " - " + progress + "%");

            if (commandProcessor != null) {
                commandProcessor.sendDownloadProgressOverBle(status, progress, bytesDownloaded, totalBytes, errorMessage, timestamp);
            }
        } catch (Exception e) {
            Log.e(TAG, "💥 Error handling download progress", e);
        }
    }

    private void handleInstallationProgress(Intent intent) {
        try {
            String status = intent.getStringExtra("status");
            String apkPath = intent.getStringExtra("apk_path");
            String errorMessage = intent.getStringExtra("error_message");
            long timestamp = intent.getLongExtra("timestamp", System.currentTimeMillis());

            Log.i(TAG, "🔧 Installation progress: " + status);

            if (commandProcessor != null) {
                commandProcessor.sendInstallationProgressOverBle(status, apkPath, errorMessage, timestamp);
            }
        } catch (Exception e) {
            Log.e(TAG, "💥 Error handling installation progress", e);
        }
    }

    private void registerMtkUpdateReceiver() {
        Log.d(TAG, "🔄 registerMtkUpdateReceiver() started");

        try {
            mtkUpdateReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    if ("com.mentra.asg_client.MTK_UPDATE_COMPLETE".equals(intent.getAction())) {
                        Log.i(TAG, "🔄 Received MTK update complete broadcast");
                        sendMtkUpdateCompleteOverBle();
                    }
                }
            };

            IntentFilter filter = new IntentFilter("com.mentra.asg_client.MTK_UPDATE_COMPLETE");
            registerReceiver(mtkUpdateReceiver, filter);
            Log.d(TAG, "✅ MTK update receiver registered successfully");
        } catch (Exception e) {
            Log.e(TAG, "💥 Error registering MTK update receiver", e);
        }
    }

    private void sendMtkUpdateCompleteOverBle() {
        try {
            if (commandProcessor != null) {
                commandProcessor.sendMtkUpdateComplete();
            }
        } catch (Exception e) {
            Log.e(TAG, "💥 Error sending MTK update complete", e);
        }
    }

    // ---------------------------------------------
    // EventBus Subscriptions
    // ---------------------------------------------
    @Subscribe(threadMode = ThreadMode.MAIN)
    public void onStreamingEvent(StreamingEvent event) {
        Log.d(TAG, "📹 Streaming event received: " + event.getClass().getSimpleName());

        if (event instanceof StreamingEvent.Started) {
            Log.i(TAG, "✅ RTMP streaming started successfully");
        } else if (event instanceof StreamingEvent.Stopped) {
            Log.i(TAG, "⏹️ RTMP streaming stopped");
        } else if (event instanceof StreamingEvent.Error) {
            Log.e(TAG, "❌ RTMP streaming error: " + ((StreamingEvent.Error) event).getMessage());
        }
    }

    // ---------------------------------------------
    // Binder Class
    // ---------------------------------------------
    public class LocalBinder extends Binder {
        public AsgClientService getService() {
            Log.d(TAG, "🔗 LocalBinder.getService() called");
            return AsgClientService.this;
        }
    }

    // ---------------------------------------------
    // Utility Methods
    // ---------------------------------------------
    public static void openWifi(Context context, boolean bEnable) {
        try {
            if (bEnable) {
                SysControl.injectAdbCommand(context, "svc wifi enable");
            } else {
                SysControl.injectAdbCommand(context, "svc wifi disable");
            }
        } catch (Exception e) {
            Log.e(TAG, "💥 Error executing WiFi command", e);
        }
    }

    private void logAvailableVideoResolutions() {
        Log.i(TAG, "📹 ========================================");
        Log.i(TAG, "📹 AVAILABLE VIDEO RESOLUTIONS");
        Log.i(TAG, "📹 ========================================");

        try {
            CameraManager cameraManager = (CameraManager) getSystemService(Context.CAMERA_SERVICE);
            if (cameraManager == null) {
                Log.w(TAG, "📹 Camera manager not available");
                return;
            }

            String[] cameraIds = cameraManager.getCameraIdList();
            if (cameraIds == null || cameraIds.length == 0) {
                Log.w(TAG, "📹 No cameras found");
                return;
            }

            for (String cameraId : cameraIds) {
                try {
                    CameraCharacteristics characteristics = cameraManager.getCameraCharacteristics(cameraId);
                    StreamConfigurationMap map = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);

                    if (map == null) {
                        Log.w(TAG, "📹 Camera " + cameraId + ": No stream configuration map");
                        continue;
                    }

                    Size[] videoSizes = map.getOutputSizes(MediaRecorder.class);
                    if (videoSizes == null || videoSizes.length == 0) {
                        Log.w(TAG, "📹 Camera " + cameraId + ": No video sizes available");
                        continue;
                    }

                    Log.i(TAG, "📹 Camera " + cameraId + " supports " + videoSizes.length + " video resolutions:");
                    for (Size size : videoSizes) {
                        Log.i(TAG, "📹   - " + size.getWidth() + "x" + size.getHeight());
                    }
                } catch (CameraAccessException e) {
                    Log.e(TAG, "📹 Error accessing camera " + cameraId, e);
                }
            }

            Log.i(TAG, "📹 ========================================");
        } catch (Exception e) {
            Log.e(TAG, "📹 Error querying video resolutions", e);
        }
    }

    private void cleanupOrphanedBleTransfers() {
        try {
            java.io.File appFilesDir = getExternalFilesDir("");
            if (appFilesDir == null || !appFilesDir.exists()) {
                Log.d(TAG, "🗑️ App files directory does not exist, skipping cleanup");
                return;
            }

            Log.d(TAG, "🗑️ Checking for orphaned BLE transfer files in: " + appFilesDir.getAbsolutePath());

            java.io.File[] packageDirs = appFilesDir.listFiles(java.io.File::isDirectory);
            if (packageDirs == null) {
                Log.d(TAG, "🗑️ No package directories found");
                return;
            }

            int totalCleaned = 0;
            long totalSpaceFreed = 0;

            for (java.io.File packageDir : packageDirs) {
                java.io.File[] files = packageDir.listFiles((dir, name) ->
                        name.startsWith("ble_") && !name.contains(".")
                );

                if (files != null && files.length > 0) {
                    Log.d(TAG, "🗑️ Found " + files.length + " orphaned BLE files in " + packageDir.getName());

                    for (java.io.File file : files) {
                        long fileSize = file.length();
                        String fileName = file.getName();
                        long ageMinutes = (System.currentTimeMillis() - file.lastModified()) / 1000 / 60;

                        if (file.delete()) {
                            totalCleaned++;
                            totalSpaceFreed += fileSize;
                            Log.d(TAG, "🗑️ Deleted orphaned BLE transfer: " + fileName +
                                    " (age: " + ageMinutes + " minutes, size: " + (fileSize / 1024) + " KB)");
                        } else {
                            Log.w(TAG, "🗑️ Failed to delete orphaned file: " + fileName);
                        }
                    }
                }
            }

            if (totalCleaned > 0) {
                Log.i(TAG, "🗑️ Cleanup complete: Deleted " + totalCleaned + " orphaned BLE files, freed " +
                        (totalSpaceFreed / 1024) + " KB");
            } else {
                Log.d(TAG, "🗑️ No orphaned BLE transfer files found");
            }

        } catch (Exception e) {
            Log.e(TAG, "🗑️ Error cleaning up orphaned BLE transfers", e);
        }
    }
}