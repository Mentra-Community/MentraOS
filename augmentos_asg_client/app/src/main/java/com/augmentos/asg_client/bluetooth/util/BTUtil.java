package com.augmentos.asg_client.bluetooth.util;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import androidx.core.app.ActivityCompat;

/**
 * Utility class for controlling Bluetooth state
 */
public class BTUtil {
    private static final String TAG = "BTUtil";
    
    /**
     * Attempts to enable Bluetooth
     * 
     * @param context The application context
     * @return true if Bluetooth is enabled or was successfully enabled, false otherwise
     */
    public static boolean openBluetooth(Context context) {
        try {
            // Get the Bluetooth adapter
            BluetoothManager bluetoothManager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
            if (bluetoothManager == null) {
                Log.e(TAG, "BluetoothManager not available");
                return false;
            }
            
            BluetoothAdapter bluetoothAdapter = bluetoothManager.getAdapter();
            if (bluetoothAdapter == null) {
                Log.e(TAG, "BluetoothAdapter not available");
                return false;
            }
            
            // Check if Bluetooth is already enabled
            if (bluetoothAdapter.isEnabled()) {
                Log.d(TAG, "Bluetooth is already enabled");
                return true;
            }
            
            // Check for permissions on Android 12+ (API 31+)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (ActivityCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) 
                    != PackageManager.PERMISSION_GRANTED) {
                    Log.e(TAG, "Missing BLUETOOTH_CONNECT permission");
                    return false;
                }
            }
            
            // Try to enable Bluetooth
            boolean success = bluetoothAdapter.enable();
            Log.d(TAG, "Attempt to enable Bluetooth result: " + success);
            return success;
            
        } catch (Exception e) {
            Log.e(TAG, "Error enabling Bluetooth", e);
            return false;
        }
    }
    
    /**
     * Attempts to disable Bluetooth
     * 
     * @param context The application context
     * @return true if Bluetooth is disabled or was successfully disabled, false otherwise
     */
    public static boolean closeBluetooth(Context context) {
        try {
            // Get the Bluetooth adapter
            BluetoothManager bluetoothManager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
            if (bluetoothManager == null) {
                Log.e(TAG, "BluetoothManager not available");
                return false;
            }
            
            BluetoothAdapter bluetoothAdapter = bluetoothManager.getAdapter();
            if (bluetoothAdapter == null) {
                Log.e(TAG, "BluetoothAdapter not available");
                return false;
            }
            
            // Check if Bluetooth is already disabled
            if (!bluetoothAdapter.isEnabled()) {
                Log.d(TAG, "Bluetooth is already disabled");
                return true;
            }
            
            // Check for permissions on Android 12+ (API 31+)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (ActivityCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) 
                    != PackageManager.PERMISSION_GRANTED) {
                    Log.e(TAG, "Missing BLUETOOTH_CONNECT permission");
                    return false;
                }
            }
            
            // Try to disable Bluetooth
            boolean success = bluetoothAdapter.disable();
            Log.d(TAG, "Attempt to disable Bluetooth result: " + success);
            return success;
            
        } catch (Exception e) {
            Log.e(TAG, "Error disabling Bluetooth", e);
            return false;
        }
    }
}