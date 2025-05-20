package com.augmentos.asg_client.bluetooth;

import android.content.Context;
import android.util.Log;

import com.augmentos.asg_client.bluetooth.serial.ComManager;
import com.augmentos.asg_client.bluetooth.serial.SerialListener;
import com.augmentos.asg_client.bluetooth.utils.K900MessageParser;
import com.augmentos.asg_client.bluetooth.utils.ByteUtil;

import java.util.Arrays;
import java.util.List;

/**
 * Implementation of IBluetoothManager for K900 devices.
 * Uses the K900's serial port to communicate with the BES2700 Bluetooth module.
 */
public class K900BluetoothManager extends BaseBluetoothManager implements SerialListener {
    private static final String TAG = "K900BluetoothManager";
    
    private ComManager comManager;
    private boolean isSerialOpen = false;
    private DebugNotificationManager notificationManager;
    private K900MessageParser messageParser;
    
    /**
     * Create a new K900BluetoothManager
     * @param context The application context
     */
    public K900BluetoothManager(Context context) {
        super(context);
        
        // Create the notification manager
        notificationManager = new DebugNotificationManager(context);
        notificationManager.showDeviceTypeNotification(true);
        
        // Create the communication manager
        comManager = new ComManager(context);
        
        // Create the message parser to handle fragmented messages
        messageParser = new K900MessageParser();
    }
    
    @Override
    public void initialize() {
        super.initialize();
        
        // Register for serial events
        comManager.registerListener(this);
        
        // Start the serial communication
        boolean success = comManager.start();
        if (!success) {
            Log.e(TAG, "Failed to start serial communication");
            notificationManager.showDebugNotification("Bluetooth Error", 
                "Failed to start serial communication");
        } else {
            Log.d(TAG, "Serial communication started successfully");
        }
    }
    
    @Override
    public void startAdvertising() {
        // K900 doesn't need to advertise manually, as BES2700 handles this
        Log.d(TAG, "K900 BT module handles advertising automatically");
        notificationManager.showDebugNotification("Bluetooth", 
            "K900 BT module handles advertising automatically");
    }
    
    @Override
    public void stopAdvertising() {
        // K900 doesn't need to stop advertising manually
        Log.d(TAG, "K900 BT module handles advertising automatically");
    }
    
    @Override
    public boolean isConnected() {
        // For K900, we consider the device connected if the serial port is open
        return isSerialOpen && super.isConnected();
    }
    
    @Override
    public void disconnect() {
        // For K900, we don't directly disconnect BLE
        Log.d(TAG, "K900 manages BT connections at the hardware level");
        notificationManager.showDebugNotification("Bluetooth", 
            "K900 manages BT connections at the hardware level");
        
        // But we update the state for our listeners
        if (isConnected()) {
            notifyConnectionStateChanged(false);
            notificationManager.showBluetoothStateNotification(false);
        }
    }
    
    @Override
    public boolean sendData(byte[] data) {
        if (data == null || data.length == 0) {
            Log.w(TAG, "Attempted to send null or empty data");
            return false;
        }
        
        if (!isSerialOpen) {
            Log.w(TAG, "Cannot send data - serial port not open");
            notificationManager.showDebugNotification("Bluetooth Error", 
                "Cannot send data - serial port not open");
            return false;
        }
        
        // First check if it's already in protocol format
        if (!com.augmentos.augmentos_core.smarterglassesmanager.utils.K900ProtocolUtils.isK900ProtocolFormat(data)) {
            // Try to interpret as a JSON string that needs C-wrapping and protocol formatting
            try {
                // Convert to string for processing
                String originalData = new String(data, "UTF-8");
                
                // If looks like JSON but not C-wrapped, use the full formatting function
                if (originalData.startsWith("{") &&
                    !com.augmentos.augmentos_core.smarterglassesmanager.utils.K900ProtocolUtils.isCWrappedJson(originalData)) {
                    
                    Log.e(TAG, "📦 JSON DATA BEFORE C-WRAPPING: " + originalData);
                    data = com.augmentos.augmentos_core.smarterglassesmanager.utils.K900ProtocolUtils.formatMessageForTransmission(originalData);
                    
                    // Log the first 100 chars of the hex representation
                    StringBuilder hexDump = new StringBuilder();
                    for (int i = 0; i < Math.min(data.length, 50); i++) {
                        hexDump.append(String.format("%02X ", data[i]));
                    }
                    Log.e(TAG, "📦 AFTER C-WRAPPING & PROTOCOL FORMATTING (first 50 bytes): " + hexDump.toString());
                    Log.e(TAG, "📦 Total formatted length: " + data.length + " bytes");
                } else {
                    // Otherwise just apply protocol formatting
                    Log.e(TAG, "📦 Data already C-wrapped or not JSON: " + originalData);
                    Log.d(TAG, "Formatting data with K900 protocol (adding ##...)");
                    data = com.augmentos.augmentos_core.smarterglassesmanager.utils.K900ProtocolUtils.packDataCommand(
                        data, com.augmentos.augmentos_core.smarterglassesmanager.utils.K900ProtocolUtils.CMD_TYPE_STRING);
                }
            } catch (Exception e) {
                // If we can't interpret as string, just apply protocol formatting to raw bytes
                Log.d(TAG, "Applying protocol format to raw bytes");
                data = com.augmentos.augmentos_core.smarterglassesmanager.utils.K900ProtocolUtils.packDataCommand(
                    data, com.augmentos.augmentos_core.smarterglassesmanager.utils.K900ProtocolUtils.CMD_TYPE_STRING);
            }
        }
        
        // Send the data via the serial port
        comManager.send(data);
        
        // Only show notification for larger data packets to avoid spam
        if (data.length > 10) {
            notificationManager.showDebugNotification("Bluetooth Data", 
                "Sent " + data.length + " bytes via serial port");
        }
        
        return true;
    }
    
    @Override
    public void shutdown() {
        super.shutdown();
        
        // Stop the serial communication
        comManager.registerListener(null);
        comManager.stop();
        isSerialOpen = false;
        
        // Clear the message parser
        if (messageParser != null) {
            messageParser.clear();
        }
        
        Log.d(TAG, "K900BluetoothManager shut down");
    }
    
    //---------------------------------------
    // SerialListener implementation
    //---------------------------------------
    
    @Override
    public void onSerialOpen(boolean bSucc, int code, String serialPath, String msg) {
        Log.d(TAG, "Serial port open: " + bSucc + " path: " + serialPath);
        isSerialOpen = bSucc;
        
        if (bSucc) {
            notificationManager.showDebugNotification("Serial Open", 
                "Serial port opened successfully: " + serialPath);
        } else {
            notificationManager.showDebugNotification("Serial Error", 
                "Failed to open serial port: " + serialPath + " - " + msg);
        }
    }
    
    @Override
    public void onSerialReady(String serialPath) {
        Log.d(TAG, "Serial port ready: " + serialPath);
        isSerialOpen = true;
        
        // For K900, when the serial port is ready, we consider ourselves "connected"
        // to the BT module
        notifyConnectionStateChanged(true);
        notificationManager.showBluetoothStateNotification(true);
        notificationManager.showDebugNotification("Serial Ready", 
            "Serial port ready: " + serialPath);
    }
    
    @Override
    public void onSerialRead(String serialPath, byte[] data, int size) {
        if (data != null && size > 0) {
            // Copy the data to avoid issues with buffer reuse
            byte[] dataCopy = new byte[size];
            System.arraycopy(data, 0, dataCopy, 0, size);
            
            // Add the data to our message parser
            if (messageParser.addData(dataCopy, size)) {
                // Try to extract complete messages
                List<byte[]> completeMessages = messageParser.parseMessages();
                if (completeMessages != null && !completeMessages.isEmpty()) {
                    // Process each complete message
                    for (byte[] message : completeMessages) {
                        // Notify listeners of the received message
                        notifyDataReceived(message);
                        
                        // Show notification for debugging (only for larger messages to avoid spam)
                        if (message.length > 10) {
                            notificationManager.showDataReceivedNotification(message.length);
                        }
                    }
                }
            } else {
                Log.e(TAG, "Failed to add data to message parser buffer");
            }
        }
    }
    
    @Override
    public void onSerialClose(String serialPath) {
        Log.d(TAG, "Serial port closed: " + serialPath);
        isSerialOpen = false;
        
        // When the serial port closes, we consider ourselves disconnected
        notifyConnectionStateChanged(false);
        notificationManager.showBluetoothStateNotification(false);
        notificationManager.showDebugNotification("Serial Closed", 
            "Serial port closed: " + serialPath);
    }
}