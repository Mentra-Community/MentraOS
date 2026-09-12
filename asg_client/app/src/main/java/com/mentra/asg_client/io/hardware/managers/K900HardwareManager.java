package com.mentra.asg_client.io.hardware.managers;

import android.content.Context;
import android.os.SystemClock;
import android.util.Log;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.audio.I2SAudioController;
import com.mentra.asg_client.hardware.K900LedController;
import com.mentra.asg_client.hardware.K900RgbLedController;
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.io.hardware.core.BaseHardwareManager;
import com.mentra.asg_client.io.hardware.interfaces.Capability;
import com.mentra.asg_client.service.core.constants.BatteryConstants;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.util.EnumSet;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Implementation of IHardwareManager for K900 devices. Uses K900-specific hardware APIs including
 * the xydev library for LED control.
 */
public class K900HardwareManager extends BaseHardwareManager {
    private static final String TAG = "K900HardwareManager";

    // Battery cache settings
    private static final long BATTERY_CACHE_DURATION_MS = 2 * 60 * 1000; // 2 minutes
    private static final long BATTERY_REFRESH_RETRY_MS = 1000;
    private static final long BATTERY_QUERY_SEND_TIMEOUT_MS = 1000;
    private static final long BATTERY_QUERY_TIMEOUT_MS = 250;

    private K900LedController ledController;
    private K900RgbLedController rgbLedController;
    private I2SAudioController audioController;
    private K900BluetoothManager bluetoothManager;

    // Battery cache
    private int cachedBatteryLevel = -1;
    private boolean cachedChargingStatus = false;
    private boolean cachedActiveCharging = false;
    private long activeChargeReceivedAtElapsedMs = -1;
    private long lastBatteryQueryTime = 0;
    private long lastBatteryRefreshRequestTime = 0;
    private boolean batteryRefreshQueued = false;
    private CountDownLatch batteryResponseLatch;
    private final Object batteryLock = new Object();
    private final Object batteryQueryLock = new Object();

    /**
     * Create a new K900HardwareManager
     *
     * @param context The application context
     */
    public K900HardwareManager(Context context) {
        super(context);
    }

    @Override
    public void initialize() {
        Log.d(TAG, "🔧 =========================================");
        Log.d(TAG, "🔧 K900 HARDWARE MANAGER INITIALIZE");
        Log.d(TAG, "🔧 =========================================");

        super.initialize();

        // Initialize the K900 LED controller
        try {
            ledController = K900LedController.getInstance();
            Log.d(TAG, "🔧 ✅ K900 LED controller initialized successfully");
        } catch (Exception e) {
            Log.e(TAG, "🔧 ❌ Failed to initialize K900 LED controller", e);
            ledController = null;
        }

        audioController = new I2SAudioController(context);

        // Note: BES system version query will be requested when BluetoothManager is set
        // via setBluetoothManager() -> requestSystemVersion() call
        // Response (~50ms) will be cached via K900CommandHandler.handleSystemVersionReport()

        Log.d(TAG, "🔧 ✅ K900 Hardware Manager initialized");
    }

    @Override
    public boolean supportsRecordingLed() {
        // K900 devices support recording LED
        return ledController != null;
    }

    @Override
    public void setRecordingLedOn() {
        if (ledController != null) {
            ledController.turnOn();
            Log.d(TAG, "🔴 Recording LED turned ON");
        } else {
            Log.w(TAG, "LED controller not available");
        }
    }

    @Override
    public void setRecordingLedOff() {
        if (ledController != null) {
            ledController.turnOff();
            Log.d(TAG, "⚫ Recording LED turned OFF");
        } else {
            Log.w(TAG, "LED controller not available");
        }
    }

    @Override
    public void setRecordingLedBlinking() {
        if (ledController != null) {
            ledController.startBlinking();
            Log.d(TAG, "🔴⚫ Recording LED set to BLINKING (default pattern)");
        } else {
            Log.w(TAG, "LED controller not available");
        }
    }

    @Override
    public void setRecordingLedBlinking(long onDurationMs, long offDurationMs) {
        if (ledController != null) {
            ledController.startBlinking(onDurationMs, offDurationMs);
            Log.d(
                    TAG,
                    String.format(
                            "🔴⚫ Recording LED set to BLINKING (on=%dms, off=%dms)",
                            onDurationMs, offDurationMs));
        } else {
            Log.w(TAG, "LED controller not available");
        }
    }

    @Override
    public void stopRecordingLedBlinking() {
        if (ledController != null) {
            ledController.stopBlinking();
            Log.d(TAG, "⚫ Recording LED blinking stopped");
        } else {
            Log.w(TAG, "LED controller not available");
        }
    }

    @Override
    public void flashRecordingLed(long durationMs) {
        if (ledController != null) {
            ledController.flash(durationMs);
            Log.d(TAG, String.format("💥 Recording LED flashed for %dms", durationMs));
        } else {
            Log.w(TAG, "LED controller not available");
        }
    }

    @Override
    public boolean isRecordingLedOn() {
        if (ledController != null) {
            return ledController.isLedOn();
        }
        return false;
    }

    @Override
    public boolean isRecordingLedBlinking() {
        if (ledController != null) {
            return ledController.isBlinking();
        }
        return false;
    }

    @Override
    public String getDeviceModel() {
        return "K900";
    }

    @Override
    public Set<Capability> getCapabilities() {
        return EnumSet.of(
                Capability.RECORDING_LED,
                Capability.LED_BRIGHTNESS,
                Capability.RGB_LED,
                Capability.MCU_AUDIO,
                Capability.MCU_BATTERY);
    }

    @Override
    public boolean supportsAudioPlayback() {
        return true;
    }

    @Override
    public void playAudioAsset(String assetName) {
        if (audioController != null) {
            audioController.playAsset(assetName, AsgConstants.AUDIO_PLAYBACK_VOLUME);
        } else {
            Log.w(TAG, "Audio controller not available");
        }
    }

    @Override
    public long playAudioAssetTracked(String assetName) {
        if (audioController != null) {
            return audioController.playAssetTracked(
                    assetName, AsgConstants.AUDIO_PLAYBACK_VOLUME);
        }
        Log.w(TAG, "Audio controller not available");
        return 0L;
    }

    @Override
    public boolean replaceAudioAssetIfCurrent(long playbackToken, String assetName) {
        return audioController != null
                && audioController.replaceAssetIfCurrent(
                        playbackToken, assetName, AsgConstants.AUDIO_PLAYBACK_VOLUME);
    }

    @Override
    public void playAudioAssetOverlay(String assetName) {
        if (audioController != null) {
            audioController.playOverlayAsset(assetName, AsgConstants.AUDIO_PLAYBACK_VOLUME);
        } else {
            Log.w(TAG, "Audio controller not available");
        }
    }

    @Override
    public void playAudioAssetOverlay(String assetName, float playbackVolume) {
        if (audioController != null) {
            audioController.playOverlayAsset(assetName, playbackVolume);
        } else {
            Log.w(TAG, "Audio controller not available");
        }
    }

    @Override
    public long playAudioAssetOverlayTracked(String assetName) {
        if (audioController != null) {
            return audioController.playOverlayAssetTracked(
                    assetName, AsgConstants.AUDIO_PLAYBACK_VOLUME);
        }
        Log.w(TAG, "Audio controller not available");
        return 0L;
    }

    @Override
    public long playAudioAssetOverlayTracked(String assetName, float playbackVolume) {
        if (audioController != null) {
            return audioController.playOverlayAssetTracked(assetName, playbackVolume);
        }
        Log.w(TAG, "Audio controller not available");
        return 0L;
    }

    @Override
    public boolean stopAudioOverlayPlayback(long playbackToken) {
        return audioController != null && audioController.stopOverlayPlayback(playbackToken);
    }

    @Override
    public void stopAudioPlayback() {
        if (audioController != null) {
            audioController.stopPlayback();
        }
    }

    @Override
    public boolean stopAudioPlaybackIfCurrent(long playbackToken) {
        return audioController != null && audioController.stopPlaybackIfCurrent(playbackToken);
    }

    @Override
    public boolean playAudioFile(java.io.File file) {
        if (audioController == null) {
            Log.w(TAG, "Audio controller not available");
            return false;
        }
        if (file == null || !file.isFile()) {
            Log.w(TAG, "playAudioFile skipped: missing file " + file);
            return false;
        }
        audioController.playFile(file, AsgConstants.AUDIO_PLAYBACK_VOLUME);
        return true;
    }

    @Override
    public void setTransport(ICompanionTransport transport) {
        if (transport instanceof K900BluetoothManager) {
            this.bluetoothManager = (K900BluetoothManager) transport;
            try {
                rgbLedController = new K900RgbLedController(this.bluetoothManager);
                Log.d(TAG, "K900 RGB LED controller initialized");
            } catch (Exception e) {
                Log.e(TAG, "Failed to initialize K900 RGB LED controller", e);
                rgbLedController = null;
            }
        } else {
            Log.w(TAG, "Invalid transport for K900 hardware (expected K900BluetoothManager)");
        }
    }

    // ============================================
    // MTK LED Brightness Control
    // ============================================

    @Override
    public boolean supportsLedBrightness() {
        return ledController != null;
    }

    @Override
    public void setRecordingLedBrightness(int percent) {
        if (ledController != null) {
            ledController.setBrightness(percent);
            Log.d(TAG, String.format("💡 Recording LED brightness set to %d%%", percent));
        } else {
            Log.w(TAG, "LED controller not available");
        }
    }

    @Override
    public void setRecordingLedBrightness(int percent, int durationMs) {
        if (ledController != null) {
            ledController.setBrightness(percent, durationMs);
            Log.d(
                    TAG,
                    String.format(
                            "💡 Recording LED brightness set to %d%% for %dms",
                            percent, durationMs));
        } else {
            Log.w(TAG, "LED controller not available");
        }
    }

    @Override
    public int getRecordingLedBrightness() {
        if (ledController != null) {
            return ledController.getBrightness();
        }
        return 0;
    }

    // ============================================
    // RGB LED Control (BES Chipset)
    // ============================================

    @Override
    public boolean supportsRgbLed() {
        return rgbLedController != null;
    }

    @Override
    public void setRgbLedBrightness(int brightness) {
        if (rgbLedController != null) {
            rgbLedController.setBrightness(brightness);
            Log.d(TAG, String.format("🚨 RGB LED brightness set to %d", brightness));
        } else {
            Log.w(TAG, "RGB LED controller not available - call setBluetoothManager() first");
        }
    }

    @Override
    public void setRgbLedOn(int ledIndex, int ontime, int offtime, int count) {
        if (rgbLedController != null) {
            rgbLedController.setLedOn(ledIndex, ontime, offtime, count);
            Log.d(
                    TAG,
                    String.format(
                            "🚨 RGB LED ON - Index: %d, OnTime: %dms, OffTime: %dms, Count: %d",
                            ledIndex, ontime, offtime, count));
        } else {
            Log.w(TAG, "RGB LED controller not available - call setBluetoothManager() first");
        }
    }

    @Override
    public void setRgbLedOn(int ledIndex, int ontime, int offtime, int count, int brightness) {
        if (rgbLedController != null) {
            rgbLedController.setLedOn(ledIndex, ontime, offtime, count, brightness);
            Log.d(
                    TAG,
                    String.format(
                            "🚨 RGB LED ON - Index: %d, OnTime: %dms, OffTime: %dms, Count: %d,"
                                    + " Brightness: %d",
                            ledIndex, ontime, offtime, count, brightness));
        } else {
            Log.w(TAG, "RGB LED controller not available - call setBluetoothManager() first");
        }
    }

    @Override
    public void setRgbLedOff() {
        if (rgbLedController != null) {
            rgbLedController.setLedOff();
            Log.d(TAG, "🚨 RGB LED OFF");
        } else {
            Log.w(TAG, "RGB LED controller not available");
        }
    }

    @Override
    public void flashRgbLedWhite(int durationMs) {
        if (rgbLedController != null) {
            rgbLedController.flashWhite(durationMs);
            Log.d(TAG, String.format("📸 RGB LED white flash for %dms", durationMs));
        } else {
            Log.w(TAG, "RGB LED controller not available");
        }
    }

    @Override
    public void flashRgbLedWhite(int durationMs, int brightness) {
        if (rgbLedController != null) {
            rgbLedController.flashWhite(durationMs, brightness);
            Log.d(
                    TAG,
                    String.format(
                            "📸 RGB LED white flash for %dms at brightness %d",
                            durationMs, brightness));
        } else {
            Log.w(TAG, "RGB LED controller not available");
        }
    }

    @Override
    public void setRgbLedSolidWhite(int durationMs) {
        Log.d(TAG, "setRgbLedSolidWhite(" + durationMs + ") called");
        if (rgbLedController != null) {
            rgbLedController.setSolidWhite(durationMs);
            Log.d(TAG, String.format("🎥 RGB LED solid white for %dms", durationMs));
        } else {
            Log.w(TAG, "RGB LED controller not available");
        }
    }

    // ============================================
    // Battery Status (BES Query with Cache)
    // ============================================

    @Override
    public int getBatteryLevel() {
        int batteryLevel;
        boolean refresh;
        synchronized (batteryLock) {
            batteryLevel = cachedBatteryLevel;
            refresh = !isBatteryCacheFreshLocked();
        }
        if (refresh) {
            requestBatteryRefresh();
        } else {
            Log.d(TAG, "🔋 Returning cached battery level: " + batteryLevel + "%");
        }
        return batteryLevel;
    }

    @Override
    public int queryBatteryLevel() {
        synchronized (batteryQueryLock) {
            synchronized (batteryLock) {
                if (isBatteryCacheFreshLocked()) {
                    Log.d(TAG, "🔋 Returning cached battery level: " + cachedBatteryLevel + "%");
                    return cachedBatteryLevel;
                }
            }
            if (!queryBatteryFromBes()) {
                Log.w(TAG, "🔋 Battery query failed; returning the last cached value");
            }
            synchronized (batteryLock) {
                return cachedBatteryLevel;
            }
        }
    }

    @Override
    public boolean getChargingStatus() {
        boolean charging;
        boolean refresh;
        synchronized (batteryLock) {
            charging = cachedChargingStatus;
            refresh = !isBatteryCacheFreshLocked();
        }
        if (refresh) {
            requestBatteryRefresh();
        } else {
            Log.d(TAG, "🔋 Returning cached charging status: " + charging);
        }
        return charging;
    }

    private boolean isBatteryCacheFreshLocked() {
        return cachedBatteryLevel >= 0
                && (System.currentTimeMillis() - lastBatteryQueryTime) < BATTERY_CACHE_DURATION_MS;
    }

    @Override
    public boolean allowsLowBatteryCamera(int batteryLevel) {
        long now = SystemClock.elapsedRealtime();
        boolean allowed;
        boolean refresh;
        long receivedAt;
        synchronized (batteryLock) {
            receivedAt = activeChargeReceivedAtElapsedMs;
            long age = now - activeChargeReceivedAtElapsedMs;
            boolean received = activeChargeReceivedAtElapsedMs >= 0 && age >= 0;
            // Match the caller's SOC to the same reply as the charger evidence. Neither
            // phone battery_status nor the legacy voltage heuristic can grant this exception.
            allowed =
                    batteryLevel > AsgConstants.CAMERA_CHARGING_BATTERY_FLOOR
                            && batteryLevel < BatteryConstants.MIN_BATTERY_LEVEL
                            && batteryLevel == cachedBatteryLevel
                            && cachedActiveCharging
                            && received
                            && age < AsgConstants.CAMERA_ACTIVE_CHARGE_MAX_AGE_MS;
            refresh = !received || age >= AsgConstants.CAMERA_BATTERY_REFRESH_MS;
        }
        if (refresh) {
            requestBatteryRefresh(true);
        }
        return allowed
                && bluetoothManager != null
                && bluetoothManager.isCurrentUartEvidence(receivedAt);
    }

    /** Queue at most one best-effort refresh without blocking a getter caller. */
    private void requestBatteryRefresh() {
        requestBatteryRefresh(false);
    }

    private void requestBatteryRefresh(boolean refreshCharger) {
        if (bluetoothManager == null || !bluetoothManager.isConnected()) {
            return;
        }

        long now = System.currentTimeMillis();
        synchronized (batteryLock) {
            if ((!refreshCharger && isBatteryCacheFreshLocked())
                    || batteryRefreshQueued
                    || batteryResponseLatch != null
                    || (now - lastBatteryRefreshRequestTime) < BATTERY_REFRESH_RETRY_MS) {
                return;
            }
            batteryRefreshQueued = true;
            lastBatteryRefreshRequestTime = now;
        }

        byte[] command;
        try {
            command = buildBatteryQueryCommand();
        } catch (JSONException e) {
            Log.e(TAG, "🔋 Error building asynchronous battery query command", e);
            finishBatteryRefresh(false);
            return;
        }

        boolean accepted =
                bluetoothManager.sendMessage(
                        command,
                        success -> {
                            finishBatteryRefresh(success);
                            if (!success) {
                                Log.w(TAG, "🔋 Asynchronous battery refresh send failed");
                            }
                        });
        if (!accepted) {
            finishBatteryRefresh(false);
        }
    }

    private void finishBatteryRefresh(boolean sent) {
        synchronized (batteryLock) {
            batteryRefreshQueued = false;
            if (!sent) {
                lastBatteryRefreshRequestTime = 0;
            }
        }
    }

    private static byte[] buildBatteryQueryCommand() throws JSONException {
        JSONObject k900Command = new JSONObject();
        k900Command.put("C", "mh_batv");
        k900Command.put("V", 1);
        k900Command.put("B", "");
        return k900Command.toString().getBytes(StandardCharsets.UTF_8);
    }

    /**
     * Query battery status from BES chipset. The caller must not be the UART reader: that reader
     * has to remain free to deliver the matching hm_batv response.
     *
     * @return true if query succeeded and cache was updated, false otherwise
     */
    private boolean queryBatteryFromBes() {
        if (bluetoothManager == null || !bluetoothManager.isConnected()) {
            Log.w(TAG, "🔋 Cannot query battery - Bluetooth not connected");
            return false;
        }

        CountDownLatch responseLatch = new CountDownLatch(1);
        CountDownLatch sendLatch = new CountDownLatch(1);
        AtomicBoolean sendSucceeded = new AtomicBoolean(false);
        try {
            synchronized (batteryLock) {
                batteryResponseLatch = responseLatch;
            }

            byte[] command = buildBatteryQueryCommand();
            String commandStr = new String(command, StandardCharsets.UTF_8);
            Log.d(TAG, "🔋 Querying battery from BES: " + commandStr);

            // sendMessage queues work. Wait for its completion callback before starting the BES
            // response budget so unrelated outbound traffic cannot consume that entire budget.
            boolean accepted =
                    bluetoothManager.sendMessage(
                            command,
                            success -> {
                                sendSucceeded.set(success);
                                sendLatch.countDown();
                            });
            if (!accepted) {
                Log.e(TAG, "🔋 Failed to queue battery query command");
                return false;
            }
            if (!sendLatch.await(BATTERY_QUERY_SEND_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                Log.w(
                        TAG,
                        "🔋 Battery query send timed out after "
                                + BATTERY_QUERY_SEND_TIMEOUT_MS
                                + "ms");
                return false;
            }
            if (!sendSucceeded.get()) {
                Log.e(TAG, "🔋 Failed to send battery query command");
                return false;
            }

            // Wait for response with timeout
            boolean received = responseLatch.await(BATTERY_QUERY_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            if (received) {
                Log.d(TAG, "🔋 Battery query response received within timeout");
                return true;
            } else {
                Log.w(TAG, "🔋 Battery query timed out after " + BATTERY_QUERY_TIMEOUT_MS + "ms");
                return false;
            }

        } catch (JSONException e) {
            Log.e(TAG, "🔋 Error building battery query command", e);
            return false;
        } catch (InterruptedException e) {
            Log.e(TAG, "🔋 Battery query interrupted", e);
            Thread.currentThread().interrupt();
            return false;
        } finally {
            synchronized (batteryLock) {
                if (batteryResponseLatch == responseLatch) {
                    batteryResponseLatch = null;
                }
            }
        }
    }

    /**
     * Called by K900CommandHandler when hm_batv response is received from BES. Updates the cached
     * battery values and signals any waiting query.
     *
     * @param batteryLevel Battery percentage (0-100)
     * @param batteryVoltage Battery voltage in mV
     */
    @Override
    public void notifyBatteryReading(int percent, int voltageMv) {
        onBatteryResponse(percent, voltageMv);
    }

    /**
     * @deprecated Use {@link #notifyBatteryReading(int, int)} via {@link IHardwareManager}.
     */
    public void onBatteryResponse(int batteryLevel, int batteryVoltage) {
        notifyBatteryReading(batteryLevel, batteryVoltage, false, SystemClock.elapsedRealtime());
    }

    @Override
    public void notifyBatteryReading(
            int batteryLevel, int batteryVoltage, boolean activeCharging, long receivedAtElapsedMs) {
        synchronized (batteryLock) {
            if (receivedAtElapsedMs < 0
                    || receivedAtElapsedMs > SystemClock.elapsedRealtime()
                    || receivedAtElapsedMs < activeChargeReceivedAtElapsedMs) {
                return; // A queued older positive reply must not overwrite newer charger loss.
            }
            cachedBatteryLevel = batteryLevel;
            cachedChargingStatus = batteryVoltage > 3900;
            cachedActiveCharging = activeCharging;
            activeChargeReceivedAtElapsedMs = receivedAtElapsedMs;
            lastBatteryQueryTime = System.currentTimeMillis();
            batteryRefreshQueued = false;

            Log.d(
                    TAG,
                    "🔋 Battery cache updated: "
                            + cachedBatteryLevel
                            + "%, charging="
                            + cachedChargingStatus);

            // hm_batv has no request ID. Every reply is therefore a valid battery state sample;
            // a delayed reply may satisfy the current serialized reader rather than being
            // discarded using correlation information the protocol does not provide.
            if (batteryResponseLatch != null) {
                batteryResponseLatch.countDown();
            }
        }
    }

    @Override
    public void setRgbLedSolidWhite(int durationMs, int brightness) {
        Log.d(TAG, "setRgbLedSolidWhite(" + durationMs + ", " + brightness + ") called");
        if (rgbLedController != null) {
            rgbLedController.setSolidWhite(durationMs, brightness);
            Log.d(
                    TAG,
                    String.format(
                            "🎥 RGB LED solid white for %dms at brightness %d",
                            durationMs, brightness));
        } else {
            Log.w(TAG, "RGB LED controller not available");
        }
    }

    @Override
    public void shutdown() {
        Log.d(TAG, "Shutting down K900HardwareManager");

        if (audioController != null) {
            audioController.stopPlayback();
            audioController = null;
        }

        if (rgbLedController != null) {
            rgbLedController = null;
        }

        if (ledController != null) {
            ledController.shutdown();
            ledController = null;
        }

        super.shutdown();
    }
}
