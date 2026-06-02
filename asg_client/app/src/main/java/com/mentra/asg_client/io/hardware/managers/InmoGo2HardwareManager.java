package com.mentra.asg_client.io.hardware.managers;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.media.MediaPlayer;
import android.os.BatteryManager;
import android.util.Log;

import com.mentra.asg_client.io.hardware.core.BaseHardwareManager;

import java.io.IOException;

/**
 * Hardware manager for INMO Go2 smart glasses.
 *
 * Device fingerprint (from adb getprop):
 *   ro.product.manufacturer = INMO
 *   ro.product.model        = Go2
 *   ro.product.device       = ima02_go2
 *   ro.product.name         = ima02_go2fu
 *   ro.boot.hardware        = ima02_go2
 *   ro.build.fingerprint    = INMO/ima02_go2fu/ima02_go2:9/...
 *
 * BLE profile (confirmed via nRF Connect scan):
 *   Advertised name : "INMO GO2"
 *   Service UUID    : 00004860-0000-1000-8000-00805f9b34fb
 *   TX (Notify)     : 00004861-0000-1000-8000-00805f9b34fb
 *   RX (Write)      : 00004862-0000-1000-8000-00805f9b34fb
 *   MTU             : 247 bytes
 *
 * The Go2 runs Android 9 on a Unisoc UMS312 SoC (armeabi-v7a).  It exposes a
 * standard Android Camera2 API and BatteryManager — no proprietary LED or
 * audio control SDK is required.
 */
public class InmoGo2HardwareManager extends BaseHardwareManager {

    private static final String TAG = "InmoGo2HardwareManager";

    // ---- Camera / torch ----
    private final CameraManager cameraManager;
    private String cameraWithFlash;
    private boolean torchEnabled;

    // ---- Audio ----
    private MediaPlayer mediaPlayer;

    // -----------------------------------------------------------------------
    // Construction & lifecycle
    // -----------------------------------------------------------------------

    public InmoGo2HardwareManager(Context context) {
        super(context);
        cameraManager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
    }

    @Override
    public void initialize() {
        Log.d(TAG, "⚙️ =========================================");
        Log.d(TAG, "⚙️ INMO GO2 HARDWARE MANAGER INITIALIZE");
        Log.d(TAG, "⚙️ =========================================");
        super.initialize();
        detectFlashCamera();
        Log.d(TAG, "⚙️ ✅ INMO Go2 Hardware Manager initialized");
    }

    // -----------------------------------------------------------------------
    // Identity
    // -----------------------------------------------------------------------

    @Override
    public String getDeviceModel() {
        return "INMO Go2";
    }

    @Override
    public boolean isK900Device() {
        // The Go2 is NOT a K900 / XY-family device.
        return false;
    }

    // -----------------------------------------------------------------------
    // Recording LED (torch-based — same approach as StandardHardwareManager)
    // -----------------------------------------------------------------------

    @Override
    public boolean supportsRecordingLed() {
        return cameraWithFlash != null;
    }

    @Override
    public void setRecordingLedOn() {
        setTorch(true);
    }

    @Override
    public void setRecordingLedOff() {
        setTorch(false);
    }

    @Override
    public void setRecordingLedBlinking() {
        setTorch(true); // Caller manages timing
    }

    @Override
    public void setRecordingLedBlinking(long onDurationMs, long offDurationMs) {
        setTorch(true); // Caller manages timing
    }

    @Override
    public void stopRecordingLedBlinking() {
        setTorch(false);
    }

    @Override
    public void flashRecordingLed(long durationMs) {
        setTorch(true); // Caller manages off scheduling
    }

    @Override
    public boolean isRecordingLedOn() {
        return torchEnabled;
    }

    @Override
    public boolean isRecordingLedBlinking() {
        // Torch-based LED doesn't have a native blink state; track externally if needed.
        return false;
    }

    // -----------------------------------------------------------------------
    // LED brightness — not supported (no custom LED HAL on Go2)
    // -----------------------------------------------------------------------

    @Override
    public boolean supportsLedBrightness() {
        return false;
    }

    @Override
    public void setRecordingLedBrightness(int percent) {
        Log.w(TAG, "LED brightness control not supported on INMO Go2");
    }

    @Override
    public void setRecordingLedBrightness(int percent, int durationMs) {
        Log.w(TAG, "LED brightness control not supported on INMO Go2");
    }

    @Override
    public int getRecordingLedBrightness() {
        return 0;
    }

    // -----------------------------------------------------------------------
    // RGB LED — not supported
    // -----------------------------------------------------------------------

    @Override
    public boolean supportsRgbLed() {
        return false;
    }

    @Override
    public void setRgbLedBrightness(int brightness) {
        Log.w(TAG, "RGB LED not supported on INMO Go2");
    }

    @Override
    public void setRgbLedOn(int ledIndex, int ontime, int offtime, int count) {
        Log.w(TAG, "RGB LED not supported on INMO Go2");
    }

    @Override
    public void setRgbLedOn(int ledIndex, int ontime, int offtime, int count, int brightness) {
        Log.w(TAG, "RGB LED not supported on INMO Go2");
    }

    @Override
    public void setRgbLedOff() {
        Log.w(TAG, "RGB LED not supported on INMO Go2");
    }

    @Override
    public void flashRgbLedWhite(int durationMs) {
        Log.w(TAG, "RGB LED not supported on INMO Go2");
    }

    @Override
    public void flashRgbLedWhite(int durationMs, int brightness) {
        Log.w(TAG, "RGB LED not supported on INMO Go2");
    }

    @Override
    public void setRgbLedSolidWhite(int durationMs) {
        Log.w(TAG, "RGB LED not supported on INMO Go2");
    }

    @Override
    public void setRgbLedSolidWhite(int durationMs, int brightness) {
        Log.w(TAG, "RGB LED not supported on INMO Go2");
    }

    // -----------------------------------------------------------------------
    // Audio playback (standard MediaPlayer — Go2 has working Android audio)
    // -----------------------------------------------------------------------

    @Override
    public boolean supportsAudioPlayback() {
        return true;
    }

    @Override
    public void playAudioAsset(String assetName) {
        stopAudioPlayback();
        mediaPlayer = new MediaPlayer();
        try {
            var afd = context.getAssets().openFd(assetName);
            mediaPlayer.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
            afd.close();
            mediaPlayer.setOnCompletionListener(mp -> {
                mp.release();
                mediaPlayer = null;
            });
            mediaPlayer.setOnErrorListener((mp, what, extra) -> {
                Log.e(TAG, "Error playing asset " + assetName + " (" + what + "/" + extra + ")");
                mp.release();
                mediaPlayer = null;
                return true;
            });
            mediaPlayer.prepare();
            mediaPlayer.start();
        } catch (IOException e) {
            Log.e(TAG, "Unable to play asset: " + assetName, e);
            mediaPlayer.release();
            mediaPlayer = null;
        }
    }

    @Override
    public void stopAudioPlayback() {
        if (mediaPlayer != null) {
            try {
                if (mediaPlayer.isPlaying()) {
                    mediaPlayer.stop();
                }
            } catch (IllegalStateException ignored) { }
            mediaPlayer.release();
            mediaPlayer = null;
        }
    }

    // -----------------------------------------------------------------------
    // Bluetooth manager hook (no-op — Go2 uses standard Android BLE stack,
    // not a proprietary MCU-bridged BT path like K900/BES2700)
    // -----------------------------------------------------------------------

    @Override
    public void setBluetoothManager(Object bluetoothManager) {
        // INMO Go2 handles BLE via InmoGo2BluetoothManager independently;
        // no hardware-level LED or audio is driven through the BT pipe.
        Log.d(TAG, "setBluetoothManager: INMO Go2 does not require BT-coupled hardware control");
    }

    // -----------------------------------------------------------------------
    // Battery (standard Android BatteryManager)
    // -----------------------------------------------------------------------

    @Override
    public int getBatteryLevel() {
        BatteryManager bm = (BatteryManager) context.getSystemService(Context.BATTERY_SERVICE);
        if (bm != null) {
            int level = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
            Log.d(TAG, "🔋 Battery level: " + level + "%");
            return level;
        }
        Log.w(TAG, "🔋 BatteryManager not available");
        return -1;
    }

    @Override
    public boolean getChargingStatus() {
        IntentFilter filter = new IntentFilter(Intent.ACTION_BATTERY_CHANGED);
        Intent batteryStatus = context.registerReceiver(null, filter);
        if (batteryStatus != null) {
            int status = batteryStatus.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            boolean isCharging = status == BatteryManager.BATTERY_STATUS_CHARGING
                    || status == BatteryManager.BATTERY_STATUS_FULL;
            Log.d(TAG, "🔋 Charging status: " + isCharging);
            return isCharging;
        }
        Log.w(TAG, "🔋 Battery status intent unavailable");
        return false;
    }

    // -----------------------------------------------------------------------
    // Shutdown
    // -----------------------------------------------------------------------

    @Override
    public void shutdown() {
        Log.d(TAG, "Shutting down InmoGo2HardwareManager");
        stopTorchIfOn();
        stopAudioPlayback();
        super.shutdown();
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /**
     * Scan available cameras and find the rear camera that has a torch/flash unit.
     * The Go2 has a single rear-facing camera (IMX471v1, 4 MP).
     */
    private void detectFlashCamera() {
        if (cameraManager == null) {
            Log.w(TAG, "CameraManager unavailable — torch support disabled");
            return;
        }
        try {
            for (String id : cameraManager.getCameraIdList()) {
                CameraCharacteristics ch = cameraManager.getCameraCharacteristics(id);
                Boolean flashAvailable = ch.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
                Integer lensFacing  = ch.get(CameraCharacteristics.LENS_FACING);
                if (Boolean.TRUE.equals(flashAvailable)
                        && lensFacing != null
                        && lensFacing == CameraCharacteristics.LENS_FACING_BACK) {
                    cameraWithFlash = id;
                    Log.d(TAG, "⚙️ Rear camera with torch detected: id=" + id);
                    return;
                }
            }
            Log.w(TAG, "⚙️ No rear camera with torch found — recording LED will be unavailable");
        } catch (CameraAccessException e) {
            Log.e(TAG, "Camera access exception during flash detection", e);
        }
    }

    private void setTorch(boolean enabled) {
        if (cameraManager == null || cameraWithFlash == null) {
            Log.w(TAG, "Torch control unavailable");
            return;
        }
        try {
            cameraManager.setTorchMode(cameraWithFlash, enabled);
            torchEnabled = enabled;
            Log.d(TAG, enabled ? "🔦 Torch ON" : "🔦 Torch OFF");
        } catch (CameraAccessException | SecurityException e) {
            Log.e(TAG, "Failed to set torch state: " + enabled, e);
        }
    }

    private void stopTorchIfOn() {
        if (torchEnabled) {
            setTorch(false);
        }
    }
}
