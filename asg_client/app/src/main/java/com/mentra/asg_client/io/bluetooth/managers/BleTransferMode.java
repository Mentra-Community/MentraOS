package com.mentra.asg_client.io.bluetooth.managers;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.util.Log;
import androidx.core.content.ContextCompat;

/**
 * Runtime toggle for BLE file transfer optimizations (Phase 1).
 *
 * <p>Modes:
 * <ul>
 *   <li>OPTIMIZED — event-driven TX pump, single ACK watchdog, fast UART recv, 75ms pre-delay
 *   <li>LEGACY    — original stop-and-wait per-packet timer, 200ms pre-delay
 * </ul>
 *
 * <p>Toggle via ADB (no reinstall required):
 * <pre>
 *   # Enable Phase 1 optimizations (default)
 *   adb shell am broadcast -a com.mentra.BLE_TRANSFER_MODE --es mode OPTIMIZED
 *
 *   # Revert to legacy behavior for A/B comparison
 *   adb shell am broadcast -a com.mentra.BLE_TRANSFER_MODE --es mode LEGACY
 *
 *   # Query current mode
 *   adb shell am broadcast -a com.mentra.BLE_TRANSFER_MODE --es mode QUERY
 * </pre>
 */
public class BleTransferMode {

    public static final String TAG = "BleTransferMode";
    public static final String ACTION = "com.mentra.BLE_TRANSFER_MODE";
    public static final String EXTRA_MODE = "mode";

    public enum Mode {
        OPTIMIZED, LEGACY
    }

    private static volatile Mode current = Mode.OPTIMIZED;
    private static volatile boolean receiverRegistered = false;

    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------

    public static boolean isOptimized() {
        return current == Mode.OPTIMIZED;
    }

    public static Mode get() {
        return current;
    }

    public static void set(Mode mode) {
        current = mode;
        Log.i(TAG, "BLE transfer mode set to: " + mode);
    }

    /** Pre-transfer delay in ms — 75ms (optimized) vs 200ms (legacy). */
    public static int preTransferDelayMs() {
        return current == Mode.OPTIMIZED ? 75 : 200;
    }

    /** Register the ADB-broadcast receiver. Call once from K900BluetoothManager constructor. */
    public static void registerReceiver(Context context) {
        if (receiverRegistered) return;
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                if (!ACTION.equals(intent.getAction())) return;
                String modeStr = intent.getStringExtra(EXTRA_MODE);
                if ("QUERY".equalsIgnoreCase(modeStr)) {
                    Log.i(TAG, "Current BLE transfer mode: " + current);
                    return;
                }
                try {
                    Mode m = Mode.valueOf(modeStr != null ? modeStr.toUpperCase() : "");
                    set(m);
                } catch (IllegalArgumentException e) {
                    Log.w(TAG, "Unknown mode '" + modeStr + "'. Use OPTIMIZED or LEGACY.");
                }
            }
        };
        ContextCompat.registerReceiver(
                context,
                receiver,
                new IntentFilter(ACTION),
                ContextCompat.RECEIVER_EXPORTED);
        receiverRegistered = true;
        Log.i(TAG, "BleTransferMode receiver registered. Current mode: " + current);
    }
}
