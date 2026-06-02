package com.mentra.asg_client.io.bluetooth.managers;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
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
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelUuid;
import android.util.Log;

import com.mentra.asg_client.io.bluetooth.core.BaseBluetoothManager;
import com.mentra.asg_client.io.bluetooth.utils.DebugNotificationManager;

import java.util.Arrays;
import java.util.UUID;

/**
 * BLE peripheral manager for the INMO Go2 smart glasses.
 *
 * The ASG Client runs on the Go2 as a GATT server / BLE peripheral.
 * The iOS MentraOS companion app scans for "INMO GO2" and connects as the central.
 *
 * Confirmed UUIDs (nRF Connect scan + INMO BLE spec):
 *   Service  : 00004860-0000-1000-8000-00805f9b34fb
 *   TX (Notify, glasses → phone) : 00004861-0000-1000-8000-00805f9b34fb
 *   RX (Write, phone → glasses)  : 00004862-0000-1000-8000-00805f9b34fb
 *
 * MTU: negotiated up to 247 bytes (Actions Technology module default ceiling).
 *
 * Data framing: plain UTF-8 JSON — identical to MentraLive.  No K900-style
 * binary framing (0x23 0x23 … 0x24 0x24) is used.
 */
public class InmoGo2BluetoothManager extends BaseBluetoothManager {

    private static final String TAG = "InmoGo2BtManager";

    // ---- BLE UUIDs (confirmed from device scan) ----
    private static final UUID SERVICE_UUID =
            UUID.fromString("00004860-0000-1000-8000-00805f9b34fb");
    /** TX characteristic: glasses → phone (Notify) */
    private static final UUID TX_CHAR_UUID =
            UUID.fromString("00004861-0000-1000-8000-00805f9b34fb");
    /** RX characteristic: phone → glasses (Write / WriteNoResponse) */
    private static final UUID RX_CHAR_UUID =
            UUID.fromString("00004862-0000-1000-8000-00805f9b34fb");
    /** Standard CCCD descriptor UUID (required for notifications) */
    private static final UUID CCCD_UUID =
            UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    // ---- Advertising name (must match what iOS scans for) ----
    private static final String DEVICE_NAME = "INMO GO2";

    // ---- MTU ----
    private static final int PREFERRED_MTU = 247; // Actions chip ceiling
    private int currentMtu = 23;                  // BLE default until negotiated

    // ---- Bluetooth objects ----
    private BluetoothManager bluetoothSystemManager;
    private BluetoothAdapter bluetoothAdapter;
    private BluetoothLeAdvertiser advertiser;
    private BluetoothGattServer gattServer;
    private BluetoothGattCharacteristic txCharacteristic;
    private BluetoothGattCharacteristic rxCharacteristic;

    private volatile BluetoothDevice connectedDevice;
    private boolean isAdvertising = false;

    private final DebugNotificationManager notificationManager;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    // -----------------------------------------------------------------------
    // Constructor
    // -----------------------------------------------------------------------

    public InmoGo2BluetoothManager(Context context) {
        super(context);
        notificationManager = new DebugNotificationManager(context);

        bluetoothSystemManager =
                (BluetoothManager) context.getSystemService(Context.BLUETOOTH_SERVICE);
        if (bluetoothSystemManager != null) {
            bluetoothAdapter = bluetoothSystemManager.getAdapter();
        }

        // Set the adapter's advertised name to match what iOS scans for
        if (bluetoothAdapter != null) {
            try {
                bluetoothAdapter.setName(DEVICE_NAME);
                Log.d(TAG, "Bluetooth adapter name set to: " + DEVICE_NAME);
            } catch (SecurityException e) {
                Log.w(TAG, "Could not set Bluetooth adapter name (permission denied)", e);
            }
        }

        Log.d(TAG, "InmoGo2BluetoothManager created");
    }

    // -----------------------------------------------------------------------
    // IBluetoothManager — advertising
    // -----------------------------------------------------------------------

    @Override
    public void startAdvertising() {
        if (bluetoothAdapter == null || !bluetoothAdapter.isEnabled()) {
            Log.e(TAG, "Cannot start advertising — Bluetooth unavailable");
            notificationManager.showDebugNotification("BLE Error", "Bluetooth not enabled");
            return;
        }

        // Set up GATT server first
        setupGattServer();

        advertiser = bluetoothAdapter.getBluetoothLeAdvertiser();
        if (advertiser == null) {
            Log.e(TAG, "BLE advertising not supported on this device");
            notificationManager.showDebugNotification("BLE Error", "BLE advertising not supported");
            return;
        }

        AdvertiseSettings settings = new AdvertiseSettings.Builder()
                .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
                .setConnectable(true)
                .setTimeout(0)  // Advertise indefinitely
                .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
                .build();

        AdvertiseData data = new AdvertiseData.Builder()
                .setIncludeDeviceName(true)
                .addServiceUuid(new ParcelUuid(SERVICE_UUID))
                .build();

        AdvertiseData scanResponse = new AdvertiseData.Builder()
                .setIncludeDeviceName(false)
                .addServiceUuid(new ParcelUuid(SERVICE_UUID))
                .build();

        advertiser.startAdvertising(settings, data, scanResponse, advertiseCallback);
        Log.d(TAG, "Started BLE advertising as: " + DEVICE_NAME);
    }

    @Override
    public void stopAdvertising() {
        if (advertiser == null) return;
        try {
            advertiser.stopAdvertising(advertiseCallback);
            isAdvertising = false;
            notificationManager.cancelAdvertisingNotification();
            Log.d(TAG, "Stopped BLE advertising");
        } catch (Exception e) {
            Log.e(TAG, "Error stopping advertising", e);
        }
    }

    // -----------------------------------------------------------------------
    // IBluetoothManager — connection
    // -----------------------------------------------------------------------

    @Override
    public boolean isConnected() {
        return connectedDevice != null && super.isConnected();
    }

    @Override
    public void disconnect() {
        if (connectedDevice == null || gattServer == null) return;
        try {
            gattServer.cancelConnection(connectedDevice);
            connectedDevice = null;
            notifyConnectionStateChanged(false);
            notificationManager.showBluetoothStateNotification(false);
            // Restart advertising so iOS can reconnect
            mainHandler.postDelayed(() -> {
                if (!isConnected() && !isAdvertising) {
                    startAdvertising();
                }
            }, 500);
        } catch (Exception e) {
            Log.e(TAG, "Error during disconnect", e);
        }
    }

    // -----------------------------------------------------------------------
    // IBluetoothManager — data transmission (glasses → phone)
    // -----------------------------------------------------------------------

    @Override
    protected boolean sendDataInternal(byte[] data) {
        if (data == null || data.length == 0) {
            Log.w(TAG, "sendDataInternal: null or empty data");
            return false;
        }
        if (!isConnected() || connectedDevice == null) {
            Log.w(TAG, "sendDataInternal: not connected");
            return false;
        }
        if (gattServer == null || txCharacteristic == null) {
            Log.e(TAG, "sendDataInternal: GATT server or TX characteristic not ready");
            return false;
        }

        // Fragment large payloads to fit within negotiated MTU
        // MTU includes 3-byte ATT header, so usable payload = currentMtu - 3
        final int maxPayload = Math.max(20, currentMtu - 3);
        int offset = 0;
        while (offset < data.length) {
            int chunkLength = Math.min(maxPayload, data.length - offset);
            byte[] chunk = Arrays.copyOfRange(data, offset, offset + chunkLength);
            txCharacteristic.setValue(chunk);
            boolean ok = gattServer.notifyCharacteristicChanged(
                    connectedDevice, txCharacteristic, false);
            if (!ok) {
                Log.e(TAG, "notifyCharacteristicChanged failed at offset " + offset);
                return false;
            }
            offset += chunkLength;
        }
        Log.d(TAG, "Sent " + data.length + " bytes to phone (fragmented into "
                + (int) Math.ceil((double) data.length / maxPayload) + " chunks)");
        return true;
    }

    // -----------------------------------------------------------------------
    // IBluetoothManager — misc
    // -----------------------------------------------------------------------

    @Override
    public boolean isFileTransferInProgress() {
        // File-transfer pipeline not required for Go2 in the initial integration
        return false;
    }

    // -----------------------------------------------------------------------
    // GATT Server setup
    // -----------------------------------------------------------------------

    private void setupGattServer() {
        if (gattServer != null) {
            Log.d(TAG, "GATT server already set up");
            return;
        }
        gattServer = bluetoothSystemManager.openGattServer(context, gattServerCallback);
        if (gattServer == null) {
            Log.e(TAG, "Failed to open GATT server");
            return;
        }

        BluetoothGattService service = new BluetoothGattService(
                SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY);

        // TX characteristic: glasses → phone (Notify)
        txCharacteristic = new BluetoothGattCharacteristic(
                TX_CHAR_UUID,
                BluetoothGattCharacteristic.PROPERTY_NOTIFY,
                BluetoothGattCharacteristic.PERMISSION_READ);
        // CCCD descriptor — required for notifications
        BluetoothGattDescriptor txCccd = new BluetoothGattDescriptor(
                CCCD_UUID,
                BluetoothGattDescriptor.PERMISSION_READ | BluetoothGattDescriptor.PERMISSION_WRITE);
        txCccd.setValue(BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE);
        txCharacteristic.addDescriptor(txCccd);

        // RX characteristic: phone → glasses (Write / WriteNoResponse)
        rxCharacteristic = new BluetoothGattCharacteristic(
                RX_CHAR_UUID,
                BluetoothGattCharacteristic.PROPERTY_WRITE
                        | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE,
                BluetoothGattCharacteristic.PERMISSION_WRITE);

        service.addCharacteristic(txCharacteristic);
        service.addCharacteristic(rxCharacteristic);
        gattServer.addService(service);

        Log.d(TAG, "GATT server set up with service " + SERVICE_UUID);
    }

    // -----------------------------------------------------------------------
    // GATT server callbacks
    // -----------------------------------------------------------------------

    private final BluetoothGattServerCallback gattServerCallback = new BluetoothGattServerCallback() {

        @Override
        public void onConnectionStateChange(BluetoothDevice device, int status, int newState) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                Log.i(TAG, "Phone connected: " + device.getAddress());
                connectedDevice = device;
                stopAdvertising();
                mainHandler.post(() -> {
                    notifyConnectionStateChanged(true);
                    notificationManager.showBluetoothStateNotification(true);
                });
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                Log.i(TAG, "Phone disconnected: " + device.getAddress());
                if (device.equals(connectedDevice)) {
                    connectedDevice = null;
                }
                mainHandler.post(() -> {
                    notifyConnectionStateChanged(false);
                    notificationManager.showBluetoothStateNotification(false);
                    // Re-advertise so iOS can reconnect
                    mainHandler.postDelayed(() -> {
                        if (!isConnected()) startAdvertising();
                    }, 1000);
                });
            }
        }

        @Override
        public void onCharacteristicWriteRequest(BluetoothDevice device,
                int requestId, BluetoothGattCharacteristic characteristic,
                boolean preparedWrite, boolean responseNeeded,
                int offset, byte[] value) {
            if (RX_CHAR_UUID.equals(characteristic.getUuid())) {
                Log.d(TAG, "Received " + (value != null ? value.length : 0)
                        + " bytes from phone");
                notifyDataReceived(value);
                if (responseNeeded) {
                    gattServer.sendResponse(device, requestId,
                            BluetoothGatt.GATT_SUCCESS, 0, null);
                }
            } else {
                if (responseNeeded) {
                    gattServer.sendResponse(device, requestId,
                            BluetoothGatt.GATT_FAILURE, 0, null);
                }
            }
        }

        @Override
        public void onDescriptorWriteRequest(BluetoothDevice device,
                int requestId, BluetoothGattDescriptor descriptor,
                boolean preparedWrite, boolean responseNeeded,
                int offset, byte[] value) {
            if (CCCD_UUID.equals(descriptor.getUuid())) {
                boolean notificationsEnabled =
                        Arrays.equals(value, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                descriptor.setValue(value);
                Log.d(TAG, "Notifications " + (notificationsEnabled ? "ENABLED" : "DISABLED")
                        + " by: " + device.getAddress());
            }
            if (responseNeeded) {
                gattServer.sendResponse(device, requestId,
                        BluetoothGatt.GATT_SUCCESS, 0, null);
            }
        }

        @Override
        public void onMtuChanged(BluetoothDevice device, int mtu) {
            currentMtu = mtu;
            Log.d(TAG, "MTU changed to " + mtu + " for " + device.getAddress());
        }
    };

    // -----------------------------------------------------------------------
    // Advertising callback
    // -----------------------------------------------------------------------

    private final AdvertiseCallback advertiseCallback = new AdvertiseCallback() {
        @Override
        public void onStartSuccess(AdvertiseSettings settingsInEffect) {
            isAdvertising = true;
            Log.i(TAG, "BLE advertising started as: " + DEVICE_NAME);
            notificationManager.showAdvertisingNotification(DEVICE_NAME);
        }

        @Override
        public void onStartFailure(int errorCode) {
            isAdvertising = false;
            Log.e(TAG, "BLE advertising failed, error: " + errorCode);
            notificationManager.showDebugNotification("BLE Error",
                    "Advertising failed: " + errorCode);
        }
    };
}
