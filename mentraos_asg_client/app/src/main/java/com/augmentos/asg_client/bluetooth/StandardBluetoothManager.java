package com.augmentos.asg_client.bluetooth;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattServer;
import android.bluetooth.BluetoothGattServerCallback;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.le.AdvertiseCallback;
import android.bluetooth.le.AdvertiseData;
import android.bluetooth.le.AdvertiseSettings;
import android.bluetooth.le.BluetoothLeAdvertiser;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Log;

import androidx.core.app.ActivityCompat;

import java.lang.reflect.Method;
import java.util.UUID;

/**
 * Implementation of IBluetoothManager for standard Android devices.
 * Implements a BLE peripheral that can send/receive serial data and
 * advertises with the name "Xy_A".
 */
public class StandardBluetoothManager extends BaseBluetoothManager {
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
    
    // GATT server callback to handle connections and data exchange
    private final BluetoothGattServerCallback gattServerCallback = new BluetoothGattServerCallback() {
        @Override
        public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                long threadId = Thread.currentThread().getId();
                Log.d(TAG, "Thread-" + threadId + ": Device connected: " + device.getAddress());
                Log.d(TAG, "Thread-" + threadId + ": connectedDevice before = " + (connectedDevice != null ? connectedDevice.getAddress() : "null"));
                connectedDevice = device;
                Log.d(TAG, "Thread-" + threadId + ": connectedDevice after = " + (connectedDevice != null ? connectedDevice.getAddress() : "null"));
                
                // Immediately notify connection state - don't wait for MTU negotiation
                // The central device will initiate MTU negotiation after connection
                notifyConnectionStateChanged(true);
                
                // Show notification for UI feedback
                notificationManager.showBluetoothStateNotification(true);
                
                // Ensure we stop advertising and remove its notification
                stopAdvertising();
                notificationManager.cancelAdvertisingNotification();
                
                // Log that we're ready to receive MTU requests from the central
                Log.d(TAG, "Thread-" + threadId + ": 🔵 Connection established and notified - ready for MTU requests from central");
                
                // We won't try to negotiate parameters as peripheral - that's the central's job
                // But we do log the current MTU so we know what we're starting with
                Log.d(TAG, "Thread-" + threadId + ": Initial MTU is: " + currentMtu + " bytes (effective payload: " + (currentMtu - 3) + " bytes)");
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                long threadId = Thread.currentThread().getId();
                Log.d(TAG, "Thread-" + threadId + ": Device disconnected: " + (device != null ? device.getAddress() : "null"));
                Log.d(TAG, "Thread-" + threadId + ": connectedDevice before disconnect = " + (connectedDevice != null ? connectedDevice.getAddress() : "null"));
                
                // Reset the MTU to default on disconnection
                currentMtu = DEFAULT_MTU;
                
                connectedDevice = null;
                Log.d(TAG, "Thread-" + threadId + ": Set connectedDevice = null");
                
                notifyConnectionStateChanged(false);
                notificationManager.showBluetoothStateNotification(false);
                
                // After a short delay, start advertising again
                handler.postDelayed(() -> {
                    if (!isConnected() && !isAdvertising) {
                        startAdvertising();
                    }
                }, 500);
            }
        }

        @Override
        public void onMtuChanged(BluetoothDevice device, int mtu) {
            Log.d(TAG, "MTU changed to: " + mtu);
            currentMtu = mtu;
            
            // Show notification with negotiated MTU size
            notificationManager.showMtuNegotiationNotification(mtu);
            
            // Also log the effective payload size (MTU - 3 bytes BLE overhead)
            int effectivePayloadSize = Math.max(0, mtu - 3);
            Log.d(TAG, "🔵 MTU negotiation complete - effective payload size: " + effectivePayloadSize + " bytes");
            
            // We don't need to notify connection state change here anymore
            // Since we're doing it immediately upon connection
        }
        
        @Override
        public void onPhyUpdate(BluetoothDevice device, int txPhy, int rxPhy, int status) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                String phyString = getPhyString(txPhy);
                Log.d(TAG, "PHY updated - TX: " + phyString + ", RX: " + phyString);
            } else {
                Log.e(TAG, "PHY update failed with status: " + status);
            }
        }
        
        @Override
        public void onPhyRead(BluetoothDevice device, int txPhy, int rxPhy, int status) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                String phyString = getPhyString(txPhy);
                Log.d(TAG, "PHY read - TX: " + phyString + ", RX: " + phyString);
            }
        }
        
        @Override
        public void onExecuteWrite(BluetoothDevice device, int requestId, boolean execute) {
            Log.d(TAG, "Execute write received: " + execute);
            if (checkPermission()) {
                gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null);
            }
        }

        @Override
        public void onCharacteristicReadRequest(BluetoothDevice device, int requestId, 
                                             int offset, BluetoothGattCharacteristic characteristic) {
            Log.d(TAG, "Read request for characteristic: " + characteristic.getUuid());
            
            if (TX_CHAR_UUID.equals(characteristic.getUuid())) {
                if (checkPermission()) {
                    gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 
                                         offset, characteristic.getValue());
                }
            } else {
                if (checkPermission()) {
                    gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null);
                }
            }
        }

        @Override
        public void onCharacteristicWriteRequest(BluetoothDevice device, int requestId,
                                               BluetoothGattCharacteristic characteristic, 
                                               boolean preparedWrite, boolean responseNeeded,
                                               int offset, byte[] value) {
            long threadId = Thread.currentThread().getId();
            Log.d(TAG, "Thread-" + threadId + ": 📝 WRITE REQUEST RECEIVED for characteristic: " + characteristic.getUuid());
            
            // Enhanced debugging: Print all UUIDs for comparison
            Log.d(TAG, "Thread-" + threadId + ": 🔍 Our RX UUID: " + RX_CHAR_UUID);
            Log.d(TAG, "Thread-" + threadId + ": 🔍 Our TX UUID: " + TX_CHAR_UUID);
            Log.d(TAG, "Thread-" + threadId + ": 🔍 Incoming char UUID: " + characteristic.getUuid());
            
            // Check which characteristic is being written to
            boolean isRxChar = RX_CHAR_UUID.equals(characteristic.getUuid());
            boolean isTxChar = TX_CHAR_UUID.equals(characteristic.getUuid());
            Log.d(TAG, "Thread-" + threadId + ": 📝 Characteristic identified: RX=" + isRxChar + ", TX=" + isTxChar);
            
            // IMPORTANT: Accept writes to BOTH characteristics for maximum compatibility
            if (isRxChar || isTxChar) {
                if (value != null) {
                    // Notify our listeners of the received data
                    notifyDataReceived(value);
                    
                    // Show a notification for larger data packets
                    if (value.length > 10) {
                        notificationManager.showDataReceivedNotification(value.length);
                    }
                }
                
                // Always send success response if needed
                if (responseNeeded && checkPermission()) {
                    gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null);
                    Log.d(TAG, "Thread-" + threadId + ": ✅ Sent success response");
                }
            } else {
                // Unknown characteristic
                Log.e(TAG, "Thread-" + threadId + ": ❌ Unknown characteristic UUID: " + characteristic.getUuid());
                if (responseNeeded && checkPermission()) {
                    gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_FAILURE, 0, null);
                    Log.d(TAG, "Thread-" + threadId + ": ❌ Sent failure response");
                }
            }
        }
    };
    
    // BroadcastReceiver for bluetooth pairing requests and bond state changes
    private final BroadcastReceiver bondStateReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String action = intent.getAction();
            
            if (BluetoothDevice.ACTION_PAIRING_REQUEST.equals(action)) {
                BluetoothDevice device = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                if (device == null) return;
                
                // Store reference to device requesting pairing
                pendingPairingDevice = device;
                currentPairingRetries = 0;
                
                Log.d(TAG, "Pairing request received from " + device.getAddress());
                
                // Try primary auto-accept method (reflection based)
                if (attemptReflectionAutoPairing(device)) {
                    return;
                }
                
                // If primary method fails, try alternative methods
                if (attemptSetPinPairing(device, intent)) {
                    return;
                }
                
                // Schedule a retry if both methods fail
                scheduleAutoPairingRetry(device);
            } 
            else if (BluetoothDevice.ACTION_BOND_STATE_CHANGED.equals(action)) {
                int previousState = intent.getIntExtra(BluetoothDevice.EXTRA_PREVIOUS_BOND_STATE, BluetoothDevice.BOND_NONE);
                int currentState = intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.BOND_NONE);
                BluetoothDevice device = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                
                if (device == null) return;
                
                Log.d(TAG, "Bond state changed for " + device.getAddress() + 
                     " from " + bondStateToString(previousState) + 
                     " to " + bondStateToString(currentState));
                
                // Handle different bond state transitions
                switch (currentState) {
                    case BluetoothDevice.BOND_BONDED:
                        Log.d(TAG, "Device bonded successfully: " + device.getAddress());
                        notificationManager.showDebugNotification("Bluetooth", 
                            "Device pairing successful");
                        
                        // Clear pairing state
                        pendingPairingDevice = null;
                        currentPairingRetries = 0;
                        break;
                        
                    case BluetoothDevice.BOND_BONDING:
                        Log.d(TAG, "Device bonding in progress: " + device.getAddress());
                        break;
                        
                    case BluetoothDevice.BOND_NONE:
                        // If we were previously bonding and now we're not, pairing failed
                        if (previousState == BluetoothDevice.BOND_BONDING) {
                            Log.w(TAG, "Pairing failed for device: " + device.getAddress());
                            notificationManager.showDebugNotification("Bluetooth Warning", 
                                "Pairing failed - retrying");
                                
                            // If this was our pending device, attempt to retry pairing
                            if (pendingPairingDevice != null && 
                                device.getAddress().equals(pendingPairingDevice.getAddress())) {
                                scheduleAutoPairingRetry(device);
                            }
                        }
                        break;
                }
            }
            else if (BluetoothAdapter.ACTION_STATE_CHANGED.equals(action)) {
                int state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR);
                
                switch (state) {
                    case BluetoothAdapter.STATE_OFF:
                        Log.d(TAG, "Bluetooth adapter turned OFF");
                        break;
                        
                    case BluetoothAdapter.STATE_ON:
                        Log.d(TAG, "Bluetooth adapter turned ON");
                        // If we were in the middle of pairing when Bluetooth was turned off and on,
                        // we might need to restart advertising
                        if (!isConnected() && !isAdvertising) {
                            handler.postDelayed(() -> {
                                if (!isConnected() && !isAdvertising) {
                                    startAdvertising();
                                }
                            }, 1000);
                        }
                        break;
                        
                    case BluetoothAdapter.STATE_TURNING_ON:
                        Log.d(TAG, "Bluetooth adapter turning ON");
                        break;
                        
                    case BluetoothAdapter.STATE_TURNING_OFF:
                        Log.d(TAG, "Bluetooth adapter turning OFF");
                        // The adapter turning off will automatically disconnect any devices
                        // and stop advertising, so we'll clear our connection state
                        connectedDevice = null;
                        isAdvertising = false;
                        break;
                }
            }
            else if (BluetoothDevice.ACTION_ACL_CONNECTED.equals(action)) {
                BluetoothDevice device = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                if (device != null) {
                    Log.d(TAG, "ACL connection established with " + device.getAddress());
                    
                    // Check if this is a device that was previously failing to pair
                    if (pendingPairingDevice != null && 
                        device.getAddress().equals(pendingPairingDevice.getAddress())) {
                        // Clear retries - the connection was successful
                        pendingPairingDevice = null;
                        currentPairingRetries = 0;
                    }
                }
            }
            else if (BluetoothDevice.ACTION_ACL_DISCONNECTED.equals(action)) {
                BluetoothDevice device = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                if (device != null) {
                    Log.d(TAG, "ACL connection disconnected from " + device.getAddress());
                }
            }
            else if (BluetoothDevice.ACTION_ACL_DISCONNECT_REQUESTED.equals(action)) {
                BluetoothDevice device = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                if (device != null) {
                    Log.d(TAG, "ACL disconnect requested for " + device.getAddress());
                }
            }
            else if (BluetoothDevice.ACTION_FOUND.equals(action)) {
                BluetoothDevice device = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                if (device != null) {
                    Log.d(TAG, "Found Bluetooth device: " + device.getAddress() + 
                         (device.getName() != null ? " (" + device.getName() + ")" : ""));
                }
            }
        }
    };
    
    /**
     * Create a new StandardBluetoothManager
     * @param context The application context
     */
    public StandardBluetoothManager(Context context) {
        super(context);
        
        // Create the notification manager
        notificationManager = new DebugNotificationManager(context);
        notificationManager.showDeviceTypeNotification(false);
        
        // Get the bluetooth manager and adapter
        bluetoothManager = (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        if (bluetoothManager != null) {
            bluetoothAdapter = bluetoothManager.getAdapter();
        }
        
        if (bluetoothAdapter == null) {
            Log.e(TAG, "Bluetooth not supported on this device");
            notificationManager.showDebugNotification("Bluetooth Error", 
                "Bluetooth not supported on this device");
        } else {
            // Register for comprehensive pairing and bond state requests
            IntentFilter filter = new IntentFilter();
            
            // Pairing related actions
            filter.addAction(BluetoothDevice.ACTION_PAIRING_REQUEST);
            filter.addAction(BluetoothDevice.ACTION_BOND_STATE_CHANGED);
            
            // Additional state monitoring
            filter.addAction(BluetoothAdapter.ACTION_STATE_CHANGED);
            filter.addAction(BluetoothDevice.ACTION_ACL_CONNECTED);
            filter.addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED);
            filter.addAction(BluetoothDevice.ACTION_ACL_DISCONNECT_REQUESTED);
            filter.addAction(BluetoothDevice.ACTION_FOUND);
            
            // Register with appropriate priority
            context.registerReceiver(bondStateReceiver, filter, null, handler);
            
            Log.d(TAG, "Registered broadcast receiver for comprehensive Bluetooth state monitoring");
        }
    }
    
    @Override
    public void initialize() {
        super.initialize();
        
        if (bluetoothAdapter == null) {
            Log.e(TAG, "Cannot initialize Bluetooth - adapter is null");
            return;
        }
        
        // Make sure Bluetooth is enabled
        if (!bluetoothAdapter.isEnabled()) {
            Log.d(TAG, "Bluetooth is not enabled");
            notificationManager.showDebugNotification("Bluetooth Warning", 
                "Please enable Bluetooth for proper operation");
            return;
        }
        
        // Set the device name to Xy_A
        if (checkPermission()) {
            bluetoothAdapter.setName(DEVICE_NAME);
        }
        
        // Set up the GATT server
        setupGattServer();
        
        // Start advertising
        startAdvertising();
        
        Log.d(TAG, "StandardBluetoothManager initialized");
    }
    
    /**
     * Set up the GATT server with our service and characteristics
     */
    private void setupGattServer() {
        try {
            // Get the GATT server from the bluetooth manager
            if (checkPermission()) {
                gattServer = bluetoothManager.openGattServer(context, gattServerCallback);
                
                if (gattServer == null) {
                    Log.e(TAG, "Failed to create GATT server");
                    notificationManager.showDebugNotification("Bluetooth Error", 
                        "Failed to create GATT server");
                    return;
                }
                
                // Create our service
                BluetoothGattService service = new BluetoothGattService(
                    SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY);
                
                // TX characteristic - for sending data to central
                txCharacteristic = new BluetoothGattCharacteristic(
                    TX_CHAR_UUID,
                    BluetoothGattCharacteristic.PROPERTY_READ | BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                    BluetoothGattCharacteristic.PERMISSION_READ);
                
                // Add descriptor to TX characteristic to enable notifications
                BluetoothGattDescriptor txDescriptor = new BluetoothGattDescriptor(
                    UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"),  // Standard CCCD UUID
                    BluetoothGattDescriptor.PERMISSION_READ | BluetoothGattDescriptor.PERMISSION_WRITE);
                txCharacteristic.addDescriptor(txDescriptor);
                Log.d(TAG, "Added CCCD descriptor to TX characteristic with READ/WRITE permissions");
                
                // RX characteristic - for receiving data from central
                BluetoothGattCharacteristic rxCharacteristic = new BluetoothGattCharacteristic(
                    RX_CHAR_UUID,
                    BluetoothGattCharacteristic.PROPERTY_WRITE | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
                    BluetoothGattCharacteristic.PERMISSION_WRITE);
                
                // Add characteristics to service
                service.addCharacteristic(txCharacteristic);
                service.addCharacteristic(rxCharacteristic);
                
                // Add service to GATT server
                boolean success = gattServer.addService(service);
                
                if (success) {
                    Log.d(TAG, "GATT service added successfully");
                } else {
                    Log.e(TAG, "Failed to add GATT service");
                    notificationManager.showDebugNotification("Bluetooth Error", 
                        "Failed to add GATT service");
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error setting up GATT server", e);
            notificationManager.showDebugNotification("Bluetooth Error", 
                "Error setting up GATT server: " + e.getMessage());
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
        if (checkPermission()) {
            try {
                advertiser.startAdvertising(settings, advertiseData, advertiseCallback);
                Log.d(TAG, "Started BLE advertising");
            } catch (Exception e) {
                Log.e(TAG, "Failed to start advertising", e);
                notificationManager.showDebugNotification("Bluetooth Error", 
                    "Failed to start advertising: " + e.getMessage());
            }
        }
    }
    
    @Override
    public void stopAdvertising() {
        if (bluetoothAdapter == null || advertiser == null) {
            return;
        }
        
        // Stop advertising
        if (checkPermission()) {
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
    }
    
    @Override
    public boolean isConnected() {
        return connectedDevice != null && super.isConnected();
    }
    
    @Override
    protected void notifyConnectionStateChanged(boolean connected) {
        // If already notified the same state, don't notify again
        if (connected == isNotifiedConnected) {
            Log.d(TAG, "Skipping duplicate connection state notification: " + connected);
            return;
        }
        
        // Update our tracker before calling super
        Log.d(TAG, "Updating connection notification state to: " + connected);
        isNotifiedConnected = connected;
        
        // Call the parent implementation to notify listeners
        super.notifyConnectionStateChanged(connected);
    }
    
    @Override
    public void disconnect() {
        if (!isConnected() || connectedDevice == null) {
            return;
        }
        
        if (gattServer != null && checkPermission()) {
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
        
        // Format the data using the unified utility method
        data = com.augmentos.augmentos_core.smarterglassesmanager.utils.K900ProtocolUtils.prepareDataForTransmission(data);
        
        // We're no longer checking isNotifiedConnected since we notify immediately on connection
        // Instead, we'll just check the packet size against the current MTU value
        
        // Calculate the effective MTU size (MTU - 3 bytes BLE overhead)
        int effectiveMtu = currentMtu - 3;
        
        // If data fits in a single MTU packet
        if (data.length <= effectiveMtu) {
            return sendDataPacket(data);
        } else {
            // Get thread ID for consistent logging
            long threadId = Thread.currentThread().getId();
            
            // Log a warning about data exceeding MTU size
            Log.w(TAG, "Thread-" + threadId + ": ⚠️ Data exceeds MTU size (" + data.length + " > " + effectiveMtu + " bytes)");
            
            // For LC3 audio specifically, provide detailed diagnostics
            boolean isLc3AudioPacket = false;
            if (data.length > 0 && (data[0] == (byte)0xA0 || (data[0] & 0xFF) == 0xA0 || data[0] == -96)) {
                isLc3AudioPacket = true;
                //Log.e(TAG, "Thread-" + threadId + ": 🎵 LC3 AUDIO PACKET DETECTED!");
                //Log.e(TAG, "Thread-" + threadId + ": 🔍 Packet size (" + data.length + " bytes) exceeds MTU (" + effectiveMtu + " bytes)");
                
                StringBuilder hexDump = new StringBuilder();
                for (int i = 0; i < Math.min(data.length, 32); i++) {
                    hexDump.append(String.format("%02X ", data[i]));
                }
                //Log.e(TAG, "Thread-" + threadId + ": 🔍 First 32 bytes: " + hexDump);
                
                // Request higher MTU if needed for LC3 audio
                if (currentMtu < 100 && connectedDevice != null) {
                    //Log.d(TAG, "Thread-" + threadId + ": 🔄 Requesting higher MTU for LC3 audio");
                    // This is a peripheral, so we can't directly request MTU, but we'll log it
                    // so the central device knows it should increase the MTU
                }
                
                // For LC3 audio, show a specific message
                notificationManager.showDebugNotification("LC3 Audio Warning", 
                    "LC3 audio packet (" + data.length + " bytes) exceeds MTU (" + effectiveMtu + 
                    "). Audio may be truncated. Central device must increase MTU to at least " + 
                    (data.length + 3) + " bytes.");
            } else {
                // For data larger than MTU, we would normally implement packet fragmentation here
                // But since we're ignoring packet fragmentation for now as per requirements,
                // we'll log a warning and still try to send it in one piece
                Log.w(TAG, "Thread-" + threadId + ": Warning: Data size (" + data.length + " bytes) " + 
                       "exceeds MTU capacity (" + effectiveMtu + " bytes). This may cause transmission issues.");
                       
                notificationManager.showDebugNotification("Bluetooth Warning", 
                    "Data exceeds MTU size (" + data.length + " > " + effectiveMtu + " bytes)");
            }
            
            // Enhanced debugging for MTU issues
//            Log.d(TAG, "Thread-" + threadId + ": 📊 Detailed MTU diagnostic:");
//            Log.d(TAG, "Thread-" + threadId + ": 📊 Current MTU: " + currentMtu + " bytes");
//            Log.d(TAG, "Thread-" + threadId + ": 📊 Effective payload: " + effectiveMtu + " bytes");
//            Log.d(TAG, "Thread-" + threadId + ": 📊 Packet size: " + data.length + " bytes");
//            Log.d(TAG, "Thread-" + threadId + ": 📊 Packet type: " + (isLc3AudioPacket ? "LC3 Audio" : "Other"));
//            Log.d(TAG, "Thread-" + threadId + ": 📊 Will attempt to send anyway");
            
            // Try to send it anyway and hope the BLE stack handles it
            return sendDataPacket(data);
        }
    }
    

    /**
     * Helper method to send a single packet of data
     * @param data The data to send
     * @return true if successful, false otherwise
     */
    private boolean sendDataPacket(byte[] data) {
        long threadId = Thread.currentThread().getId();
        
        // Always log detailed info about current state for debugging
        Log.d(TAG, "Thread-" + threadId + ": 📤 sendDataPacket - data size: " + data.length + " bytes");
        Log.d(TAG, "Thread-" + threadId + ": 📤 sendDataPacket - connectedDevice: " +
              (connectedDevice != null ? connectedDevice.getAddress() : "null"));
        Log.d(TAG, "Thread-" + threadId + ": 📤 sendDataPacket - txCharacteristic: " +
              (txCharacteristic != null ? txCharacteristic.getUuid() : "null"));
        Log.d(TAG, "Thread-" + threadId + ": 📤 sendDataPacket - gattServer: " +
              (gattServer != null ? "initialized" : "null"));
        
        // Log some sample data
        if (data.length > 0) {
            StringBuilder hexData = new StringBuilder();
            for (int i = 0; i < Math.min(data.length, 16); i++) {
                hexData.append(String.format("%02X ", data[i]));
            }
            Log.d(TAG, "Thread-" + threadId + ": 📤 First 16 bytes: " + hexData);
        }
        
        // Double-check if we can actually send data
        if (connectedDevice == null) {
            Log.e(TAG, "Thread-" + threadId + ": ❌ Cannot send data - connectedDevice is null");
            return false;
        }
        
        if (txCharacteristic == null) {
            Log.e(TAG, "Thread-" + threadId + ": ❌ Cannot send data - txCharacteristic is null");
            return false;
        }
        
        if (gattServer == null) {
            Log.e(TAG, "Thread-" + threadId + ": ❌ Cannot send data - gattServer is null");
            return false;
        }
        
        // Check TX characteristic properties
        int properties = txCharacteristic.getProperties();
        Log.d(TAG, "Thread-" + threadId + ": 📤 TX characteristic properties: " + properties);
        boolean hasNotify = (properties & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0;
        Log.d(TAG, "Thread-" + threadId + ": 📤 TX characteristic has NOTIFY property: " + hasNotify);
        
        // Set the data in the TX characteristic
        txCharacteristic.setValue(data);
        
        // Notify the central device of the new value
        boolean success = false;
        if (checkPermission()) {
            try {
                Log.d(TAG, "Thread-" + threadId + ": 📤 Attempting to send data via BLE characteristic");
                
                // Critical check right before sending
                if (connectedDevice == null) {
                    Log.e(TAG, "Thread-" + threadId + ": ❌ RACE CONDITION - connectedDevice became null!");
                    return false;
                }

                success = gattServer.notifyCharacteristicChanged(connectedDevice, txCharacteristic, false);
                
                if (success) {
                    Log.d(TAG, "Thread-" + threadId + ": ✅ Sent " + data.length + " bytes via BLE characteristic");
                    
                    // Show notification for larger data packets
                    if (data.length > 10) {
                        notificationManager.showDebugNotification("Bluetooth Data",
                            "Sent " + data.length + " bytes via BLE");
                    }
                } else {
                    Log.e(TAG, "Thread-" + threadId + ": ❌ Failed to send data via BLE characteristic");
                }
            } catch (Exception e) {
                Log.e(TAG, "Thread-" + threadId + ": ❌ Error sending data", e);
            }
        } else {
            Log.e(TAG, "Thread-" + threadId + ": ❌ Missing permission to send data");
        }
        
        return success;
    }
    
    @Override
    public void shutdown() {
        super.shutdown();
        
        if (isAdvertising) {
            stopAdvertising();
        }
        
        if (isConnected()) {
            disconnect();
        }
        
        // Close the GATT server
        if (gattServer != null && checkPermission()) {
            try {
                gattServer.close();
                gattServer = null;
            } catch (Exception e) {
                Log.e(TAG, "Error closing GATT server", e);
            }
        }
        
        // Unregister bond state receiver
        try {
            context.unregisterReceiver(bondStateReceiver);
        } catch (Exception e) {
            // Ignore if already unregistered
        }
        
        Log.d(TAG, "StandardBluetoothManager shut down");
    }
    
    /**
     * Negotiates connection parameters with the connected device
     * This affects power consumption, latency, and throughput
     */
    private void negotiateConnectionParameters() {
        if (!isConnected() || connectedDevice == null || gattServer == null) {
            Log.w(TAG, "Cannot negotiate connection parameters - not connected");
            return;
        }
        
        if (!checkPermission()) {
            Log.e(TAG, "Missing permission to negotiate connection parameters");
            return;
        }
        
        // Create a client-side GATT connection to the device to handle parameter requests
        BluetoothGatt gattClient = null;
        
        try {
            // We need to create a client connection to request connection parameter updates
            // as GATT server mode doesn't have direct methods for this
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                gattClient = connectedDevice.connectGatt(context, false, 
                    new BluetoothGattCallback() {
                        @Override
                        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
                            if (newState == BluetoothProfile.STATE_CONNECTED) {
                                Log.d(TAG, "GATT client connected, requesting preferred connection parameters");
                                
                                // Request high priority for initial setup phase
                                boolean success = gatt.requestConnectionPriority(CONN_PRIORITY_HIGH);
                                Log.d(TAG, "Requested high connection priority, success: " + success);
                                
                                // Request MTU update after a short delay
                                handler.postDelayed(() -> {
                                    if (gatt != null) {
                                        boolean mtuSuccess = gatt.requestMtu(PREFERRED_MTU);
                                        Log.d(TAG, "Requested MTU update to " + PREFERRED_MTU + ", success: " + mtuSuccess);
                                        
                                        // Switch to balanced mode after another delay
                                        handler.postDelayed(() -> {
                                            if (gatt != null) {
                                                gatt.requestConnectionPriority(CONN_PRIORITY_BALANCED);
                                                Log.d(TAG, "Switched to balanced connection priority");
                                            }
                                        }, 1000);
                                    }
                                }, 1000);
                            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                                Log.d(TAG, "GATT client disconnected");
                                gatt.close();
                            }
                        }
                        
                        @Override
                        public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
                            if (status == BluetoothGatt.GATT_SUCCESS) {
                                Log.d(TAG, "MTU changed to: " + mtu);
                                currentMtu = mtu;
                                notificationManager.showMtuNegotiationNotification(mtu);
                                
                                int effectivePayloadSize = Math.max(0, mtu - 3);
                                Log.d(TAG, "Effective payload size: " + effectivePayloadSize + " bytes");
                            } else {
                                Log.e(TAG, "MTU change failed with status: " + status);
                            }
                        }
                        
                        @Override
                        public void onPhyUpdate(BluetoothGatt gatt, int txPhy, int rxPhy, int status) {
                            if (status == BluetoothGatt.GATT_SUCCESS) {
                                String phyString = getPhyString(txPhy);
                                Log.d(TAG, "PHY updated - TX: " + phyString + ", RX: " + phyString);
                            } else {
                                Log.e(TAG, "PHY update failed with status: " + status);
                            }
                        }
                    }, BluetoothDevice.TRANSPORT_LE);
            } else {
                gattClient = connectedDevice.connectGatt(context, false, 
                    new BluetoothGattCallback() {
                        @Override
                        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
                            if (newState == BluetoothProfile.STATE_CONNECTED) {
                                Log.d(TAG, "GATT client connected, requesting preferred connection parameters");
                                
                                // Request high priority for initial setup phase
                                boolean success = gatt.requestConnectionPriority(CONN_PRIORITY_HIGH);
                                Log.d(TAG, "Requested high connection priority, success: " + success);
                                
                                // Request MTU update after a short delay
                                handler.postDelayed(() -> {
                                    if (gatt != null) {
                                        boolean mtuSuccess = gatt.requestMtu(PREFERRED_MTU);
                                        Log.d(TAG, "Requested MTU update to " + PREFERRED_MTU + ", success: " + mtuSuccess);
                                        
                                        // Switch to balanced mode after another delay
                                        handler.postDelayed(() -> {
                                            if (gatt != null) {
                                                gatt.requestConnectionPriority(CONN_PRIORITY_BALANCED);
                                                Log.d(TAG, "Switched to balanced connection priority");
                                            }
                                        }, 1000);
                                    }
                                }, 1000);
                            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                                Log.d(TAG, "GATT client disconnected");
                                gatt.close();
                            }
                        }
                        
                        @Override
                        public void onMtuChanged(BluetoothGatt gatt, int mtu, int status) {
                            if (status == BluetoothGatt.GATT_SUCCESS) {
                                Log.d(TAG, "MTU changed to: " + mtu);
                                currentMtu = mtu;
                                notificationManager.showMtuNegotiationNotification(mtu);
                                
                                int effectivePayloadSize = Math.max(0, mtu - 3);
                                Log.d(TAG, "Effective payload size: " + effectivePayloadSize + " bytes");
                            } else {
                                Log.e(TAG, "MTU change failed with status: " + status);
                            }
                        }
                    });
            }
        } catch (Exception e) {
            Log.e(TAG, "Error creating GATT client for parameter negotiation", e);
        }
        
        Log.d(TAG, "Started connection parameter negotiation");
    }
    
    /**
     * Gets a string representation of a Bluetooth PHY mode
     */
    private String getPhyString(int phy) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            switch (phy) {
                case BluetoothDevice.PHY_LE_1M:
                    return "LE 1M";
                case BluetoothDevice.PHY_LE_2M:
                    return "LE 2M";
                case BluetoothDevice.PHY_LE_CODED:
                    return "LE Coded";
                default:
                    return "Unknown (" + phy + ")";
            }
        } else {
            return "LE 1M (SDK < 26)";
        }
    }
    
    /**
     * Converts a Bluetooth bond state to a human-readable string
     */
    private String bondStateToString(int bondState) {
        switch (bondState) {
            case BluetoothDevice.BOND_NONE:
                return "BOND_NONE";
            case BluetoothDevice.BOND_BONDING:
                return "BOND_BONDING";
            case BluetoothDevice.BOND_BONDED:
                return "BOND_BONDED";
            default:
                return "UNKNOWN (" + bondState + ")";
        }
    }
    
    /**
     * Attempts to use reflection to auto-accept a pairing request
     * @param device The Bluetooth device requesting pairing
     * @return true if successful, false otherwise
     */
    private boolean attemptReflectionAutoPairing(BluetoothDevice device) {
        try {
            Log.d(TAG, "Attempting reflection-based auto-pairing for " + device.getAddress());
            
            if (!checkPermission()) {
                Log.e(TAG, "Missing Bluetooth permissions for auto-pairing");
                return false;
            }
            
            // Method 1: setPairingConfirmation(true)
            Method confirmMethod = device.getClass().getMethod("setPairingConfirmation", boolean.class);
            confirmMethod.invoke(device, true);
            
            Log.d(TAG, "Auto-accepted pairing request via reflection");
            notificationManager.showDebugNotification("Bluetooth", 
                "Auto-accepted pairing request");
            return true;
        } 
        catch (Exception e) {
            Log.d(TAG, "Reflection-based auto-pairing failed: " + e.getMessage());
            return false;
        }
    }
    
    /**
     * Attempts to handle PIN pairing if necessary
     * @param device The Bluetooth device requesting pairing
     * @param intent The original intent with pairing details
     * @return true if successful, false otherwise
     */
    private boolean attemptSetPinPairing(BluetoothDevice device, Intent intent) {
        try {
            Log.d(TAG, "Attempting PIN-based auto-pairing for " + device.getAddress());
            
            if (!checkPermission()) {
                Log.e(TAG, "Missing Bluetooth permissions for PIN auto-pairing");
                return false;
            }
            
            // Extract variant if available
            int variant = intent.getIntExtra(BluetoothDevice.EXTRA_PAIRING_VARIANT, 
                                           BluetoothDevice.ERROR);
            
            // Handle different pairing variants
            switch (variant) {
                case PAIRING_VARIANT_PIN:
                    // Default to "0000" as a common PIN code
                    String pin = "0000"; 
                    Method setPin = device.getClass().getMethod("setPin", byte[].class);
                    setPin.invoke(device, pin.getBytes());
                    Log.d(TAG, "Auto-set PIN code for pairing");
                    return true;
                    
                case PAIRING_VARIANT_PASSKEY:
                    // Try to auto-confirm passkey
                    Method setPairingConfirmation = device.getClass().getMethod("setPairingConfirmation", boolean.class);
                    setPairingConfirmation.invoke(device, true);
                    Log.d(TAG, "Auto-confirmed passkey for pairing");
                    return true;
                
                default:
                    Log.d(TAG, "No specific handling for pairing variant: " + variant);
                    return false;
            }
        } 
        catch (Exception e) {
            Log.d(TAG, "PIN-based auto-pairing failed: " + e.getMessage());
            return false;
        }
    }
    
    /**
     * Schedule a retry for auto-pairing after a delay
     * @param device The Bluetooth device to retry pairing with
     */
    private void scheduleAutoPairingRetry(BluetoothDevice device) {
        if (currentPairingRetries >= MAX_PAIRING_RETRIES) {
            Log.w(TAG, "Reached maximum pairing retries (" + MAX_PAIRING_RETRIES + ") for " + device.getAddress());
            notificationManager.showDebugNotification("Bluetooth Warning",
                "Failed to pair automatically after " + MAX_PAIRING_RETRIES + " attempts. Please pair manually.");
            return;
        }
        
        currentPairingRetries++;
        
        Log.d(TAG, "Scheduling pairing retry " + currentPairingRetries + "/" + MAX_PAIRING_RETRIES + 
             " for " + device.getAddress() + " in " + PAIRING_RETRY_DELAY_MS + "ms");
             
        handler.postDelayed(() -> {
            if (pendingPairingDevice != null && 
                pendingPairingDevice.getAddress().equals(device.getAddress())) {
                
                Log.d(TAG, "Executing pairing retry " + currentPairingRetries);
                
                // Try to create a bond manually
                try {
                    if (checkPermission()) {
                        Method createBondMethod = device.getClass().getMethod("createBond");
                        createBondMethod.invoke(device);
                        Log.d(TAG, "Manually initiated bonding process");
                        notificationManager.showDebugNotification("Bluetooth", 
                            "Retrying pairing (Attempt " + currentPairingRetries + "/" + MAX_PAIRING_RETRIES + ")");
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Failed to manually create bond: " + e.getMessage());
                    
                    // Try primary auto-accept method again as fallback
                    if (!attemptReflectionAutoPairing(device)) {
                        // If that fails too and we haven't maxed out retries, schedule another retry
                        if (currentPairingRetries < MAX_PAIRING_RETRIES) {
                            scheduleAutoPairingRetry(device);
                        }
                    }
                }
            }
        }, PAIRING_RETRY_DELAY_MS);
    }
    
    /**
     * Helper to check for Bluetooth permissions
     * @return true if permissions granted, false otherwise
     */
    private boolean checkPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return ActivityCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) 
                == PackageManager.PERMISSION_GRANTED;
        } else {
            return true; // Prior to Android 12, the normal BLUETOOTH permission was enough
        }
    }
}