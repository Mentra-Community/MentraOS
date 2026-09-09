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
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.hardware.core.BaseHardwareManager;
import com.mentra.asg_client.io.hardware.interfaces.Capability;
import java.io.File;
import java.io.IOException;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Hardware implementation for generic Android glasses that expose a standard torch and audio path.
 */
public class StandardHardwareManager extends BaseHardwareManager {

    private static final String TAG = "StandardHardwareManager";

    private final CameraManager cameraManager;
    private String cameraWithFlash;
    private boolean torchEnabled;

    private MediaPlayer mediaPlayer;
    private final Map<Long, MediaPlayer> overlayPlayers = new HashMap<>();
    private final AtomicLong nextOverlayToken = new AtomicLong(1L);

    public StandardHardwareManager(Context context) {
        super(context);
        cameraManager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
    }

    @Override
    public void initialize() {
        super.initialize();
        detectFlashCamera();
    }

    @Override
    public Set<Capability> getCapabilities() {
        EnumSet<Capability> caps = EnumSet.of(Capability.MCU_BATTERY);
        if (supportsRecordingLed()) {
            caps.add(Capability.RECORDING_LED);
        }
        return caps;
    }

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
        // Simple blink: turn on, schedule off via stopRecordingLedBlinking or caller preference.
        setTorch(true);
    }

    @Override
    public void setRecordingLedBlinking(long onDurationMs, long offDurationMs) {
        setTorch(true);
        // Note: caller should manage timing; we expose the basic capability only.
    }

    @Override
    public void stopRecordingLedBlinking() {
        setTorch(false);
    }

    @Override
    public void flashRecordingLed(long durationMs) {
        setTorch(true);
        // Responsibility for scheduling the off state remains with the caller.
    }

    @Override
    public boolean isRecordingLedOn() {
        return torchEnabled;
    }

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
            mediaPlayer.setDataSource(
                    afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
            afd.close();
            mediaPlayer.setOnCompletionListener(
                    mp -> {
                        mp.release();
                        mediaPlayer = null;
                    });
            mediaPlayer.setOnErrorListener(
                    (mp, what, extra) -> {
                        Log.e(
                                TAG,
                                "Error playing asset "
                                        + assetName
                                        + " ("
                                        + what
                                        + "/"
                                        + extra
                                        + ")");
                        mp.release();
                        mediaPlayer = null;
                        return true;
                    });
            mediaPlayer.prepare();
            mediaPlayer.start();
        } catch (IOException e) {
            Log.e(TAG, "Unable to play asset " + assetName, e);
            mediaPlayer.release();
            mediaPlayer = null;
        }
    }

    @Override
    public boolean playAudioFile(File file) {
        if (file == null || !file.isFile()) {
            Log.w(TAG, "playAudioFile skipped: missing file " + file);
            return false;
        }
        stopAudioPlayback();
        mediaPlayer = new MediaPlayer();
        try {
            mediaPlayer.setDataSource(file.getAbsolutePath());
            mediaPlayer.setOnCompletionListener(
                    mp -> {
                        mp.release();
                        mediaPlayer = null;
                    });
            mediaPlayer.setOnErrorListener(
                    (mp, what, extra) -> {
                        Log.e(
                                TAG,
                                "Error playing file "
                                        + file.getAbsolutePath()
                                        + " ("
                                        + what
                                        + "/"
                                        + extra
                                        + ")");
                        mp.release();
                        mediaPlayer = null;
                        return true;
                    });
            mediaPlayer.prepare();
            mediaPlayer.start();
            return true;
        } catch (IOException e) {
            Log.e(TAG, "Unable to play file " + file.getAbsolutePath(), e);
            mediaPlayer.release();
            mediaPlayer = null;
            return false;
        }
    }

    @Override
    public void playAudioAssetOverlay(String assetName) {
        playAudioAssetOverlayTracked(assetName, 1.0f);
    }

    @Override
    public void playAudioAssetOverlay(String assetName, float playbackVolume) {
        playAudioAssetOverlayTracked(assetName, playbackVolume);
    }

    @Override
    public long playAudioAssetOverlayTracked(String assetName) {
        return playAudioAssetOverlayTracked(assetName, 1.0f);
    }

    @Override
    public long playAudioAssetOverlayTracked(String assetName, float playbackVolume) {
        long token = nextOverlayToken.getAndIncrement();
        MediaPlayer overlayPlayer = new MediaPlayer();
        synchronized (overlayPlayers) {
            overlayPlayers.put(token, overlayPlayer);
        }
        try {
            var afd = context.getAssets().openFd(assetName);
            overlayPlayer.setDataSource(
                    afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
            afd.close();
            overlayPlayer.setVolume(playbackVolume, playbackVolume);
            overlayPlayer.setOnCompletionListener(mp -> releaseOverlayPlayer(token, mp));
            overlayPlayer.setOnErrorListener(
                    (mp, what, extra) -> {
                        Log.e(
                                TAG,
                                "Error playing overlay asset "
                                        + assetName
                                        + " ("
                                        + what
                                        + "/"
                                        + extra
                                        + ")");
                        releaseOverlayPlayer(token, mp);
                        return true;
                    });
            overlayPlayer.prepare();
            overlayPlayer.start();
            return token;
        } catch (IOException | IllegalStateException e) {
            Log.e(TAG, "Unable to play overlay asset " + assetName, e);
            releaseOverlayPlayer(token, overlayPlayer);
            return 0L;
        }
    }

    @Override
    public boolean stopAudioOverlayPlayback(long playbackToken) {
        MediaPlayer overlayPlayer;
        synchronized (overlayPlayers) {
            overlayPlayer = overlayPlayers.remove(playbackToken);
        }
        if (overlayPlayer == null) {
            return false;
        }
        stopAndRelease(overlayPlayer);
        return true;
    }

    private void releaseOverlayPlayer(long token, MediaPlayer overlayPlayer) {
        synchronized (overlayPlayers) {
            if (overlayPlayers.get(token) != overlayPlayer) {
                return;
            }
            overlayPlayers.remove(token);
        }
        overlayPlayer.release();
    }

    private static void stopAndRelease(MediaPlayer player) {
        try {
            if (player.isPlaying()) {
                player.stop();
            }
        } catch (IllegalStateException ignored) {
            // Player was already terminal.
        }
        player.release();
    }

    private void stopAllAudioOverlayPlayback() {
        MediaPlayer[] players;
        synchronized (overlayPlayers) {
            players = overlayPlayers.values().toArray(new MediaPlayer[0]);
            overlayPlayers.clear();
        }
        for (MediaPlayer player : players) {
            stopAndRelease(player);
        }
    }

    @Override
    public void stopAudioPlayback() {
        if (mediaPlayer != null) {
            try {
                if (mediaPlayer.isPlaying()) {
                    mediaPlayer.stop();
                }
            } catch (IllegalStateException ignored) {
                // ignore
            }
            mediaPlayer.release();
            mediaPlayer = null;
        }
    }

    @Override
    public void setTransport(ICompanionTransport transport) {
        // Standard Android devices don't use UART RGB LED path
    }

    // ============================================
    // MTK LED Brightness Control (Not Supported)
    // ============================================

    @Override
    public boolean supportsLedBrightness() {
        return false;
    }

    @Override
    public void setRecordingLedBrightness(int percent) {
        Log.w(TAG, "LED brightness not supported on this device");
    }

    @Override
    public void setRecordingLedBrightness(int percent, int durationMs) {
        Log.w(TAG, "LED brightness not supported on this device");
    }

    @Override
    public int getRecordingLedBrightness() {
        return 0;
    }

    // ============================================
    // RGB LED Control (Not Supported)
    // ============================================

    @Override
    public boolean supportsRgbLed() {
        return false;
    }

    @Override
    public void setRgbLedBrightness(int brightness) {
        Log.w(TAG, "RGB LED not supported on this device");
    }

    @Override
    public void setRgbLedOn(int ledIndex, int ontime, int offtime, int count) {
        Log.w(TAG, "RGB LED not supported on this device");
    }

    @Override
    public void setRgbLedOn(int ledIndex, int ontime, int offtime, int count, int brightness) {
        Log.w(TAG, "RGB LED not supported on this device");
    }

    @Override
    public void setRgbLedOff() {
        Log.w(TAG, "RGB LED not supported on this device");
    }

    @Override
    public void flashRgbLedWhite(int durationMs) {
        Log.w(TAG, "RGB LED not supported on this device");
    }

    @Override
    public void flashRgbLedWhite(int durationMs, int brightness) {
        Log.w(TAG, "RGB LED not supported on this device");
    }

    @Override
    public void setRgbLedSolidWhite(int durationMs) {
        Log.w(TAG, "RGB LED not supported on this device");
    }

    // ============================================
    // Battery Status (Android BatteryManager)
    // ============================================

    @Override
    public int getBatteryLevel() {
        BatteryManager batteryManager =
                (BatteryManager) context.getSystemService(Context.BATTERY_SERVICE);
        if (batteryManager != null) {
            int level = batteryManager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY);
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
            boolean isCharging =
                    status == BatteryManager.BATTERY_STATUS_CHARGING
                            || status == BatteryManager.BATTERY_STATUS_FULL;
            Log.d(TAG, "🔋 Charging status: " + isCharging);
            return isCharging;
        }
        Log.w(TAG, "🔋 Battery status not available");
        return false;
    }

    @Override
    public void setRgbLedSolidWhite(int durationMs, int brightness) {
        Log.w(TAG, "RGB LED not supported on this device");
    }

    @Override
    public void shutdown() {
        stopTorch();
        stopAudioPlayback();
        stopAllAudioOverlayPlayback();
        super.shutdown();
    }

    private void detectFlashCamera() {
        if (cameraManager == null) {
            return;
        }
        try {
            for (String id : cameraManager.getCameraIdList()) {
                CameraCharacteristics characteristics = cameraManager.getCameraCharacteristics(id);
                Boolean flashAvailable =
                        characteristics.get(CameraCharacteristics.FLASH_INFO_AVAILABLE);
                Integer lensFacing = characteristics.get(CameraCharacteristics.LENS_FACING);
                if (Boolean.TRUE.equals(flashAvailable)
                        && lensFacing != null
                        && lensFacing == CameraCharacteristics.LENS_FACING_BACK) {
                    cameraWithFlash = id;
                    Log.d(TAG, "Detected back camera with flash: " + id);
                    return;
                }
            }
        } catch (CameraAccessException e) {
            Log.e(TAG, "Unable to query cameras for torch support", e);
        }
    }

    private void setTorch(boolean enabled) {
        if (cameraManager == null || cameraWithFlash == null) {
            Log.w(TAG, "Torch control not available");
            return;
        }
        try {
            cameraManager.setTorchMode(cameraWithFlash, enabled);
            torchEnabled = enabled;
        } catch (CameraAccessException | SecurityException e) {
            Log.e(TAG, "Failed to set torch state", e);
        }
    }

    private void stopTorch() {
        if (torchEnabled) {
            setTorch(false);
        }
    }
}
