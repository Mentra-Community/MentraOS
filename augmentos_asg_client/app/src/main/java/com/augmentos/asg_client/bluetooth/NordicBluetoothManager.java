package com.augmentos.asg_client.bluetooth;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Log;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import android.Manifest;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothProfile;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.ActivityCompat;

import no.nordicsemi.android.ble.BleServerManager;
import no.nordicsemi.android.ble.observer.ServerObserver;

/**
 * Implementation of IBluetoothManager for standard Android devices using native Android BLE APIs.
 * Implements a BLE peripheral that can send/receive serial data and advertises with the name "Xy_A".
 */
public class NordicBluetoothManager extends BaseBluetoothManager {
    private static final String TAG = "NordicBluetoothManager";
    
    // Updated UUIDs to match K900 BES2800 MCU for compatibility
    private static final UUID SERVICE_UUID = UUID.fromString("00004860-0000-1000-8000-00805f9b34fb");
    private static final UUID TX_CHAR_UUID = UUID.fromString("000070FF-0000-1000-8000-00805f9b34fb");
    private static final UUID RX_CHAR_UUID = UUID.fromString("000071FF-0000-1000-8000-00805f9b34fb");
    
    // Device name for advertising
    private static final String DEVICE_NAME = "Xy_A";
    
    // Debug notification manager
    private DebugNotificationManager notificationManager;
    
    // Bluetooth components
    private BluetoothManager bluetoothManager;
    private BluetoothAdapter bluetoothAdapter;
    private BluetoothLeAdvertiser advertiser;
    
    // Nordic BLE server manager
    private ASGServerManager bleManager;
    private Handler mainHandler = new Handler(Looper.getMainLooper());
    
    // State tracking
    private List<BluetoothDevice> connectedDevices = new ArrayList<>();
    private boolean isAdvertising = false;
    
    // Advertising callback
    private AdvertiseCallback advertiseCallback = new AdvertiseCallback() {
        @Override
        public void onStartSuccess(AdvertiseSettings settingsInEffect) {
            Log.d(TAG, "BLE advertising started successfully");
            isAdvertising = true;
            notificationManager.showAdvertisingNotification(DEVICE_NAME);
        }

        @Override
        public void onStartFailure(int errorCode) {
            Log.e(TAG, "BLE advertising failed to start, error: " + errorCode);
            isAdvertising = false;
            notificationManager.showDebugNotification("Bluetooth Error", 
                "Failed to start advertising, error: " + errorCode);
        }
    };
    
    /**
     * Create a new NordicBluetoothManager
     * @param context The application context
     */
    public NordicBluetoothManager(Context context) {
        super(context);
        
        // Enhanced debug logging
        Log.e(TAG, "######################################################");
        Log.e(TAG, "## NordicBluetoothManager CONSTRUCTOR CALLED");
        Log.e(TAG, "## Class name: " + this.getClass().getName());
        Log.e(TAG, "## Thread ID: " + Thread.currentThread().getId());
        Log.e(TAG, "######################################################");
        
        // Create the notification manager
        notificationManager = new DebugNotificationManager(context);
        notificationManager.showDeviceTypeNotification(false);
        
        // Get the Bluetooth manager and adapter
        bluetoothManager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        if (bluetoothManager != null) {
            bluetoothAdapter = bluetoothManager.getAdapter();
        }
        
        // Create the Nordic BLE server manager
        bleManager = new ASGServerManager(context);
        
        Log.d(TAG, "NordicBluetoothManager created successfully");
    }
    
    /**
     * Our custom BLE server manager implementation using Nordic's BLE library.
     */
    private class ASGServerManager extends BleServerManager implements ServerObserver {
        private BluetoothGattService service;
        private BluetoothGattCharacteristic txCharacteristic;
        private BluetoothGattCharacteristic rxCharacteristic;
        // Use CopyOnWriteArrayList for thread safety without explicit locks
        private final List<BluetoothDevice> connectedDevices = new java.util.concurrent.CopyOnWriteArrayList<>();
        // Track connected devices with a thread-safe set
        private final Set<BluetoothDevice> connectedDeviceSet = 
            Collections.newSetFromMap(new java.util.concurrent.ConcurrentHashMap<>());
        
        // Client characteristic configuration descriptor for notification support
        private final UUID CLIENT_CHAR_CONFIG_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
        // Connection state validation interval (ms)
        private static final long CONNECTION_VALIDATION_INTERVAL = 5000; // 5 seconds
        private Handler connectionValidationHandler = new Handler(Looper.getMainLooper());
        private Runnable connectionValidationRunnable;
        
        // Keep-alive mechanism
        private static final long KEEP_ALIVE_INTERVAL = 1000; // 1 second
        private Handler keepAliveHandler = new Handler(Looper.getMainLooper());
        private Runnable keepAliveRunnable;
        
        public ASGServerManager(Context context) {
            super(context);
            setServerObserver(this);
            
            // Initialize connection validation mechanism
            connectionValidationRunnable = new Runnable() {
                @Override
                public void run() {
                    validateConnections();
                    connectionValidationHandler.postDelayed(this, CONNECTION_VALIDATION_INTERVAL);
                }
            };
            
            // Initialize keep-alive mechanism
            keepAliveRunnable = new Runnable() {
                @Override
                public void run() {
                    sendKeepAlive();
                    keepAliveHandler.postDelayed(this, KEEP_ALIVE_INTERVAL);
                }
            };
            
            // Start connection validation
            connectionValidationHandler.postDelayed(connectionValidationRunnable, CONNECTION_VALIDATION_INTERVAL);
            
            // Start keep-alive
            keepAliveHandler.postDelayed(keepAliveRunnable, KEEP_ALIVE_INTERVAL);
            
            Log.d(TAG, "ASGServerManager initialized with connection validation and keep-alive");
        }
        
        /**
         * Send a keep-alive ping to all connected devices
         */
        private void sendKeepAlive() {
            if (connectedDevices.isEmpty()) {
                return;
            }
            
            try {
                // Simple keep-alive ping (1-byte)
                byte[] keepAlivePing = new byte[] { 0x00 };
                
                // Set the ping value on the characteristic
                txCharacteristic.setValue(keepAlivePing);
                
                // Get the GATT server to send notifications
                android.bluetooth.BluetoothGattServer gattServer = null;
                try {
                    // Attempt to get the GATT server by using reflection
                    java.lang.reflect.Method getServerMethod = BleServerManager.class.getDeclaredMethod("getBluetoothGattServer");
                    getServerMethod.setAccessible(true);
                    gattServer = (android.bluetooth.BluetoothGattServer) getServerMethod.invoke(this);
                } catch (Exception e) {
                    Log.e(TAG, "Could not access GATT server via reflection", e);
                    return;
                }
                
                if (gattServer == null) {
                    Log.e(TAG, "Failed to get GATT server, cannot send keep-alive");
                    return;
                }
                
                for (BluetoothDevice device : connectedDevices) {
                    Log.d(TAG, "Sending keep-alive ping to " + device.getAddress());
                    
                    // Send using direct GATT server call
                    boolean sent = gattServer.notifyCharacteristicChanged(device, txCharacteristic, false);
                    
                    if (!sent) {
                        Log.e(TAG, "Failed to send keep-alive ping to " + device.getAddress());
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "Error in keep-alive mechanism", e);
            }
        }
        
        /**
         * Validate all connections to ensure they're still active
         * This helps detect "ghost" connections that are no longer valid
         */
        private void validateConnections() {
            if (connectedDevices.isEmpty()) {
                return;
            }
            
            Log.d(TAG, "Validating " + connectedDevices.size() + " BLE connections");
            List<BluetoothDevice> devicesToRemove = new ArrayList<>();
            
            // Get the BluetoothManager to check connection state
            android.bluetooth.BluetoothManager btManager = 
                (android.bluetooth.BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
            
            for (BluetoothDevice device : connectedDevices) {
                try {
                    boolean isConnected = false;
                    
                    // Use BluetoothManager to check device connection state
                    if (btManager != null && checkPermission()) {
                        int state = btManager.getConnectionState(device, BluetoothProfile.GATT);
                        isConnected = (state == BluetoothProfile.STATE_CONNECTED);
                    }
                    
                    // Additional check - device should be in our tracking set
                    boolean inDeviceSet = connectedDeviceSet.contains(device);
                    
                    if (!isConnected || !inDeviceSet) {
                        Log.e(TAG, "❌ Detected ghost connection: " + device.getAddress());
                        Log.e(TAG, "❌ isConnected: " + isConnected + ", in device set: " + inDeviceSet);
                        devicesToRemove.add(device);
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error validating connection to " + device.getAddress(), e);
                    // If we get an exception, assume the device connection is invalid
                    devicesToRemove.add(device);
                }
            }
            
            // Remove any ghost connections
            for (BluetoothDevice device : devicesToRemove) {
                Log.e(TAG, "🧹 Removing ghost connection: " + device.getAddress());
                connectedDevices.remove(device);
                onDeviceDisconnectedFromServer(device);
            }
        }

        @Override
        protected List<BluetoothGattService> initializeServer() {
            // Create the GATT service with our characteristics
            service = new BluetoothGattService(SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY);
            
            // TX characteristic - for sending data to central (notify)
            txCharacteristic = new BluetoothGattCharacteristic(
                    TX_CHAR_UUID,
                    BluetoothGattCharacteristic.PROPERTY_READ | BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                    BluetoothGattCharacteristic.PERMISSION_READ);
            
            // CRITICAL FIX: Add Client Characteristic Configuration Descriptor (CCCD)
            // This descriptor is REQUIRED for notifications to work properly
            BluetoothGattDescriptor txDescriptor = new BluetoothGattDescriptor(
                    CLIENT_CHAR_CONFIG_UUID,
                    BluetoothGattDescriptor.PERMISSION_READ | BluetoothGattDescriptor.PERMISSION_WRITE);
            txCharacteristic.addDescriptor(txDescriptor);
            
            // RX characteristic - for receiving data from central (write)
            rxCharacteristic = new BluetoothGattCharacteristic(
                    RX_CHAR_UUID,
                    BluetoothGattCharacteristic.PROPERTY_WRITE | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
                    BluetoothGattCharacteristic.PERMISSION_WRITE);
            
            // Add characteristics to service
            service.addCharacteristic(txCharacteristic);
            service.addCharacteristic(rxCharacteristic);
            
            // Log detailed server configuration
            Log.d(TAG, "BLE Server initialized with Service UUID: " + SERVICE_UUID);
            Log.d(TAG, "TX Characteristic UUID: " + TX_CHAR_UUID + " (for notifications)");
            Log.d(TAG, "RX Characteristic UUID: " + RX_CHAR_UUID + " (for receiving data)");
            Log.d(TAG, "Added CCCD to TX characteristic for proper notification support");
            
            // Return a list of services
            return Collections.singletonList(service);
        }
        
        @Override
        public void onServerReady() {
            Log.d(TAG, "Nordic BLE server is ready");
            
            // Start advertising now that the server is ready
            startAdvertising();
        }

        @Override
        public void onDeviceConnectedToServer(BluetoothDevice device) {
            Log.e(TAG, "⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐");
            Log.e(TAG, "⭐ DEVICE CONNECTED: " + device.getAddress());
            Log.e(TAG, "⭐ Thread ID: " + Thread.currentThread().getId());
            Log.e(TAG, "⭐ Before connection - connected devices: " + connectedDevices.size());
            
            // Fix for possible duplicates - check if already exists (thread-safe with CopyOnWriteArrayList)
            boolean deviceAlreadyConnected = false;
            for (BluetoothDevice existingDevice : connectedDevices) {
                if (existingDevice.getAddress().equals(device.getAddress())) {
                    Log.e(TAG, "⭐ WEIRD: Device already in connected list: " + device.getAddress());
                    deviceAlreadyConnected = true;
                    break;
                }
            }
            
            if (!deviceAlreadyConnected) {
                // CopyOnWriteArrayList is thread-safe, no need for explicit locking
                connectedDevices.add(device);
                Log.e(TAG, "⭐ Added device to connected list: " + device.getAddress());
                
                // Track this device in our connected set for additional verification
                connectedDeviceSet.add(device);
                Log.e(TAG, "⭐ Added device to connected device set: " + device.getAddress());
            }
            
            Log.e(TAG, "⭐ After connection - connected devices: " + connectedDevices.size());
            Log.e(TAG, "⭐ hasConnectedDevices() returns: " + hasConnectedDevices());
            
            // Verify list integrity after adding
            if (connectedDevices.isEmpty()) {
                Log.e(TAG, "⭐ CRITICAL ERROR: Connection list is empty right after adding device!");
                Exception stackTrace = new Exception("Stack trace for empty list after add");
                stackTrace.printStackTrace();
            }
            Log.e(TAG, "⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐⭐");
            
            // Notify the manager about the connection
            notifyConnectionStateChanged(true);
            notificationManager.showBluetoothStateNotification(true);
            
            // Stop advertising when connected
            stopAdvertising();
        }

        @Override
        public void onDeviceDisconnectedFromServer(BluetoothDevice device) {
            // Get thread ID for consistent logging
            long threadId = Thread.currentThread().getId();
            
            Log.e(TAG, "🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴");
            Log.e(TAG, "🔴 Thread-" + threadId + ": DEVICE DISCONNECTED: " + device.getAddress());
            Log.e(TAG, "🔴 Thread-" + threadId + ": Thread name: " + Thread.currentThread().getName());
            Log.e(TAG, "🔴 Thread-" + threadId + ": Current stack trace:");
            Exception e = new Exception("Disconnection stack trace");
            e.printStackTrace();
            Log.e(TAG, "🔴 Thread-" + threadId + ": Before disconnection - connected devices: " + connectedDevices.size());
            
            // Sync on the list during the disconnection operation to prevent race conditions
            synchronized(connectedDevices) {
                // Debugger for each device
                if (!connectedDevices.isEmpty()) {
                    Log.e(TAG, "🔴 Thread-" + threadId + ": Current connected devices:");
                    for (BluetoothDevice existingDevice : connectedDevices) {
                        Log.e(TAG, "🔴 Thread-" + threadId + ":   - " + existingDevice.getAddress());
                    }
                }
                
                boolean wasRemoved = false;
                BluetoothDevice deviceToRemove = null;
                
                try {
                    // First try direct removal (CopyOnWriteArrayList is thread-safe, but we add an extra sync block)
                    wasRemoved = connectedDevices.remove(device);
                    
                    // If direct removal failed, try by address
                    if (!wasRemoved) {
                        Log.e(TAG, "🔴 Thread-" + threadId + ": Direct remove failed, trying to remove by address");
                        for (BluetoothDevice existingDevice : connectedDevices) {
                            if (existingDevice.getAddress().equals(device.getAddress())) {
                                deviceToRemove = existingDevice;
                                break;
                            }
                        }
                        
                        if (deviceToRemove != null) {
                            wasRemoved = connectedDevices.remove(deviceToRemove);
                            Log.e(TAG, "🔴 Thread-" + threadId + ": Removed device by address matching: " + wasRemoved);
                        } else {
                            Log.e(TAG, "🔴 Thread-" + threadId + ": ERROR: Device not found in list by address!");
                        }
                    } else {
                        Log.e(TAG, "🔴 Thread-" + threadId + ": Removed device using direct removal");
                    }
                } catch (Exception ex) {
                    Log.e(TAG, "🔴 Thread-" + threadId + ": EXCEPTION during device removal:", ex);
                }
                
                Log.e(TAG, "🔴 Thread-" + threadId + ": After disconnection - connected devices: " + connectedDevices.size());
                Log.e(TAG, "🔴 Thread-" + threadId + ": hasConnectedDevices() returns: " + hasConnectedDevices());
                Log.e(TAG, "🔴 Thread-" + threadId + ": Was device correctly removed: " + wasRemoved);
            }
            
            Log.e(TAG, "🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴🔴");
            
            // Also remove from the connected device set
            connectedDeviceSet.remove(device);
            Log.e(TAG, "Thread-" + threadId + ": Removed device from connected device set");
            
            // Notify the manager about the disconnection
            notifyConnectionStateChanged(false);
            notificationManager.showBluetoothStateNotification(false);
            
            // Start advertising again after a delay
            mainHandler.postDelayed(() -> {
                if (connectedDevices.isEmpty()) {
                    startAdvertising();
                }
            }, 500);
        }
        
        /**
         * Send data to all connected devices
         */
        public boolean sendData(byte[] data) {
            if (connectedDevices.isEmpty() || txCharacteristic == null) {
                Log.e(TAG, "Cannot send data: No connected devices or TX characteristic is null");
                return false;
            }
            
            boolean success = true;
            int deviceCount = 0;
            
            // Get thread ID for consistent logging
            long threadId = Thread.currentThread().getId();
            
            // Log sending attempt
            //Log.e(TAG, "Thread-" + threadId + ": 📤 Sending " + data.length + " bytes to " +
            //      connectedDevices.size() + " devices");
            
            // Log first bytes for debugging
            if (data.length > 0) {
                StringBuilder hexDump = new StringBuilder();
                for (int i = 0; i < Math.min(data.length, 16); i++) {
                    hexDump.append(String.format("%02X ", data[i]));
                }
                //Log.e(TAG, "Thread-" + threadId + ": 📤 First 16 bytes: " + hexDump.toString());
            }
            
            // Get the GATT server from BleManager's parent class
            android.bluetooth.BluetoothGattServer gattServer = null;
            try {
                // Access the openGattServer method from parent class
                java.lang.reflect.Method getServerMethod = BleServerManager.class.getDeclaredMethod("getBluetoothGattServer");
                getServerMethod.setAccessible(true);
                gattServer = (android.bluetooth.BluetoothGattServer) getServerMethod.invoke(this);
            } catch (Exception e) {
                Log.e(TAG, "Thread-" + threadId + ": Cannot access GATT server", e);
            }
            
            if (gattServer == null) {
                Log.e(TAG, "Thread-" + threadId + ": ❌ Cannot send data - gattServer is null");
                return false;
            }
            
            // Set the value on the characteristic
            txCharacteristic.setValue(data);
            
            for (BluetoothDevice device : connectedDevices) {
                deviceCount++;
                try {
                    if (checkPermission()) {
                        // Call the Android BluetoothGattServer directly to send notification
                        boolean notifyResult = gattServer.notifyCharacteristicChanged(device, txCharacteristic, false);
                        
                        // Log detailed notification status
                        if (notifyResult) {
                            //Log.d(TAG, "Thread-" + threadId + ": ✅ Notification sent to device " + device.getAddress());
                        } else {
                            Log.e(TAG, "Thread-" + threadId + ": ❌ Failed to send notification to device: " + device.getAddress());
                            success = false;
                        }
                    } else {
                        Log.e(TAG, "Thread-" + threadId + ": ❌ Missing Bluetooth permissions");
                        success = false;
                    }
                } catch (Exception e) {
                    success = false;
                    Log.e(TAG, "Thread-" + threadId + ": ❌ Error sending notification to device " + device.getAddress(), e);
                }
            }
            
            if (deviceCount == 0) {
                Log.e(TAG, "Thread-" + threadId + ": No devices in connectedDevices list to send to");
                return false;
            }
            
            return success;
        }
        
        /**
         * Get the MTU size (simplified for now)
         */
        public int getMtu() {
            // For now, to avoid issues, return a reasonable fixed size
            return 247; // Maximum Android MTU
        }
        
        /**
         * Get the first connected device
         */
        public BluetoothDevice getConnectedDevice() {
            // CopyOnWriteArrayList is thread-safe
            if (connectedDevices.isEmpty()) {
                Log.d(TAG, "getConnectedDevice() - No connected devices, returning null");
                return null;
            }
            Log.d(TAG, "getConnectedDevice() - Returning device: " + connectedDevices.get(0).getAddress());
            return connectedDevices.get(0);
        }
        
        /**
         * Check if any devices are connected
         */
        public boolean hasConnectedDevices() {
            // Get thread ID for debugging
            long threadId = Thread.currentThread().getId();
            
            // CopyOnWriteArrayList is thread-safe
            boolean hasDevices = !connectedDevices.isEmpty();
            Log.d(TAG, "Thread-" + threadId + ": hasConnectedDevices() called - returning: " + hasDevices + 
                  " (list size: " + connectedDevices.size() + ")");
            
            // Debug - dump stack trace when this returns false
            if (!hasDevices) {
                Exception e = new Exception("Stack trace when hasConnectedDevices() is false");
                Log.e(TAG, "Thread-" + threadId + ": Empty connected devices list detected - stack trace:", e);
                
                // Log thread state for debugging
                Log.e(TAG, "Thread-" + threadId + ": Current thread: " + Thread.currentThread().getName());
                
                // Get all stack traces for analysis
                Map<Thread, StackTraceElement[]> allStackTraces = Thread.getAllStackTraces();
                Log.e(TAG, "Thread-" + threadId + ": All running threads (" + allStackTraces.size() + "):");
                for (Map.Entry<Thread, StackTraceElement[]> entry : allStackTraces.entrySet()) {
                    Thread thread = entry.getKey();
                    Log.e(TAG, "Thread-" + threadId + ": Thread: " + thread.getId() + " (" + thread.getName() + ")");
                }
            }
            return hasDevices;
        }
        
        /**
         * Get the number of connected devices (used for debugging)
         */
        public int getConnectedDevicesCount() {
            // Safely return the size of the list
            return connectedDevices != null ? connectedDevices.size() : 0;
        }
    };
    
    /**
     * Check for Bluetooth permissions
     */
    private boolean checkPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return ActivityCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) 
                == PackageManager.PERMISSION_GRANTED;
        } else {
            return true; // Prior to Android 12, the normal BLUETOOTH permission was enough
        }
    }
    
    @Override
    public void initialize() {
        super.initialize();
        
        try {
            // Open the BLE server manager
            bleManager.open();
            Log.d(TAG, "BLE server manager opened");
        } catch (Exception e) {
            Log.e(TAG, "Error opening BLE server manager", e);
            notificationManager.showDebugNotification("Bluetooth Error", 
                "Failed to initialize BLE server: " + e.getMessage());
        }
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
            Log.e(TAG, "This device does not support BLE advertising");
            notificationManager.showDebugNotification("Bluetooth Error", 
                "This device does not support BLE advertising");
            return;
        }
        
        try {
            // Set up advertising settings
            AdvertiseSettings settings = new AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
                .setConnectable(true)
                .setTimeout(0) // 0 = no timeout
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
                .build();
            
            // Set up advertising data - include the device name
            AdvertiseData advertiseData = new AdvertiseData.Builder()
                .setIncludeDeviceName(true) // This will include "Xy_A"
                .setIncludeTxPowerLevel(false)
                .addServiceUuid(new ParcelUuid(SERVICE_UUID))
                .build();
            
            // Start advertising
            advertiser.startAdvertising(settings, advertiseData, advertiseCallback);
            Log.d(TAG, "Started BLE advertising");
        } catch (Exception e) {
            Log.e(TAG, "Failed to start advertising", e);
            notificationManager.showDebugNotification("Bluetooth Error", 
                "Failed to start advertising: " + e.getMessage());
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
    public boolean sendData(byte[] data) {
        if (data == null || data.length == 0) {
            Log.w(TAG, "Attempted to send null or empty data");
            return false;
        }
        
        // Extra safety check - make double sure we're connected
        boolean connected = isConnected();
        boolean managerExists = bleManager != null;
        boolean hasConnectedDevices = managerExists && bleManager.hasConnectedDevices();
        
        if (!connected || !hasConnectedDevices) {
            Log.e(TAG, "⛔ SEND DATA CANCELLED - Connection issues detected");
            Log.e(TAG, "⛔ isConnected(): " + connected);
            Log.e(TAG, "⛔ bleManager exists: " + managerExists);
            Log.e(TAG, "⛔ hasConnectedDevices: " + hasConnectedDevices);
            Log.e(TAG, "⛔ Stack trace for diagnosis:");
            new Exception("Connection issue stack trace").printStackTrace();
            
            notificationManager.showDebugNotification("Bluetooth Error", 
                "Cannot send data - connection issue detected");
            return false;
        }
        
        // Check data size vs MTU
        int mtu = bleManager.getMtu();
        int effectiveMtu = mtu - 3; // BLE overhead
        
        if (data.length > effectiveMtu) {
            Log.w(TAG, "⚠️ Data exceeds MTU size (" + data.length + " > " + effectiveMtu + " bytes)");
            Log.d(TAG, "Nordic BLE library will handle packet fragmentation automatically");
            
            // For LC3 audio specifically, provide detailed diagnostics
            if (data.length > 0 && (data[0] == (byte)0xA0 || (data[0] & 0xFF) == 0xA0 || data[0] == -96)) {
                Log.e(TAG, "🎵 LC3 AUDIO PACKET detected (" + data.length + " bytes)");
                
                StringBuilder hexDump = new StringBuilder();
                for (int i = 0; i < Math.min(data.length, 32); i++) {
                    hexDump.append(String.format("%02X ", data[i]));
                }
                Log.e(TAG, "🔍 First 32 bytes: " + hexDump);
                
                notificationManager.showDebugNotification("LC3 Audio Packet", 
                    "LC3 audio packet (" + data.length + " bytes) will be fragmented by the BLE library");
            }
        }
        
        boolean success = false;
        try {
            // Send the data with a retry mechanism
            for (int attempt = 0; attempt < 2; attempt++) {
                // Double check before each attempt
                if (!bleManager.hasConnectedDevices()) {
                    Log.e(TAG, "⛔ ABORT: No connected devices right before sending (attempt " + attempt + ")");
                    return false;
                }
                
                // Send the data - The Nordic BLE library handles fragmenting large packets
                success = bleManager.sendData(data);
                
                if (success) {
                    break; // Success, exit retry loop
                } else if (attempt == 0) {
                    // First failure, wait briefly and retry
                    Log.w(TAG, "⚠️ First send attempt failed, waiting 100ms to retry...");
                    try {
                        Thread.sleep(100);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "❌ Exception during send operation", e);
            success = false;
        }
        
        if (success) {
            Log.d(TAG, "✅ Sent " + data.length + " bytes via BLE successfully");
            
            // Only show notification for larger data packets to avoid spam
            if (data.length > 10) {
                notificationManager.showDebugNotification("Bluetooth Data", 
                    "Sent " + data.length + " bytes via BLE");
            }
        } else {
            Log.e(TAG, "❌ Failed to send data via BLE");
        }
        
        return success;
    }
    
    @Override
    public boolean isConnected() {
        boolean managerExists = bleManager != null;
        boolean hasDevices = false;
        
        // Get thread ID for debugging
        long threadId = Thread.currentThread().getId();
        
        if (managerExists) {
            hasDevices = bleManager.hasConnectedDevices();
        }
        
        Log.d(TAG, "Thread-" + threadId + ": isConnected() called - manager exists: " + 
              managerExists + ", has devices: " + hasDevices);
        
        // Add stack trace logging when things seem wrong
        if (!hasDevices && isConnected) {
            Log.e(TAG, "Thread-" + threadId + ": CRITICAL: isConnected flag is true but no devices are connected!");
            Exception e = new Exception("Stack trace for inconsistent connection state");
            e.printStackTrace();
            
            // Check connectedDevices list in our inner ASGServerManager
            if (bleManager != null) {
                int listSize = bleManager.getConnectedDevicesCount();
                Log.e(TAG, "Thread-" + threadId + ": Internal connectedDevices.size() = " + listSize);
            }
        }
        
        return managerExists && hasDevices;
    }
    
    @Override
    public void disconnect() {
        if (bleManager != null) {
            BluetoothDevice device = bleManager.getConnectedDevice();
            if (device != null) {
                // Disconnect from the device - we can't cancel connection from server side
                // but we can close the GATT server
                bleManager.close();
                Log.d(TAG, "Disconnected from device: " + device.getAddress());
                
                // State update will happen in the onDeviceDisconnectedFromServer callback
            }
        }
    }
    
    @Override
    public void shutdown() {
        super.shutdown();
        
        // Stop advertising
        stopAdvertising();
        
        // Disconnect if connected
        if (isConnected()) {
            disconnect();
        }
        
        // Clean up any handlers and runnables
        if (bleManager != null) {
            // Clean up connection validation handler
            if (bleManager.connectionValidationHandler != null && bleManager.connectionValidationRunnable != null) {
                bleManager.connectionValidationHandler.removeCallbacks(bleManager.connectionValidationRunnable);
            }
            
            // Clean up keep-alive handler
            if (bleManager.keepAliveHandler != null && bleManager.keepAliveRunnable != null) {
                bleManager.keepAliveHandler.removeCallbacks(bleManager.keepAliveRunnable);
            }
            
            // Close the BLE manager
            bleManager.close();
            bleManager = null;
        }
        
        Log.d(TAG, "NordicBluetoothManager shut down");
    }
}