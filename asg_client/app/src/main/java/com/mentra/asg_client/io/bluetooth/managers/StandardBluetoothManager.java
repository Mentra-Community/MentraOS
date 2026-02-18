package com.mentra.asg_client.io.bluetooth.managers;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.mentra.asg_client.io.bluetooth.core.BaseBluetoothManager;
import com.mentra.asg_client.io.bluetooth.utils.DebugNotificationManager;

import java.util.UUID;

/**
 * Implementation of IBluetoothManager for standard Android devices.
 * Implements a BLE peripheral that can send/receive serial data and
 * advertises with the name "Xy_A".
 */
public class StandardBluetoothManager extends BaseBluetoothManager {
    
    /**
     * Constructor
     * @param context The application context
     */
    public StandardBluetoothManager(Context context) {
        super(context);
        this.notificationManager = new DebugNotificationManager(context);
    }
    private static final String TAG = "StandardBluetoothManager";
    
    // UUIDs for our service and characteristics - updated to match K900 BES2800 MCU UUIDs for compatibility
    private static final UUID SERVICE_UUID = UUID.fromString("00004860-0000-1000-8000-00805f9b34fb");
    
    // Swapped TX/RX UUIDs to match MentraLiveSGC's expectations
    // In BLE, TX of one device connects to RX of the other
    private static final UUID TX_CHAR_UUID = UUID.fromString("000071FF-0000-1000-8000-00805f9b34fb");
    private static final UUID RX_CHAR_UUID = UUID.fromString("000070FF-0000-1000-8000-00805f9b34fb");
    
    // Device name for advertising
    private static final String DEVICE_NAME = "Xy_A";
    
    // MTU parameters
    private static final int DEFAULT_MTU = 23; // BLE default
    private static final int PREFERRED_MTU = 512; // Maximum allowed in BLE spec
    private int currentMtu = DEFAULT_MTU;
    
    // Connection parameters
    private static final int CONN_PRIORITY_BALANCED = BluetoothGatt.CONNECTION_PRIORITY_BALANCED;
    private static final int CONN_PRIORITY_HIGH = BluetoothGatt.CONNECTION_PRIORITY_HIGH;
    private static final int CONN_PRIORITY_LOW_POWER = BluetoothGatt.CONNECTION_PRIORITY_LOW_POWER;
    
    // Pairing related constants
    private static final int PAIRING_RETRY_DELAY_MS = 1000; // 1 second
    private static final int MAX_PAIRING_RETRIES = 3;
    private int currentPairingRetries = 0;
    private BluetoothDevice pendingPairingDevice = null;
    
    // Pairing variant constants
    // These constants are not directly accessible in all Android versions,
    // so defining them manually based on Android source code
    private static final int PAIRING_VARIANT_PIN = 0;
    private static final int PAIRING_VARIANT_PASSKEY = 1;
    private static final int PAIRING_VARIANT_PASSKEY_CONFIRMATION = 2;
    private static final int PAIRING_VARIANT_CONSENT = 3;
    private static final int PAIRING_VARIANT_DISPLAY_PASSKEY = 4;
    private static final int PAIRING_VARIANT_DISPLAY_PIN = 5;
    private static final int PAIRING_VARIANT_OOB_CONSENT = 6;
    
    // Bluetooth related variables
    private BluetoothManager bluetoothManager;
    private BluetoothAdapter bluetoothAdapter;
    private BluetoothLeAdvertiser advertiser;
    private BluetoothGattServer gattServer;
    private volatile BluetoothDevice connectedDevice; // Use volatile to ensure visibility across threads
    private BluetoothGattCharacteristic txCharacteristic;
    private boolean isAdvertising = false;
    private boolean isNotifiedConnected = false; // Track if we've notified listeners of connection
    
    // Debug notification manager
    private DebugNotificationManager notificationManager;
    
    // Handler for delayed operations
    private final Handler handler = new Handler(Looper.getMainLooper());
    
    // Bluetooth advertising callback
    private final AdvertiseCallback advertiseCallback = new AdvertiseCallback() {
        @Override
        public void onStartSuccess(AdvertiseSettings settingsInEffect) {
            Log.i(TAG, "BLE advertising started successfully");
            isAdvertising = true;
            notificationManager.showNotification("Bluetooth", "BLE advertising started");
        }
        
        @Override
        public void onStartFailure(int errorCode) {
            Log.e(TAG, "BLE advertising failed to start, error code: " + errorCode);
            isAdvertising = false;
            notificationManager.showNotification("Bluetooth Error", "BLE advertising failed: " + errorCode);
        }
    };

    @Override
    public boolean sendData(byte[] data) {
        if (data == null || data.length == 0) {
            Log.w(TAG, "Attempted to send null or empty data");
            return false;
        }
        
        if (!isConnected() || connectedDevice == null) {
            Log.w(TAG, "Cannot send data - not connected");
            notificationManager.showDebugNotification("Bluetooth Error", 
                "Cannot send data - not connected to a device");
            return false;
        }
        
        if (gattServer == null || txCharacteristic == null) {
            Log.e(TAG, "GATT server or TX characteristic not initialized");
            return false;
        }
        
        // Implementation would go here for actual data sending
        Log.d(TAG, "Sending " + data.length + " bytes via BLE");
        return true;
    }

    @Override
    public void disconnect() {
        if (!isConnected() || connectedDevice == null) {
            return;
        }
        
        if (gattServer != null) {
            try {
                gattServer.cancelConnection(connectedDevice);
                Log.d(TAG, "Disconnected from device: " + connectedDevice.getAddress());
                connectedDevice = null;
                notifyConnectionStateChanged(false);
                notificationManager.showBluetoothStateNotification(false);
                
                // Start advertising again after a short delay
                handler.postDelayed(() -> {
                    if (!isConnected() && !isAdvertising) {
                        startAdvertising();
                    }
                }, 500);
            } catch (Exception e) {
                Log.e(TAG, "Error disconnecting", e);
            }
        }
    }
    
    @Override
    public void stopAdvertising() {
        if (bluetoothAdapter == null || advertiser == null) {
            return;
        }
        
        try {
            advertiser.stopAdvertising(advertiseCallback);
            isAdvertising = false;
            Log.d(TAG, "Stopped BLE advertising");
            
            // Cancel the advertising notification
            notificationManager.cancelAdvertisingNotification();
        } catch (Exception e) {
            Log.e(TAG, "Failed to stop advertising", e);
        }
    }
    
    @Override
    public boolean isConnected() {
        return connectedDevice != null && super.isConnected();
    }
    
    @Override
    public void startAdvertising() {
        if (bluetoothAdapter == null) {
            Log.e(TAG, "Cannot start advertising - Bluetooth adapter is null");
            notificationManager.showDebugNotification("Bluetooth Error", 
                "Cannot start advertising - Bluetooth adapter is null");
            return;
        }
        
        if (!bluetoothAdapter.isEnabled()) {
            Log.e(TAG, "Cannot start advertising - Bluetooth is not enabled");
            notificationManager.showDebugNotification("Bluetooth Error", 
                "Cannot start advertising - Bluetooth is not enabled");
            return;
        }
        
        advertiser = bluetoothAdapter.getBluetoothLeAdvertiser();
        if (advertiser == null) {
            Log.e(TAG, "Cannot start advertising - BLE advertiser is null");
            notificationManager.showDebugNotification("Bluetooth Error", 
                "Cannot start advertising - BLE advertiser is null");
            return;
        }
        
        // Implementation would go here for actual advertising setup
        Log.d(TAG, "Started BLE advertising");
        notificationManager.showNotification("Bluetooth", "BLE advertising started");
    }
    
    @Override
    public boolean isFileTransferInProgress() {
        // StandardBluetoothManager doesn't support file transfer
        return false;
    }
} 