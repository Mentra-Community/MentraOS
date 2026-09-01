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
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.NetworkUtils;
import com.mentra.asg_client.camera.UvcStreamingState;
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.media.utils.MediaStorage;
import com.mentra.asg_client.io.bluetooth.interfaces.TransportListener;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.hardware.interfaces.RgbLedConstants;
import com.mentra.asg_client.io.media.core.MediaCaptureService;
import com.mentra.asg_client.io.media.interfaces.ServiceCallbackInterface;
import com.mentra.asg_client.io.media.managers.MediaUploadQueueManager;
import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import com.mentra.asg_client.io.network.interfaces.NetworkStateListener;
import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;
import com.mentra.asg_client.io.ota.utils.OtaConstants;
import com.mentra.asg_client.io.streaming.events.StreamingEvent;
import com.mentra.asg_client.logging.BleTraceLogger;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.core.processors.CommandProcessor;
import com.mentra.asg_client.service.core.processors.CommandProtocolDetector;
import com.mentra.asg_client.service.media.interfaces.IMediaManager;
import com.mentra.asg_client.service.system.core.SystemControllerFactory;
import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;
import com.mentra.asg_client.service.system.interfaces.IServiceLifecycle;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.service.system.managers.AsgNotificationManager;
import com.mentra.asg_client.service.utils.DeviceProfile;
import com.mentra.asg_client.service.utils.ProcessSessionId;
import com.mentra.asg_client.service.utils.ServiceUtils;
import com.mentra.asg_client.service.utils.SysProp;
import dagger.hilt.android.AndroidEntryPoint;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import javax.inject.Inject;
import javax.inject.Provider;
import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.Subscribe;
import org.greenrobot.eventbus.ThreadMode;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Fully refactored AsgClientService that follows SOLID principles.
 *
 * <p>This service demonstrates: - Single Responsibility Principle: Each manager handles one concern
 * - Open/Closed Principle: Easy to extend with new managers - Liskov Substitution Principle: All
 * managers implement interfaces - Interface Segregation Principle: Focused interfaces for each
 * concern - Dependency Inversion Principle: Depends on abstractions, not concretions
 */
@AndroidEntryPoint
public class AsgClientService extends Service implements NetworkStateListener, TransportListener {

    @Inject FileManager fileManager;
    @Inject OtaHelper otaHelper;
    @Inject IHardwareManager hardwareManager;
    @Inject IBesOtaRegistry besOtaRegistry;

    /** Vendor-supplied protocol detection strategies (e.g. the Mentra Live MCU wire format). */
    @Inject Set<CommandProtocolDetector.ProtocolDetectionStrategy> protocolStrategies;

    /**
     * Provider for the device-appropriate companion transport. Using {@link Provider} defers
     * construction until after {@link #ensureForegroundStarted()} so the K900 serial-port thread
     * does not open before the foreground notification is posted.
     */
    @Inject Provider<ICompanionTransport> companionTransportProvider;

    /**
     * Provider for the device-appropriate network manager, deferred for the same reason as
     * {@link #companionTransportProvider}.
     */
    @Inject Provider<INetworkManager> networkManagerProvider;

    // ---------------------------------------------
    // Constants //TODO: Extract all the Constants and Magic Number/Text to AsgConstants
    // ---------------------------------------------
    public static final String TAG = "AsgClientServiceV2";

    // Service actions
    public static final String ACTION_START_CORE = "ACTION_START_CORE";
    public static final String ACTION_STOP_CORE = "ACTION_STOP_CORE";
    public static final String ACTION_START_FOREGROUND_SERVICE =
            "MY_ACTION_START_FOREGROUND_SERVICE";
    public static final String ACTION_STOP_FOREGROUND_SERVICE = "MY_ACTION_STOP_FOREGROUND_SERVICE";
    public static final String ACTION_RESTART_SERVICE =
            "com.mentra.asg_client.ACTION_RESTART_SERVICE";
    public static final String ACTION_RESTART_COMPLETE =
            "com.mentra.asg_client.ACTION_RESTART_COMPLETE";
    public static final String ACTION_RESTART_CAMERA =
            "com.mentra.asg_client.ACTION_RESTART_CAMERA";
    public static final String ACTION_I2S_AUDIO_STATE =
            "com.mentra.asg_client.ACTION_I2S_AUDIO_STATE";
    public static final String EXTRA_I2S_AUDIO_PLAYING = "extra_i2s_audio_playing";
    public static final String ACTION_UVC_STREAMING_CHANGED =
            "com.mentra.asg_client.ACTION_UVC_STREAMING_CHANGED";
    public static final String EXTRA_UVC_STREAMING = "extra_uvc_streaming";
    public static final String ACTION_START_OTA_UPDATER = "ACTION_START_OTA_UPDATER";

    // OTA Update progress actions (legacy updater + recovery namespace during migration)
    public static final String LEGACY_ACTION_DOWNLOAD_PROGRESS =
            "com.augmentos.otaupdater.ACTION_DOWNLOAD_PROGRESS";
    public static final String LEGACY_ACTION_INSTALLATION_PROGRESS =
            "com.augmentos.otaupdater.ACTION_INSTALLATION_PROGRESS";
    public static final String ACTION_DOWNLOAD_PROGRESS =
            "com.mentra.recovery.ACTION_DOWNLOAD_PROGRESS";
    public static final String ACTION_INSTALLATION_PROGRESS =
            "com.mentra.recovery.ACTION_INSTALLATION_PROGRESS";
    public static final String ACTION_OTA_HEARTBEAT = "com.mentra.recovery.ACTION_PING";

    /** Solid white RGB LED duration while USB UVC streaming (same as video recording). */
    private static final int UVC_STREAMING_LED_DURATION_MS = 1_800_000;

    // ---------------------------------------------
    // Dependency Injection Container
    // ---------------------------------------------
    private ServiceInitializer serviceInitializer;

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
    private static final AtomicBoolean serviceRunning = new AtomicBoolean(false);
    private boolean lastI2sPlaying = false;
    private boolean lastUvcStreaming = false;

    /**
     * Used before {@link ServiceInitializer} exists so FGS promotion is not delayed by heavy init.
     */
    private AsgNotificationManager mEarlyNotificationManager;

    private boolean mForegroundStarted;

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
    // Lifecycle Methods
    // ---------------------------------------------
    @Override
    public void onCreate() {
        super.onCreate();
        Log.i(TAG, "🚀 AsgClientServiceV2 onCreate() started");
        Log.d(TAG, "📊 Android API Level: " + Build.VERSION.SDK_INT);
        BleTraceLogger.logLifecycle(this, "AsgClientService", "service_create");

        instance = this;
        serviceRunning.set(true);

        // Must run before heavy onCreate() work: startForegroundService() deadline (~5s) is
        // measured until startForeground(), and onStartCommand() only runs after onCreate().
        ensureForegroundStarted();

        try {
            // Register for EventBus events
            Log.d(TAG, "📡 Registering for EventBus events");
            EventBus.getDefault().register(this);
            Log.d(TAG, "✅ EventBus registration successful");

            // EIS is toggled on/off at point of use:
            // - Enabled before video recording (CameraNeoService)
            // - Disabled before streaming (StreamCommandHandler)
            SystemControllerFactory.get(this).setEisEnabled(false);

            // Initialize dependency injection container
            Log.d(TAG, "🔧 Initializing service container");
            initializeServiceInitializer();

            // Apply saved camera FOV on start (K900) so last user choice survives reboot
            applySavedCameraFovOnStart();

            // Apply saved camera tuning config (ANR/gain) so HAL tuning survives reboot.
            // If FOV restore triggered a HAL restart we must wait for the cooldown window to
            // expire before sending the camconfig broadcast; otherwise the HAL may not yet be
            // ready and the tuning settings will be silently dropped.
            if (CameraRestartCooldown.isActive()) {
                long delayMs = CameraRestartCooldown.DEFAULT_COOLDOWN_DURATION_MS + 500L;
                new Handler(Looper.getMainLooper())
                        .postDelayed(this::applySavedCameraTuningOnStart, delayMs);
            } else {
                applySavedCameraTuningOnStart();
            }

            // Initialize WiFi debouncing
            Log.d(TAG, "📶 Initializing WiFi debouncing");
            initializeWifiDebouncing();

            // Enable 5 GHz WiFi scanning after a short delay so system UI / WiFi stack is ready
            new Handler(Looper.getMainLooper())
                    .postDelayed(
                            () -> {
                                Log.d(TAG, "📶 Enabling 5 GHz Hotspot scan via SysControl");
                                SystemControllerFactory.get(this).setHotspot5GEnabled(true);
                            },
                            3000);

            // Apply persisted Wi-Fi ADB preference (default off for security — OS-1627)
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                try {
                    boolean wifiAdbEnabled = false;
                    if (serviceInitializer != null
                            && serviceInitializer.getServiceManager() != null
                            && serviceInitializer.getServiceManager().getAsgSettings() != null) {
                        wifiAdbEnabled =
                                serviceInitializer.getServiceManager().getAsgSettings().isWifiAdbEnabled();
                    }
                    Log.d(TAG, "🔧 Applying Wi-Fi ADB state on boot: " + wifiAdbEnabled);
                    SystemControllerFactory.get(this).setWifiAdb(wifiAdbEnabled);
                } catch (Exception e) {
                    Log.w(TAG, "Could not apply Wi-Fi ADB state on boot; forcing disabled", e);
                    SystemControllerFactory.get(this).setWifiAdb(false);
                }
            }, 3000);

            // Register receivers
            Log.d(TAG, "📻 Registering broadcast receivers");
            registerReceivers();

            // Send version info
            Log.d(TAG, "📋 Sending initial version information");
            sendVersionInfo();

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
            JSONObject lifecycleDetails = new JSONObject();
            lifecycleDetails.put("action", intent != null ? intent.getAction() : JSONObject.NULL);
            lifecycleDetails.put("flags", flags);
            lifecycleDetails.put("startId", startId);
            BleTraceLogger.logLifecycle(
                    this, "AsgClientService", "service_start_command", lifecycleDetails);

            ensureForegroundStarted();

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

            if (ACTION_UVC_STREAMING_CHANGED.equals(action)) {
                boolean streaming = intent.getBooleanExtra(EXTRA_UVC_STREAMING, false);
                handleUvcStreamingState(streaming);
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
        BleTraceLogger.logLifecycle(this, "AsgClientService", "service_destroy_start");

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
            if (serviceInitializer != null) {
                Log.d(TAG, "🧹 Cleaning up service container");
                serviceInitializer.cleanup();
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
            BleTraceLogger.logLifecycle(this, "AsgClientService", "service_destroy_complete");
        } catch (Exception e) {
            Log.e(TAG, "💥 Error in onDestroy()", e);
        }

        instance = null;
        serviceRunning.set(false);
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

    public static boolean isServiceRunning() {
        return serviceRunning.get();
    }

    /**
     * Handle MTK UVC streaming state forwarded from {@link
     * com.mentra.asg_client.receiver.UvcStreamingBroadcastReceiver}.
     */
    public void handleUvcStreamingState(boolean streaming) {
        if (streaming == lastUvcStreaming) {
            Log.d(TAG, "UVC streaming state unchanged (" + streaming + "), skipping LED update");
            return;
        }

        lastUvcStreaming = streaming;
        Log.i(TAG, "UVC streaming state: " + (streaming ? "active" : "inactive"));
        UvcStreamingState.setStreaming(streaming);
        applyUvcStreamingLed(streaming);
    }

    /**
     * Drive privacy indicators while USB UVC webcam mode is active — same pairing as video
     * recording: local MTK front-facing flash LED plus BES RGB ring (solid white).
     */
    private void applyUvcStreamingLed(boolean streaming) {
        IHardwareManager hardwareManager = getHardwareManagerForLed();
        if (hardwareManager == null) {
            Log.w(TAG, "Hardware manager not available; skipping UVC streaming LED update");
            return;
        }

        if (streaming) {
            if (hardwareManager.supportsRecordingLed()) {
                hardwareManager.setRecordingLedOn();
                Log.i(TAG, "UVC streaming front-facing recording flash LED on");
            } else {
                Log.w(TAG, "Recording flash LED not supported on this device");
            }

            if (hardwareManager.supportsRgbLed()) {
                sendRgbLedControlAuthority(true);
                hardwareManager.setRgbLedSolidWhite(
                        UVC_STREAMING_LED_DURATION_MS, RgbLedConstants.DEFAULT_BRIGHTNESS);
                Log.i(TAG, "UVC streaming RGB ring LED on (solid white)");
            } else {
                Log.w(TAG, "RGB LED not supported on this device");
            }
        } else {
            if (hardwareManager.supportsRecordingLed()) {
                hardwareManager.setRecordingLedOff();
                Log.i(TAG, "UVC streaming front-facing recording flash LED off");
            }
            if (hardwareManager.supportsRgbLed()) {
                hardwareManager.setRgbLedOff();
                Log.i(TAG, "UVC streaming RGB ring LED off");
            }
        }
    }

    private IHardwareManager getHardwareManagerForLed() {
        IHardwareManager ledHardwareManager = this.hardwareManager;
        if (ledHardwareManager == null) {
            return null;
        }
        if (serviceInitializer != null && serviceInitializer.getServiceManager() != null) {
            var transport = serviceInitializer.getServiceManager().getBluetoothManager();
            if (transport != null) {
                ledHardwareManager.setTransport(transport);
            }
        }
        return ledHardwareManager;
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

            JSONObject body = new JSONObject();
            Integer rateHz = null;
            if (playing) {
                // Tell BES the actual I2S PCM rate Android's audio HAL is about to output,
                // instead of relying on BES's hardcoded/default guess. A stale default here
                // previously caused boot/shutter tones to play at the wrong pitch/speed
                // (48kHz PCM played back at a 44.1kHz assumption).
                android.media.AudioManager audioManager =
                        (android.media.AudioManager) getSystemService(Context.AUDIO_SERVICE);
                if (audioManager == null) {
                    Log.w(TAG, "[I2S-RATE] AudioManager is null, sending empty body");
                } else {
                    String outputRate =
                            audioManager.getProperty(
                                    android.media.AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE);
                    Log.i(TAG, "[I2S-RATE] HAL PROPERTY_OUTPUT_SAMPLE_RATE=" + outputRate);
                    if (outputRate != null) {
                        try {
                            rateHz = Integer.parseInt(outputRate);
                            body.put("rate", rateHz);
                        } catch (NumberFormatException e) {
                            Log.w(TAG, "[I2S-RATE] Unexpected PROPERTY_OUTPUT_SAMPLE_RATE value: " + outputRate);
                        }
                    } else {
                        Log.w(TAG, "[I2S-RATE] HAL sample-rate property missing");
                    }
                }
            }
            // B must be a JSON *string* (not a nested object) - BES parses it via cJSON's
            // valuestring, which is only populated for string-typed values.
            String bodyStr = body.toString();
            payload.put("B", bodyStr);

            Log.i(
                    TAG,
                    "[I2S-RATE] cmd="
                            + command
                            + " rate="
                            + (rateHz != null ? rateHz : "none")
                            + " B_type=string B="
                            + bodyStr
                            + " payload="
                            + payload);

            boolean sent = sendK900Command(payload.toString());
            if (sent) {
                lastI2sPlaying = playing;
            }
            Log.i(
                    TAG,
                    "[I2S-RATE] uart_send result="
                            + sent
                            + " payload="
                            + payload
                            + " (look for B={\"rate\":...} as a string)");
        } catch (JSONException e) {
            Log.e(TAG, "Failed to construct I2S command payload", e);
        }
    }

    // ---------------------------------------------
    // Touch/Swipe Event Commands
    // ---------------------------------------------

    /**
     * Enable or disable touch event reporting
     *
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
     *
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
        if (serviceInitializer == null || serviceInitializer.getServiceManager() == null) {
            Log.w(TAG, "ServiceInitializer not initialized; cannot send I2S command");
            return false;
        }

        var bluetoothManager = serviceInitializer.getServiceManager().getBluetoothManager();
        if (bluetoothManager == null) {
            Log.w(TAG, "Bluetooth manager unavailable; cannot send I2S command");
            return false;
        }

        if (!bluetoothManager.isConnected()) {
            Log.w(TAG, "Bluetooth manager not connected; cannot send I2S command");
            return false;
        }

        boolean sent = bluetoothManager.sendMessage(payload.getBytes(StandardCharsets.UTF_8));
        Log.i(TAG, "I2S command sent (" + payload + ") result=" + sent);
        return sent;
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

            if (serviceInitializer == null || serviceInitializer.getServiceManager() == null) {
                Log.w(
                        TAG,
                        "⚠️ ServiceInitializer not initialized; deferring RGB LED authority claim");
                return;
            }

            var bluetoothManager = serviceInitializer.getServiceManager().getBluetoothManager();
            if (bluetoothManager == null) {
                Log.w(
                        TAG,
                        "⚠️ Bluetooth manager unavailable; cannot send RGB LED authority command");
                return;
            }

            if (!bluetoothManager.isConnected()) {
                Log.w(
                        TAG,
                        "⚠️ Bluetooth not connected; RGB LED authority will be sent when"
                                + " connected");
                return;
            }

            boolean sent =
                    bluetoothManager.sendMessage(commandStr.getBytes(StandardCharsets.UTF_8));
            if (sent) {
                Log.i(
                        TAG,
                        "✅ RGB LED control authority "
                                + (claimControl ? "CLAIMED" : "RELEASED")
                                + " successfully");
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
    /**
     * Promote to a foreground service. Idempotent; safe from {@link #onCreate()} and {@link
     * #onStartCommand()}. Not wrapped in onCreate's catch-all so AMS failures are visible.
     */
    private void ensureForegroundStarted() {
        if (mForegroundStarted || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }

        AsgNotificationManager notificationManager = resolveNotificationManager();
        notificationManager.createNotificationChannel();
        startForeground(
                notificationManager.getDefaultNotificationId(),
                notificationManager.createForegroundNotification());
        mForegroundStarted = true;
        Log.d(TAG, "✅ Foreground service started");
    }

    private AsgNotificationManager resolveNotificationManager() {
        if (serviceInitializer != null) {
            return serviceInitializer.getNotificationManager();
        }
        if (mEarlyNotificationManager == null) {
            mEarlyNotificationManager = new AsgNotificationManager(this);
        }
        return mEarlyNotificationManager;
    }

    private void initializeServiceInitializer() {
        Log.d(TAG, "🔧 initializeServiceInitializer() started");

        try {
            serviceInitializer =
                    new ServiceInitializer(
                            this,
                            companionTransportProvider.get(),
                            networkManagerProvider.get(),
                            fileManager,
                            otaHelper,
                            hardwareManager,
                            besOtaRegistry,
                            protocolStrategies);
            Log.d(TAG, "✅ ServiceInitializer created successfully");

            // Initialize container
            Log.d(TAG, "🚀 Initializing service container");
            serviceInitializer.initialize();
            Log.d(TAG, "✅ Service container initialization completed");

            // Get interface references
            Log.d(TAG, "📋 Getting interface references from service container");
            lifecycleManager = serviceInitializer.getLifecycleManager();
            communicationManager = serviceInitializer.getCommunicationManager();
            configurationManager = serviceInitializer.getConfigurationManager();
            stateManager = serviceInitializer.getStateManager();
            streamingManager = serviceInitializer.getStreamingManager();
            commandProcessor = serviceInitializer.getCommandProcessor();

            Log.d(TAG, "✅ All interface references obtained");
            Log.d(
                    TAG,
                    "📊 Interface status - LifecycleManager: "
                            + (lifecycleManager != null ? "valid" : "null")
                            + ", CommunicationManager: "
                            + (communicationManager != null ? "valid" : "null")
                            + ", ConfigurationManager: "
                            + (configurationManager != null ? "valid" : "null")
                            + ", StateManager: "
                            + (stateManager != null ? "valid" : "null")
                            + ", StreamingManager: "
                            + (streamingManager != null ? "valid" : "null")
                            + ", CommandProcessor: "
                            + (commandProcessor != null ? "valid" : "null"));

        } catch (Exception e) {
            Log.e(TAG, "💥 Error initializing service container", e);
            throw new RuntimeException(e);
        }
    }

    /** Initialize WiFi debouncing */
    private void initializeWifiDebouncing() {
        Log.d(TAG, "📶 initializeWifiDebouncing() started");

        try {
            wifiDebounceHandler = new Handler(Looper.getMainLooper());
            wifiDebounceRunnable =
                    () -> {
                        if (pendingWifiState != lastWifiState) {
                            Log.i(
                                    TAG,
                                    "🔄 WiFi debounce timeout - sending final state: "
                                            + (pendingWifiState ? "CONNECTED" : "DISCONNECTED"));
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
     * Apply saved camera FOV on service start (K900). Ensures last user-chosen FOV is applied after
     * reboot. No-op on non-K900 devices (UnsatisfiedLinkError from libxydev).
     */
    private void applySavedCameraFovOnStart() {
        try {
            if (serviceInitializer == null || serviceInitializer.getServiceManager() == null) {
                return;
            }
            var asgSettings = serviceInitializer.getServiceManager().getAsgSettings();
            if (asgSettings == null) {
                return;
            }
            int fov = asgSettings.getCameraFov();
            int roiPosition = asgSettings.getCameraRoiPosition();
            try {
                DevApi.setCameraFov(fov, roiPosition);
                SystemControllerFactory.get(this).restartCameraHal();
                CameraRestartCooldown.setCooldown();
                Log.d(
                        TAG,
                        "Applied saved camera FOV on start: fov="
                                + fov
                                + ", roi_position="
                                + roiPosition);
            } catch (UnsatisfiedLinkError e) {
                Log.d(TAG, "libxydev not available (non-K900?), skipping apply saved FOV");
            }
        } catch (Exception e) {
            Log.w(TAG, "Could not apply saved camera FOV on start", e);
        }
    }

    /** Apply saved camera tuning (ANR / gain) on service start so HAL config survives reboot. */
    private void applySavedCameraTuningOnStart() {
        try {
            if (serviceInitializer == null || serviceInitializer.getServiceManager() == null) {
                return;
            }
            var asgSettings = serviceInitializer.getServiceManager().getAsgSettings();
            if (asgSettings == null) {
                return;
            }
            boolean anrOn = asgSettings.isCameraAnrEnabled();
            boolean gainOn = asgSettings.isCameraGainEnabled();
            SystemControllerFactory.get(this).setCameraTuningConfig(anrOn, gainOn);
            Log.d(TAG, "Applied saved camera tuning on start: anr=" + anrOn + ", gain=" + gainOn);
        } catch (Exception e) {
            Log.w(TAG, "Could not apply saved camera tuning on start", e);
        }
    }

    /** Register all receivers */
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

    /** Unregister all receivers */
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
        Log.d(
                TAG,
                "📊 Previous state: "
                        + (lastWifiState ? "CONNECTED" : "DISCONNECTED")
                        + ", Pending state: "
                        + (pendingWifiState ? "CONNECTED" : "DISCONNECTED"));

        pendingWifiState = isConnected;

        if (wifiDebounceHandler != null && wifiDebounceRunnable != null) {
            Log.d(TAG, "⏱️ Removing existing WiFi debounce callback");
            wifiDebounceHandler.removeCallbacks(wifiDebounceRunnable);
            Log.d(
                    TAG,
                    "⏱️ Scheduling new WiFi debounce callback in " + WIFI_STATE_DEBOUNCE_MS + "ms");
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
            if (serviceInitializer != null && serviceInitializer.getServiceManager() != null) {
                var serviceManager = serviceInitializer.getServiceManager();
                serviceManager.setWebServerEnabled(isEnabled);

                var networkManager = serviceManager.getNetworkManager();
                var commManager = serviceInitializer.getCommunicationManager();

                if (networkManager != null && commManager != null) {
                    // Build hotspot status JSON
                    JSONObject hotspotStatus = new JSONObject();
                    hotspotStatus.put("type", "hotspot_status_update");
                    hotspotStatus.put("hotspot_enabled", isEnabled);

                    if (isEnabled) {
                        hotspotStatus.put("hotspot_ssid", networkManager.getHotspotSsid());
                        hotspotStatus.put("hotspot_password", networkManager.getHotspotPassword());
                        hotspotStatus.put(
                                "hotspot_gateway_ip", networkManager.getHotspotGatewayIp());
                    }

                    Log.d(TAG, "📡 🔥 Sending hotspot status update: " + hotspotStatus.toString());
                    boolean sent = commManager.sendBluetoothResponse(hotspotStatus);
                    Log.d(
                            TAG,
                            "📡 🔥 "
                                    + (sent
                                            ? "✅ Hotspot status sent successfully"
                                            : "❌ Failed to send hotspot status"));
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
        Log.d(
                TAG,
                "📋 Credentials - SSID: "
                        + ssid
                        + ", Password: "
                        + (password != null ? "***" : "null")
                        + ", AuthToken: "
                        + (authToken != null ? "***" : "null"));
    }

    @Override
    public void onHotspotError(String errorMessage) {
        Log.e(TAG, "📡 🔥 ❌ Hotspot error occurred: " + errorMessage);

        // Send hotspot error to phone
        try {
            if (serviceInitializer != null && serviceInitializer.getServiceManager() != null) {
                var commManager = serviceInitializer.getCommunicationManager();

                if (commManager != null) {
                    // Build hotspot error JSON
                    JSONObject hotspotError = new JSONObject();
                    hotspotError.put("type", "hotspot_error");
                    hotspotError.put("error_message", errorMessage);
                    hotspotError.put("timestamp", System.currentTimeMillis());

                    Log.d(TAG, "📡 🔥 Sending hotspot error: " + hotspotError.toString());
                    boolean sent = commManager.sendBluetoothResponse(hotspotError);
                    Log.d(
                            TAG,
                            "📡 🔥 "
                                    + (sent
                                            ? "✅ Hotspot error sent successfully"
                                            : "❌ Failed to send hotspot error"));
                } else {
                    Log.w(
                            TAG,
                            "📡 🔥 Cannot send hotspot error - communication manager not"
                                    + " available");
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "📡 🔥 Error sending hotspot error message", e);
        }
    }

    // ---------------------------------------------
    // TransportListener Implementation
    // ---------------------------------------------
    @Override
    public void onConnectionStateChanged(boolean connected) {
        Log.i(
                TAG,
                "📶 Bluetooth connection state changed: "
                        + (connected ? "CONNECTED" : "DISCONNECTED"));

        if (connected) {
            // Send the pending APK-done signal immediately on reconnect (before WiFi/version info).
            // This is the primary path for the phone to learn the APK updated successfully.
            if (otaHelper != null) {
                otaHelper.onPhoneConnected();
            }

            Log.d(TAG, "⏱️ Scheduling WiFi status send in 3 seconds");
            // Send WiFi status after delay
            new Handler(Looper.getMainLooper())
                    .postDelayed(
                            () -> {
                                Log.d(TAG, "📤 Sending WiFi status after Bluetooth connection");
                                if (stateManager.isConnectedToWifi()) {
                                    Log.d(TAG, "🌐 WiFi is connected - sending status");
                                    communicationManager.sendWifiStatusOverBle(true);
                                } else {
                                    Log.d(TAG, "📶 WiFi is not connected - sending status");
                                    communicationManager.sendWifiStatusOverBle(false);
                                }
                            },
                            3000);

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
        String incomingPayload = new String(data, StandardCharsets.UTF_8);
        Log.d(
                TAG,
                "📋 Data preview: "
                        + incomingPayload.substring(0, Math.min(incomingPayload.length(), 100))
                        + (incomingPayload.length() > 100 ? "..." : ""));

        // BLE/serial can deliver data before getInterfaceReferences() runs (e.g. right after
        // MY_PACKAGE_REPLACED when the service is still in onCreate). Guard to avoid NPE.
        final CommandProcessor processor = commandProcessor;
        if (processor == null) {
            Log.w(
                    TAG,
                    "⚠️ CommandProcessor not yet initialized - dropping "
                            + data.length
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

        if (serviceInitializer.getServiceManager().getMediaQueueManager() != null) {
            if (!serviceInitializer.getServiceManager().getMediaQueueManager().isQueueEmpty()) {
                Log.i(TAG, "📁 WiFi connected - processing media upload queue");
                serviceInitializer.getServiceManager().getMediaQueueManager().processQueue();
                Log.d(TAG, "✅ Media queue processing initiated");
            } else {
                Log.d(TAG, "📁 Media queue is empty - no processing needed");
            }
        } else {
            Log.w(TAG, "⚠️ Media queue manager is null - cannot process queue");
        }
    }

    /**
     * Send version information to phone in chunks to work around BLE MTU limitations. Chunk 1
     * (version_info_1): app_version, build_number, device_model, android_version. Chunk 3
     * (version_info_3): bes_fw_version, mtk_fw_version, bt_mac_address, wifi_mac_address,
     * serial_number. The phone parses any version_info* message field-by-field, so chunk numbering
     * gaps are fine (version_info_2 used to carry ota_version_url; the glasses no longer advertise
     * a manifest).
     */
    public void sendVersionInfo() {
        sendVersionInfo(null);
    }

    /** Send version information and echo the optional phone request id on every response chunk. */
    public void sendVersionInfo(String requestId) {
        Log.i(TAG, "📊 Sending version information (chunked for MTU)");

        try {
            // Gather all version data
            String appVersion = "1.0.0";
            String buildNumber = "1";
            Log.d(TAG, "📋 Default app version: " + appVersion + ", Build number: " + buildNumber);

            try {
                appVersion = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
                buildNumber =
                        String.valueOf(
                                getPackageManager()
                                        .getPackageInfo(getPackageName(), 0)
                                        .versionCode);
                Log.d(
                        TAG,
                        "✅ Retrieved app version: "
                                + appVersion
                                + ", Build number: "
                                + buildNumber);
            } catch (Exception e) {
                Log.e(TAG, "💥 Error getting app version - using defaults", e);
            }

            String deviceModel = ServiceUtils.getDeviceTypeString(this);
            String androidVersion = android.os.Build.VERSION.RELEASE;

            // Include BES firmware version (cached from hs_syvr command)
            String besFirmwareVersion = "";
            if (serviceInitializer.getServiceManager() != null
                    && serviceInitializer.getServiceManager().getAsgSettings() != null) {
                besFirmwareVersion =
                        serviceInitializer
                                .getServiceManager()
                                .getAsgSettings()
                                .getBesFirmwareVersion();
            }

            // Include MTK firmware version (from system property)
            String mtkFirmwareVersion = SystemControllerFactory.get(this).getSystemOtaVersion();

            // Include BES BT MAC address as unique device identifier (stored in system properties)
            String besBtMac = SysProp.getBesBtMac(this);
            String wifiMac = NetworkUtils.getWifiMacAddress(this);
            String deviceSerial = SysProp.getDeviceSerial(this);

            Log.d(
                    TAG,
                    "📋 Version info prepared - Device: "
                            + deviceModel
                            + ", Android: "
                            + androidVersion
                            + ", BES Firmware: "
                            + besFirmwareVersion
                            + ", MTK Firmware: "
                            + mtkFirmwareVersion
                            + ", BT MAC: "
                            + besBtMac
                            + ", WiFi MAC available: "
                            + !wifiMac.isEmpty()
                            + ", Android device serial available: "
                            + !deviceSerial.isEmpty());

            if (serviceInitializer.getServiceManager().getBluetoothManager() != null
                    && serviceInitializer.getServiceManager().getBluetoothManager().isConnected()) {

                // Chunk 1: Basic device info (smaller payload)
                JSONObject chunk1 = new JSONObject();
                chunk1.put("type", "version_info_1");
                if (requestId != null && !requestId.isEmpty()) {
                    chunk1.put("request_id", requestId);
                }
                chunk1.put("app_version", appVersion);
                chunk1.put("build_number", buildNumber);
                chunk1.put("device_model", deviceModel);
                chunk1.put("android_version", androidVersion);
                chunk1.put("system_time_ms", System.currentTimeMillis());
                // Process session id: lets the phone detect an asg restart under a
                // surviving BLE link (the boot version_info push is the announcement).
                chunk1.put("sid", ProcessSessionId.SID);
                chunk1.put(
                        "hotspot_ota_version",
                        DeviceProfile.detect(this).isK900()
                                ? AsgConstants.HOTSPOT_OTA_VERSION
                                : 0);

                Log.d(TAG, "📤 Sending version_info_1: " + chunk1.toString());
                serviceInitializer
                        .getServiceManager()
                        .getBluetoothManager()
                        .sendMessage(chunk1.toString().getBytes(StandardCharsets.UTF_8));

                // Small delay between chunks to ensure proper ordering
                try {
                    Thread.sleep(100);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }

                // Chunk 3: Firmware info (BES version, MTK version, BT MAC)
                JSONObject chunk3 = new JSONObject();
                chunk3.put("type", "version_info_3");
                if (requestId != null && !requestId.isEmpty()) {
                    chunk3.put("request_id", requestId);
                }
                chunk3.put("bes_fw_version", besFirmwareVersion);
                chunk3.put("mtk_fw_version", mtkFirmwareVersion);
                chunk3.put("bt_mac_address", besBtMac);
                if (!wifiMac.isEmpty()) {
                    chunk3.put("wifi_mac_address", wifiMac);
                }
                if (!deviceSerial.isEmpty()) {
                    chunk3.put("serial_number", deviceSerial);
                }
                addPhoneWireCapsIfSupported(chunk3);

                Log.d(TAG, "📤 Sending version_info_3");
                serviceInitializer
                        .getServiceManager()
                        .getBluetoothManager()
                        .sendMessage(chunk3.toString().getBytes(StandardCharsets.UTF_8));

                Log.i(TAG, "✅ Sent version info chunks to phone successfully");
            } else {
                Log.w(
                        TAG,
                        "⚠️ Bluetooth manager not available or not connected - cannot send version"
                                + " info");
            }
        } catch (JSONException e) {
            Log.e(TAG, "💥 Error creating version info JSON", e);
        } catch (Exception e) {
            Log.e(TAG, "💥 Error sending version info", e);
        }
    }

    private void addPhoneWireCapsIfSupported(JSONObject message) {
        if (serviceInitializer == null || serviceInitializer.getServiceManager() == null) {
            return;
        }
        Object bluetoothManager = serviceInitializer.getServiceManager().getBluetoothManager();
        if (bluetoothManager instanceof K900BluetoothManager) {
            ((K900BluetoothManager) bluetoothManager).addPhoneWireCapsIfSupported(message);
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
                Log.i(
                        TAG,
                        "✅ Photo captured successfully - ID: " + requestId + ", Path: " + filePath);
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
                if (streamingManager != null) {
                    streamingManager.sendVideoRecordingStatusResponse(
                            requestId, true, "recording_started", null);
                }
            }

            @Override
            public void onVideoRecordingStopped(String requestId, String filePath) {
                Log.i(TAG, "⏹️ Video recording stopped - ID: " + requestId + ", Path: " + filePath);
                if (streamingManager != null) {
                    streamingManager.sendVideoRecordingStatusResponse(
                            requestId, true, "recording_stopped", null);
                }
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
                String mediaTypeName =
                        mediaType == MediaUploadQueueManager.MEDIA_TYPE_PHOTO ? "Photo" : "Video";
                Log.e(
                        TAG,
                        "❌ " + mediaTypeName + " error - ID: " + requestId + ", Error: " + error);
                if (streamingManager != null
                        && mediaType == MediaUploadQueueManager.MEDIA_TYPE_VIDEO) {
                    streamingManager.sendVideoRecordingStatusResponse(
                            requestId, false, videoStatusFromError(error), error);
                }
            }
        };
    }

    private String videoStatusFromError(String error) {
        if (error == null || error.isEmpty()) {
            return "error";
        }
        String lower = error.toLowerCase(Locale.US);
        if (lower.contains("already recording")) return "already_recording";
        if (lower.contains("not recording")) return "not_recording";
        if (lower.contains("request id mismatch")) return "request_id_mismatch";
        if (lower.contains("battery")) return "battery_low";
        if (lower.contains("camera busy") || lower.contains("streaming")) return "camera_busy";
        if (lower.contains("storage")) return "storage_unavailable";
        if (lower.contains("integrity")) return "integrity_failed";
        return "error";
    }

    /**
     * Get the CommandProcessor instance
     *
     * @return CommandProcessor or null if not yet initialized
     */
    public CommandProcessor getCommandProcessor() {
        return commandProcessor;
    }

    public ServiceCallbackInterface getServiceCallback() {
        Log.d(TAG, "📡 Creating service callback interface");

        return new ServiceCallbackInterface() {
            @Override
            public void sendThroughBluetooth(byte[] data) {
                Log.d(
                        TAG,
                        "📤 sendThroughBluetooth() called - Data length: "
                                + (data != null ? data.length : "null"));

                if (serviceInitializer.getServiceManager().getBluetoothManager() != null) {
                    Log.d(TAG, "📶 Sending data through Bluetooth");
                    serviceInitializer.getServiceManager().getBluetoothManager().sendMessage(data);
                    Log.d(TAG, "✅ Data sent through Bluetooth successfully");
                } else {
                    Log.w(TAG, "⚠️ Bluetooth manager is null - cannot send data");
                }
            }

            @Override
            public boolean sendFileViaBluetooth(String filePath) {
                Log.d(TAG, "📁 sendFileViaBluetooth() called - File: " + filePath);

                if (serviceInitializer.getServiceManager().getBluetoothManager() != null) {
                    Log.d(TAG, "📶 Starting BLE file transfer");
                    boolean started =
                            serviceInitializer
                                    .getServiceManager()
                                    .getBluetoothManager()
                                    .sendFile(filePath);
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
            public boolean sendFileViaBluetooth(byte[] data, String fileName) {
                Log.d(
                        TAG,
                        "📁 sendFileViaBluetooth(byte[]) called - "
                                + (data != null ? data.length : 0)
                                + " bytes as "
                                + fileName);

                if (serviceInitializer.getServiceManager().getBluetoothManager() != null) {
                    boolean started =
                            serviceInitializer
                                    .getServiceManager()
                                    .getBluetoothManager()
                                    .sendFile(data, fileName);
                    if (started) {
                        Log.i(TAG, "✅ In-memory BLE file transfer started for: " + fileName);
                    } else {
                        Log.e(TAG, "❌ Failed to start in-memory BLE file transfer for: " + fileName);
                    }
                    return started;
                } else {
                    Log.w(TAG, "⚠️ Bluetooth manager is null - cannot send file");
                    return false;
                }
            }

            @Override
            public boolean sendFileViaBluetooth(byte[] data, String fileName, byte[] prelude) {
                if (serviceInitializer.getServiceManager().getBluetoothManager() == null) {
                    Log.w(TAG, "Bluetooth manager is null - cannot send file with prelude");
                    return false;
                }
                return serviceInitializer
                        .getServiceManager()
                        .getBluetoothManager()
                        .sendFile(data, fileName, prelude);
            }

            @Override
            public boolean isBleTransferInProgress() {
                Log.d(TAG, "📊 isBleTransferInProgress() called");

                if (serviceInitializer.getServiceManager().getBluetoothManager() != null) {
                    boolean inProgress =
                            serviceInitializer
                                    .getServiceManager()
                                    .getBluetoothManager()
                                    .isFileTransferInProgress();
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
            heartbeatReceiver =
                    new BroadcastReceiver() {
                        @Override
                        public void onReceive(Context context, Intent intent) {
                            String action = intent.getAction();
                            Log.d(TAG, "💓 Heartbeat receiver triggered - Action: " + action);

                            if ("com.mentra.recovery.ACTION_PING".equals(action)) {
                                // ServiceHeartbeatReceiver (manifest) is the sole PONG sender.
                                Log.d(
                                        TAG,
                                        "💓 Recovery ping received;"
                                                + " acknowledgment handled by"
                                                + " ServiceHeartbeatReceiver");
                            } else {
                                Log.d(TAG, "⏭️ Unknown action received: " + action);
                            }
                        }
                    };

            IntentFilter heartbeatFilter = new IntentFilter();
            heartbeatFilter.addAction(ACTION_OTA_HEARTBEAT);

            registerReceiver(heartbeatReceiver, heartbeatFilter);
            Log.d(TAG, "✅ Heartbeat receiver registered successfully");
        } catch (Exception e) {
            Log.e(TAG, "💥 Error registering heartbeat receiver", e);
        }
    }

    // The heartbeat-inferred phone "connected" flag (isConnected / resetHeartbeatTimeout /
    // start/stopHeartbeatMonitoring) was deleted: its only consumer was the button-press local
    // capture gate, which now reads the BES-reported phone BLE presence from the transport
    // LinkStateMachine. Ping/heartbeat commands still get their acks; they just no longer feed
    // an inference.

    private void registerRestartReceiver() {
        Log.d(TAG, "🔄 registerRestartReceiver() started");

        try {
            restartReceiver =
                    new BroadcastReceiver() {
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
            otaProgressReceiver =
                    new BroadcastReceiver() {
                        @Override
                        public void onReceive(Context context, Intent intent) {
                            String action = intent.getAction();
                            Log.d(TAG, "📥 OTA progress receiver triggered - Action: " + action);

                            switch (Objects.requireNonNull(action)) {
                                case ACTION_DOWNLOAD_PROGRESS:
                                case LEGACY_ACTION_DOWNLOAD_PROGRESS:
                                    Log.d(TAG, "📥 Handling download progress");
                                    handleDownloadProgress(intent);
                                    break;
                                case ACTION_INSTALLATION_PROGRESS:
                                case LEGACY_ACTION_INSTALLATION_PROGRESS:
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
            otaFilter.addAction(LEGACY_ACTION_DOWNLOAD_PROGRESS);
            otaFilter.addAction(LEGACY_ACTION_INSTALLATION_PROGRESS);
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

            Log.i(
                    TAG,
                    "📥 Download progress: "
                            + status
                            + " - "
                            + progress
                            + "% ("
                            + bytesDownloaded
                            + "/"
                            + totalBytes
                            + " bytes)");

            if (errorMessage != null) {
                Log.w(TAG, "⚠️ Download error: " + errorMessage);
            }

            if (commandProcessor != null) {
                Log.d(TAG, "📤 Sending download progress to command processor");
                commandProcessor.sendDownloadProgressOverBle(
                        status, progress, bytesDownloaded, totalBytes, errorMessage, timestamp);
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
                commandProcessor.sendInstallationProgressOverBle(
                        status, apkPath, errorMessage, timestamp);
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
            mtkUpdateReceiver =
                    new BroadcastReceiver() {
                        @Override
                        public void onReceive(Context context, Intent intent) {
                            if ("com.mentra.asg_client.MTK_UPDATE_COMPLETE"
                                    .equals(intent.getAction())) {
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
            Log.e(TAG, "❌ RTMP streaming error: " + ((StreamingEvent.Error) event).getMessage());
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
                SystemControllerFactory.get(context).injectAdbCommand("svc wifi enable");
                Log.d(TAG, "✅ WiFi enable command executed");
            } else {
                Log.d(TAG, "📶 Disabling WiFi via ADB command");
                SystemControllerFactory.get(context).injectAdbCommand("svc wifi disable");
                Log.d(TAG, "✅ WiFi disable command executed");
            }
        } catch (Exception e) {
            Log.e(TAG, "💥 Error executing WiFi command", e);
        }
    }

    /** Log all available video resolutions from the camera */
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
                    CameraCharacteristics characteristics =
                            cameraManager.getCameraCharacteristics(cameraId);
                    StreamConfigurationMap map =
                            characteristics.get(
                                    CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);

                    if (map == null) {
                        Log.w(TAG, "📹 Camera " + cameraId + ": No stream configuration map");
                        continue;
                    }

                    Size[] videoSizes = map.getOutputSizes(MediaRecorder.class);
                    if (videoSizes == null || videoSizes.length == 0) {
                        Log.w(TAG, "📹 Camera " + cameraId + ": No video sizes available");
                        continue;
                    }

                    Log.i(
                            TAG,
                            "📹 Camera "
                                    + cameraId
                                    + " supports "
                                    + videoSizes.length
                                    + " video resolutions:");
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
     * Clean up orphaned BLE transfer files from previous sessions. These are compressed AVIF files
     * stored in the app's external files directory that were never successfully transferred and
     * deleted. This runs on boot, so any BLE temp files are by definition orphaned.
     */
    private void cleanupOrphanedBleTransfers() {
        try {
            // Media root where the per-package BLE transfer files are stored
            java.io.File appFilesDir = MediaStorage.getMediaRoot(this);
            if (appFilesDir == null || !appFilesDir.exists()) {
                Log.d(TAG, "🗑️ App files directory does not exist, skipping cleanup");
                return;
            }

            Log.d(
                    TAG,
                    "🗑️ Checking for orphaned BLE transfer files in: "
                            + appFilesDir.getAbsolutePath());

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
                java.io.File[] files =
                        packageDir.listFiles(
                                (dir, name) ->
                                        // BLE images have pattern like "ble_1234567890" (no
                                        // extension)
                                        name.startsWith("ble_") && !name.contains("."));

                if (files != null && files.length > 0) {
                    Log.d(
                            TAG,
                            "🗑️ Found "
                                    + files.length
                                    + " orphaned BLE files in "
                                    + packageDir.getName());

                    // On boot, ALL BLE temp files are orphaned - no need for time check
                    for (java.io.File file : files) {
                        long fileSize = file.length();
                        String fileName = file.getName();
                        long ageMinutes =
                                (System.currentTimeMillis() - file.lastModified()) / 1000 / 60;

                        if (file.delete()) {
                            totalCleaned++;
                            totalSpaceFreed += fileSize;
                            Log.d(
                                    TAG,
                                    "🗑️ Deleted orphaned BLE transfer: "
                                            + fileName
                                            + " (age: "
                                            + ageMinutes
                                            + " minutes, size: "
                                            + (fileSize / 1024)
                                            + " KB)");
                        } else {
                            Log.w(TAG, "🗑️ Failed to delete orphaned file: " + fileName);
                        }
                    }
                }
            }

            if (totalCleaned > 0) {
                Log.i(
                        TAG,
                        "🗑️ Cleanup complete: Deleted "
                                + totalCleaned
                                + " orphaned BLE files, freed "
                                + (totalSpaceFreed / 1024)
                                + " KB");
                // Optional: Show notification about cleanup
                //                if (serviceInitializer != null &&
                // serviceInitializer.getNotificationManager() != null) {
                //
                // serviceInitializer.getNotificationManager().showDebugNotification("BLE Cleanup",
                //                        "Cleaned " + totalCleaned + " orphaned transfers (" +
                // (totalSpaceFreed / 1024) + " KB)");
                //                }
            } else {
                Log.d(TAG, "🗑️ No orphaned BLE transfer files found");
            }

        } catch (Exception e) {
            Log.e(TAG, "🗑️ Error cleaning up orphaned BLE transfers", e);
        }
    }
}
