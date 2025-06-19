# Standard Bluetooth Manager Implementation Plan

This document outlines the implementation plan for StandardBluetoothManager to work as a BLE peripheral that can exchange serial data with a central device.

## 1. Core Requirements

- Act as a BLE peripheral (GATT server)
- Advertise with name "Xy_A" when not connected
- Auto-accept pairing requests when possible
- Support serial data exchange with connected central

## 2. GATT Service Design

We'll implement a GATT service with the following characteristics:

```
Service: "AugmentOS Serial Service" - UUID: "795090c7-420d-4048-a24e-18e60180e23c"
  ├── Characteristic: "Serial TX" - UUID: "795090c8-420d-4048-a24e-18e60180e23c"
  │   └── Properties: READ, NOTIFY
  └── Characteristic: "Serial RX" - UUID: "795090c9-420d-4048-a24e-18e60180e23c"
      └── Properties: WRITE, WRITE_NO_RESPONSE
```

- TX characteristic: For sending data from peripheral to central
- RX characteristic: For receiving data from central to peripheral

## 3. Implementation Components

### 3.1 Advertising Setup

```java
private void setupAdvertising() {
    AdvertisingSetParameters parameters = new AdvertisingSetParameters.Builder()
        .setLegacyMode(true)
        .setConnectable(true)
        .setInterval(AdvertisingSetParameters.INTERVAL_HIGH)
        .setTxPowerLevel(AdvertisingSetParameters.TX_POWER_MEDIUM)
        .build();
    
    AdvertiseData data = new AdvertiseData.Builder()
        .setIncludeDeviceName(true)  // Will include "Xy_A"
        .setIncludeTxPowerLevel(false)
        .build();
    
    bluetoothManager.setName("Xy_A");
    
    // Start advertising...
}
```

### 3.2 GATT Server Setup

```java
private void setupGattServer() {
    BluetoothGattService service = new BluetoothGattService(
        SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY);
    
    // TX characteristic - for sending data to central
    BluetoothGattCharacteristic txCharacteristic = new BluetoothGattCharacteristic(
        TX_CHAR_UUID,
        BluetoothGattCharacteristic.PROPERTY_READ | BluetoothGattCharacteristic.PROPERTY_NOTIFY,
        BluetoothGattCharacteristic.PERMISSION_READ);
    
    // RX characteristic - for receiving data from central
    BluetoothGattCharacteristic rxCharacteristic = new BluetoothGattCharacteristic(
        RX_CHAR_UUID,
        BluetoothGattCharacteristic.PROPERTY_WRITE | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
        BluetoothGattCharacteristic.PERMISSION_WRITE);
    
    service.addCharacteristic(txCharacteristic);
    service.addCharacteristic(rxCharacteristic);
    
    gattServer.addService(service);
}
```

### 3.3 Connection Management

```java
private final BluetoothGattServerCallback gattServerCallback = new BluetoothGattServerCallback() {
    @Override
    public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
        if (newState == BluetoothProfile.STATE_CONNECTED) {
            notifyConnectionStateChanged(true);
            stopAdvertising();
        } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
            notifyConnectionStateChanged(false);
            startAdvertising();
        }
    }
    
    @Override
    public void onCharacteristicReadRequest(BluetoothDevice device, int requestId, 
                                          int offset, BluetoothGattCharacteristic characteristic) {
        // Handle read requests
    }
    
    @Override
    public void onCharacteristicWriteRequest(BluetoothDevice device, int requestId,
                                          BluetoothGattCharacteristic characteristic, 
                                          boolean preparedWrite, boolean responseNeeded,
                                          int offset, byte[] value) {
        // Handle incoming data and notify listeners
        notifyDataReceived(value);
        
        if (responseNeeded) {
            gattServer.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, 0, null);
        }
    }
};
```

### 3.4 Auto-accept Pairing

For auto-accepting pairing, we'll need to register a BroadcastReceiver:

```java
private final BroadcastReceiver bondStateReceiver = new BroadcastReceiver() {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (BluetoothDevice.ACTION_PAIRING_REQUEST.equals(intent.getAction())) {
            try {
                BluetoothDevice device = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                // Try to auto-accept (requires system app permissions)
                Method method = device.getClass().getMethod("setPairingConfirmation", boolean.class);
                method.invoke(device, true);
                
                notificationManager.showDebugNotification(
                    "Bluetooth Pairing", "Auto-accepted pairing request");
            } catch (Exception e) {
                // Fall back to standard pairing if we can't auto-accept
                notificationManager.showDebugNotification(
                    "Bluetooth Pairing", "Standard pairing dialog shown");
            }
        }
    }
};
```

## 4. Data Transmission

### 4.1 Sending Data to Central

```java
@Override
public boolean sendData(byte[] data) {
    if (!isConnected() || connectedDevice == null) {
        return false;
    }
    
    try {
        // Find our TX characteristic
        BluetoothGattService service = gattServer.getService(SERVICE_UUID);
        BluetoothGattCharacteristic txChar = service.getCharacteristic(TX_CHAR_UUID);
        
        // Set the data and notify the central
        txChar.setValue(data);
        return gattServer.notifyCharacteristicChanged(connectedDevice, txChar, false);
    } catch (Exception e) {
        Log.e(TAG, "Failed to send data", e);
        return false;
    }
}
```

## 5. Implementation Challenges

1. **Permission Handling**:
   - Modern Android requires BLUETOOTH_CONNECT permission for most operations
   - Some devices may require additional handling of runtime permissions

2. **Auto-accept Pairing**:
   - Requires system-level permissions on most Android devices
   - Will likely need to fall back to standard pairing dialog

3. **MTU Size**:
   - BLE has limited packet sizes (20 bytes by default)
   - Implement a fragmentation/reassembly system for larger data

4. **Advertising Limitations**:
   - Some devices have limitations on advertising duration
   - Implement timeout/restart mechanisms for long-term advertising

## 6. Next Steps

1. Implement base BluetoothGattServerCallback
2. Implement advertising setup with "Xy_A" name
3. Set up GATT service and characteristics
4. Implement auto-pairing logic with fallback
5. Implement data transmission and reception
6. Add robust error handling and state management
7. Add MTU negotiation for better performance