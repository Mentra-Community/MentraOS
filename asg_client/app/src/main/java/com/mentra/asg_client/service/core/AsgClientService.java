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

import com.mentra.asg_client.SysControl;
import com.mentra.asg_client.io.bluetooth.interfaces.BluetoothStateListener;
import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.io.media.interfaces.ServiceCallbackInterface;
import com.mentra.asg_client.io.media.managers.MediaUploadQueueManager;
import com.mentra.asg_client.io.network.interfaces.NetworkStateListener;
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
    // Note: AugmentosService removed - legacy dependency no longer needed
    // private AugmentosService augmentosService = null;
    // private boolean isAugmentosBound = false;
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
    // ServiceConnection for AugmentosService - DISABLED (legacy code)
    // ---------------------------------------------
    // Note: AugmentosService binding removed - no longer needed for standalone ASG client
    /*
    private final ServiceConnection augmentosConnection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            Log.i(TAG, "🔗 AugmentosService connected successfully");
            Log.d(TAG, "📋 Component name: " + name.getClassName());
            
            try {
                AugmentosService.LocalBinder binder = (AugmentosService.LocalBinder) service;
                augmentosService = binder.getService();
                isAugmentosBound = true;
                Log.d(TAG, "✅ AugmentosService bound and ready");

                // Update state manager
                if (stateManager instanceof StateManager) {
                    Log.d(TAG, "📊 Updating state manager with AugmentosService binding");
                    ((StateManager) stateManager).setAugmentosServiceBound(true);
                }

                // Check WiFi connectivity
                if (stateManager.isConnectedToWifi()) {
                    Log.d(TAG, "🌐 WiFi is connected - triggering onWifiConnected");
                    onWifiConnected();
                } else {
                    Log.d(TAG, "📶 WiFi is not connected - skipping onWifiConnected");
                }
            } catch (Exception e) {
                Log.e(TAG, "💥 Error in AugmentosService connection", e);
            }
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            Log.w(TAG, "🔌 AugmentosService disconnected");
            Log.d(TAG, "📋 Component name: " + name.getClassName());
            
            isAugmentosBound = false;
            augmentosService = null;

            // Update state manager
            if (stateManager instanceof StateManager) {
                Log.d(TAG, "📊 Updating state manager with AugmentosService unbinding");
                ((StateManager) stateManager).setAugmentosServiceBound(false);
            }
        }
    };
    */

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

            // Initialize dependency injection container
            Log.d(TAG, "🔧 Initializing service container");
            initializeServiceContainer();

            // Initialize WiFi debouncing
            Log.d(TAG, "📶 Initializing WiFi debouncing");
            initializeWifiDebouncing();

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

            // Note: AugmentosService unbinding removed - no longer used
            /*
            // Unbind from AugmentosService
            if (isAugmentosBound) {
                Log.d(TAG, "🔌 Unbinding from AugmentosService");
                unbindService(augmentosConnection);
                isAugmentosBound = false;
                Log.d(TAG, "✅ AugmentosService unbound");
            } else {
                Log.d(TAG, "⏭️ Not bound to AugmentosService - skipping unbind");
            }
            */

            // Clean up WiFi debouncing
            if (wifiDebounceHandler != null && wifiDebounceRunnable != null) {
                Log.d(TAG, "📶 Cleaning up WiFi debouncing");
                wifiDebounceHandler.removeCallbacks(wifiDebounceRunnable);
                Log.d(TAG, "✅ WiFi debouncing cleanup completed");
            }

            // Stop RTMP streaming
            Log.d(TAG, "📹 Stopping RTMP streaming");
            streamingManager.stopRtmpStreaming();
            Log.d(TAG, "✅ RTMP streaming stopped");

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
            serviceContainer = new ServiceContainer(this, this );
            Log.d(TAG, "✅ ServiceContainer created successfully");

            // Initialize container
            Log.d(TAG, "🚀 Initializing service container");
            serviceContainer.initialize();
            Log.d(TAG, "✅ Service container initialization completed");

            //Wait for 1 second
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
                Log.d(TAG, "💓 Unregistering heartbeat receiver");
                unregisterReceiver(heartbeatReceiver);
                Log.d(TAG, "✅ Heartbeat receiver unregistered");
            } else {
                Log.d(TAG, "⏭️ Heartbeat receiver is null - skipping");
            }
            
            if (restartReceiver != null) {
                Log.d(TAG, "🔄 Unregistering restart receiver");
                unregisterReceiver(restartReceiver);
                Log.d(TAG, "✅ Restart receiver unregistered");
            } else {
                Log.d(TAG, "⏭️ Restart receiver is null - skipping");
            }
            
            if (otaProgressReceiver != null) {
                Log.d(TAG, "📥 Unregistering OTA progress receiver");
                unregisterReceiver(otaProgressReceiver);
                Log.d(TAG, "✅ OTA progress receiver unregistered");
            } else {
                Log.d(TAG, "⏭️ OTA progress receiver is null - skipping");
            }
            
            if (mtkUpdateReceiver != null) {
                Log.d(TAG, "🔄 Unregistering MTK update receiver");
                unregisterReceiver(mtkUpdateReceiver);
                Log.d(TAG, "✅ MTK update receiver unregistered");
            } else {
                Log.d(TAG, "⏭️ MTK update receiver is null - skipping");
            }
            
            // Stop heartbeat monitoring
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
        
        // Send hotspot status update to phone
        try {
            if (serviceContainer != null && serviceContainer.getServiceManager() != null) {
                var networkManager = serviceContainer.getServiceManager().getNetworkManager();
                var commManager = serviceContainer.getCommunicationManager();
                
                if (networkManager != null && commManager != null) {
                    // Build hotspot status JSON
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
        Log.d(TAG, "📋 Credentials - SSID: " + ssid +
                  ", Password: " + (password != null ? "***" : "null") +
                  ", AuthToken: " + (authToken != null ? "***" : "null"));
    }

    @Override
    public void onHotspotError(String errorMessage) {
        Log.e(TAG, "📡 🔥 ❌ Hotspot error occurred: " + errorMessage);

        // Send hotspot error to phone
        try {
            if (serviceContainer != null && serviceContainer.getServiceManager() != null) {
                var commManager = serviceContainer.getCommunicationManager();

                if (commManager != null) {
                    // Build hotspot error JSON
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
            Log.d(TAG, "⏱️ Scheduling WiFi status send in 3 seconds");
            // Send WiFi status after delay
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                Log.d(TAG, "📤 Sending WiFi status after Bluetooth connection");
                if (stateManager.isConnectedToWifi()) {
                    Log.d(TAG, "🌐 WiFi is connected - sending status");
                    communicationManager.sendWifiStatusOverBle(true);
                } else {
                    Log.d(TAG, "📶 WiFi is not connected - sending status");
                    communicationManager.sendWifiStatusOverBle(false);
                }
            }, 3000);

            Log.d(TAG, "📋 Sending version information after Bluetooth connection");
            sendVersionInfo();
            
            // Claim RGB LED control authority when Bluetooth connects
            Log.d(TAG, "🚨 Claiming RGB LED control authority on Bluetooth connection");
            sendRgbLedControlAuthority(true);
            
            // Enable touch/swipe event reporting when Bluetooth connects
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
        Log.d(TAG, "📋 Data preview: " + new String(data, 0, Math.min(data.length, 100)) + 
                  (data.length > 100 ? "..." : ""));

        try {
            // Delegate JSON parsing and processing to CommandProcessor
            Log.d(TAG, "🔄 Delegating data processing to CommandProcessor");
            commandProcessor.processCommand(data);
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
        
        // Note: AugmentosService check removed - no longer used
        /*
        if (isAugmentosBound && augmentosService != null) {
            Log.i(TAG, "🔗 AugmentOS service is available, connecting to backend...");
        } else {
            Log.d(TAG, "⏭️ AugmentOS service not available - waiting for binding");
        }
        */
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

    public void sendVersionInfo() {
        Log.i(TAG, "📊 Sending version information");

        try {
            JSONObject versionInfo = new JSONObject();
            versionInfo.put("type", "version_info");
            
            String appVersion = "1.0.0";
            String buildNumber = "1";
            Log.d(TAG, "📋 Default app version: " + appVersion + ", Build number: " + buildNumber);

            try {
                appVersion = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
                buildNumber = String.valueOf(getPackageManager().getPackageInfo(getPackageName(), 0).versionCode);
                Log.d(TAG, "✅ Retrieved app version: " + appVersion + ", Build number: " + buildNumber);
            } catch (Exception e) {
                Log.e(TAG, "💥 Error getting app version - using defaults", e);
            }
            
            versionInfo.put("app_version", appVersion);
            versionInfo.put("build_number", buildNumber);
            versionInfo.put("device_model", ServiceUtils.getDeviceTypeString(this));
            versionInfo.put("android_version", android.os.Build.VERSION.RELEASE);
            versionInfo.put("ota_version_url", OtaConstants.VERSION_JSON_URL);

            Log.d(TAG, "📋 Version info prepared - Device: " + ServiceUtils.getDeviceTypeString(this) + 
                      ", Android: " + android.os.Build.VERSION.RELEASE + 
                      ", OTA URL: " + OtaConstants.VERSION_JSON_URL);

            if (serviceContainer.getServiceManager().getBluetoothManager() != null &&
                    serviceContainer.getServiceManager().getBluetoothManager().isConnected()) {
                Log.d(TAG, "📤 Sending version info via Bluetooth");
                serviceContainer.getServiceManager().getBluetoothManager().sendData(versionInfo.toString().getBytes(StandardCharsets.UTF_8));
                Log.i(TAG, "✅ Sent version info to phone successfully");
            } else {
                Log.w(TAG, "⚠️ Bluetooth manager not available or not connected - cannot send version info");
            }
        } catch (JSONException e) {
            Log.e(TAG, "💥 Error creating version info JSON", e);
        } catch (Exception e) {
            Log.e(TAG, "💥 Error sending version info", e);
        }
    }

    // REMOVED: saveCoreToken method - now handled directly by ConfigurationManager
    // AuthTokenCommandHandler calls configurationManager.saveCoreToken() directly

    // ---------------------------------------------
    // Public API Methods (Delegating to managers)
    // ---------------------------------------------
    // REMOVED: All delegation methods are now handled directly by managers
    // Components should access managers through the service container

    // ---------------------------------------------
    // Getters (Delegating to state manager)
    // ---------------------------------------------
    // REMOVED: All getter methods are now handled directly by managers
    // Components should access managers through the service container

    // ---------------------------------------------
    // Media Capture Listeners
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

    public ServiceCallbackInterface getServiceCallback() {
        Log.d(TAG, "📡 Creating service callback interface");
        
        return new ServiceCallbackInterface() {
            @Override
            public void sendThroughBluetooth(byte[] data) {
                Log.d(TAG, "📤 sendThroughBluetooth() called - Data length: " + (data != null ? data.length : "null"));
                
                if (serviceContainer.getServiceManager().getBluetoothManager() != null) {
                    Log.d(TAG, "📶 Sending data through Bluetooth");
                    serviceContainer.getServiceManager().getBluetoothManager().sendData(data);
                    Log.d(TAG, "✅ Data sent through Bluetooth successfully");
                } else {
                    Log.w(TAG, "⚠️ Bluetooth manager is null - cannot send data");
                }
            }

            @Override
            public boolean sendFileViaBluetooth(String filePath) {
                Log.d(TAG, "📁 sendFileViaBluetooth() called - File: " + filePath);
                
                if (serviceContainer.getServiceManager().getBluetoothManager() != null) {
                    Log.d(TAG, "📶 Starting BLE file transfer");
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
                Log.d(TAG, "📊 isBleTransferInProgress() called");
                
                if (serviceContainer.getServiceManager().getBluetoothManager() != null) {
                    boolean inProgress = serviceContainer.getServiceManager().getBluetoothManager().isFileTransferInProgress();
                    Log.d(TAG, "📊 BLE transfer in progress: " + inProgress);
                    return inProgress;
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
                    } else {
                        Log.d(TAG, "⏭️ Unknown action received: " + action);
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

    /**
     * Reset heartbeat timeout - called when heartbeat is received
     */
    private void resetHeartbeatTimeout() {
        Log.d(TAG, "💓 Resetting heartbeat timeout");
        
        try {
            // Cancel any existing timeout
            heartbeatTimeoutHandler.removeCallbacks(heartbeatTimeoutRunnable);
            
            // Mark as connected
            isConnected = true;
            Log.d(TAG, "🔌 Connection state changed to CONNECTED");
            
            // Schedule new timeout
            heartbeatTimeoutHandler.postDelayed(heartbeatTimeoutRunnable, HEARTBEAT_TIMEOUT_MS);
            Log.d(TAG, "⏰ Heartbeat timeout scheduled for " + HEARTBEAT_TIMEOUT_MS + "ms");
            
        } catch (Exception e) {
            Log.e(TAG, "💥 Error resetting heartbeat timeout", e);
        }
    }

    /**
     * Start heartbeat monitoring - call this when service becomes active
     */
    public void startHeartbeatMonitoring() {
        Log.d(TAG, "💓 Starting heartbeat monitoring");
        
        try {
            // Initialize heartbeat timeout handler if not already done
            if (heartbeatTimeoutHandler == null) {
                Log.d(TAG, "💓 Initializing heartbeat timeout handler");
                heartbeatTimeoutHandler = new Handler(Looper.getMainLooper());
                heartbeatTimeoutRunnable = () -> {
                    Log.w(TAG, "⚠️ Heartbeat timeout - marking as disconnected");
                    isConnected = false;
                    Log.i(TAG, "🔌 Connection state changed to DISCONNECTED due to heartbeat timeout");
                };
            }
            
            // Cancel any existing timeout
            heartbeatTimeoutHandler.removeCallbacks(heartbeatTimeoutRunnable);
            
            // Don't set connected state - wait for first heartbeat
            isConnected = false;
            Log.d(TAG, "🔌 Connection state initialized as DISCONNECTED - waiting for first heartbeat");
            
            // Schedule initial timeout to detect if no heartbeat comes
            heartbeatTimeoutHandler.postDelayed(heartbeatTimeoutRunnable, HEARTBEAT_TIMEOUT_MS);
            Log.d(TAG, "⏰ Initial heartbeat timeout scheduled for " + HEARTBEAT_TIMEOUT_MS + "ms");
            
        } catch (Exception e) {
            Log.e(TAG, "💥 Error starting heartbeat monitoring", e);
        }
    }

    /**
     * Stop heartbeat monitoring - call this when service becomes inactive
     */
    public void stopHeartbeatMonitoring() {
        Log.d(TAG, "💓 Stopping heartbeat monitoring");
        
        try {
            heartbeatTimeoutHandler.removeCallbacks(heartbeatTimeoutRunnable);
            isConnected = false;
            Log.d(TAG, "🔌 Connection state changed to DISCONNECTED (monitoring stopped)");
        } catch (Exception e) {
            Log.e(TAG, "💥 Error stopping heartbeat monitoring", e);
        }
    }

    /**
     * Get current connection state
     */
    public boolean isConnected() {
        return isConnected;
    }

    /**
     * Handle service heartbeat received from MentraLiveSGC
     */
    public void onServiceHeartbeatReceived() {
        Log.d(TAG, "💓 Service heartbeat received from MentraLiveSGC");
        
        // Reset heartbeat timeout and mark as connected
        resetHeartbeatTimeout();
    }

    private void registerRestartReceiver() {
        Log.d(TAG, "🔄 registerRestartReceiver() started");
        
        try {
            restartReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    String action = intent.getAction();
                    Log.d(TAG, "🔄 Restart receiver triggered - Action: " + action);
                    
                    if (ACTION_RESTART_SERVICE.equals(action)) {
                        Log.i(TAG, "🔄 Received restart request from OTA updater");
                    } else {
                        Log.d(TAG, "⏭️ Unknown action received: " + action);
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
                    Log.d(TAG, "📥 OTA progress receiver triggered - Action: " + action);

                    switch (Objects.requireNonNull(action)) {
                        case ACTION_DOWNLOAD_PROGRESS:
                            Log.d(TAG, "📥 Handling download progress");
                            handleDownloadProgress(intent);
                            break;
                        case ACTION_INSTALLATION_PROGRESS:
                            Log.d(TAG, "🔧 Handling installation progress");
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
        Log.d(TAG, "📥 handleDownloadProgress() started");
        
        try {
            String status = intent.getStringExtra("status");
            int progress = intent.getIntExtra("progress", 0);
            long bytesDownloaded = intent.getLongExtra("bytes_downloaded", 0);
            long totalBytes = intent.getLongExtra("total_bytes", 0);
            String errorMessage = intent.getStringExtra("error_message");
            long timestamp = intent.getLongExtra("timestamp", System.currentTimeMillis());

            Log.i(TAG, "📥 Download progress: " + status + " - " + progress + "% (" + 
                      bytesDownloaded + "/" + totalBytes + " bytes)");
            
            if (errorMessage != null) {
                Log.w(TAG, "⚠️ Download error: " + errorMessage);
            }

            if (commandProcessor != null) {
                Log.d(TAG, "📤 Sending download progress to command processor");
                commandProcessor.sendDownloadProgressOverBle(status, progress, bytesDownloaded, totalBytes, errorMessage, timestamp);
                Log.d(TAG, "✅ Download progress sent successfully");
            } else {
                Log.w(TAG, "⚠️ Command processor is null - cannot send download progress");
            }
        } catch (Exception e) {
            Log.e(TAG, "💥 Error handling download progress", e);
        }
    }

    private void handleInstallationProgress(Intent intent) {
        Log.d(TAG, "🔧 handleInstallationProgress() started");
        
        try {
            String status = intent.getStringExtra("status");
            String apkPath = intent.getStringExtra("apk_path");
            String errorMessage = intent.getStringExtra("error_message");
            long timestamp = intent.getLongExtra("timestamp", System.currentTimeMillis());

            Log.i(TAG, "🔧 Installation progress: " + status + " - " + apkPath);
            
            if (errorMessage != null) {
                Log.w(TAG, "⚠️ Installation error: " + errorMessage);
            }

            if (commandProcessor != null) {
                Log.d(TAG, "📤 Sending installation progress to command processor");
                commandProcessor.sendInstallationProgressOverBle(status, apkPath, errorMessage, timestamp);
                Log.d(TAG, "✅ Installation progress sent successfully");
            } else {
                Log.w(TAG, "⚠️ Command processor is null - cannot send installation progress");
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
        Log.d(TAG, "📤 sendMtkUpdateCompleteOverBle() started");
        try {
            if (commandProcessor != null) {
                Log.d(TAG, "📤 Sending MTK update complete to command processor");
                commandProcessor.sendMtkUpdateComplete();
                Log.d(TAG, "✅ MTK update complete sent successfully");
            } else {
                Log.w(TAG, "⚠️ Command processor is null - cannot send MTK update complete");
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
            Log.e(TAG, "❌ RTMP streaming error: " +
                    ((StreamingEvent.Error) event).getMessage());
        } else {
            Log.d(TAG, "📹 Unknown streaming event type: " + event.getClass().getSimpleName());
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
        Log.d(TAG, "🌐 openWifi() called - Enable: " + bEnable);

        try {
            if (bEnable) {
                Log.d(TAG, "📶 Enabling WiFi via ADB command");
                SysControl.injectAdbCommand(context, "svc wifi enable");
                Log.d(TAG, "✅ WiFi enable command executed");
            } else {
                Log.d(TAG, "📶 Disabling WiFi via ADB command");
                SysControl.injectAdbCommand(context, "svc wifi disable");
                Log.d(TAG, "✅ WiFi disable command executed");
            }
        } catch (Exception e) {
            Log.e(TAG, "💥 Error executing WiFi command", e);
        }
    }

    /**
     * Log all available video resolutions from the camera
     */
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

    /**
     * Clean up orphaned BLE transfer files from previous sessions.
     * These are compressed AVIF files stored in the app's external files directory
     * that were never successfully transferred and deleted.
     * This runs on boot, so any BLE temp files are by definition orphaned.
     */
    private void cleanupOrphanedBleTransfers() {
        try {
            // App's external files directory where compressed files are stored
            java.io.File appFilesDir = getExternalFilesDir("");
            if (appFilesDir == null || !appFilesDir.exists()) {
                Log.d(TAG, "🗑️ App files directory does not exist, skipping cleanup");
                return;
            }

            Log.d(TAG, "🗑️ Checking for orphaned BLE transfer files in: " + appFilesDir.getAbsolutePath());

            // Look for package directories
            java.io.File[] packageDirs = appFilesDir.listFiles(java.io.File::isDirectory);
            if (packageDirs == null) {
                Log.d(TAG, "🗑️ No package directories found");
                return;
            }

            int totalCleaned = 0;
            long totalSpaceFreed = 0;

            for (java.io.File packageDir : packageDirs) {
                // Look for BLE image files (no extension, just bleImgId pattern)
                java.io.File[] files = packageDir.listFiles((dir, name) ->
                    // BLE images have pattern like "ble_1234567890" (no extension)
                    name.startsWith("ble_") && !name.contains(".")
                );

                if (files != null && files.length > 0) {
                    Log.d(TAG, "🗑️ Found " + files.length + " orphaned BLE files in " + packageDir.getName());

                    // On boot, ALL BLE temp files are orphaned - no need for time check
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
                // Optional: Show notification about cleanup
//                if (serviceContainer != null && serviceContainer.getNotificationManager() != null) {
//                    serviceContainer.getNotificationManager().showDebugNotification("BLE Cleanup",
//                        "Cleaned " + totalCleaned + " orphaned transfers (" + (totalSpaceFreed / 1024) + " KB)");
//                }
            } else {
                Log.d(TAG, "🗑️ No orphaned BLE transfer files found");
            }

        } catch (Exception e) {
            Log.e(TAG, "🗑️ Error cleaning up orphaned BLE transfers", e);
        }
    }
} 