package com.augmentos.augmentos_core.smarterglassesmanager.hci;

import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothProfile;
import android.content.Context;
import android.util.Log;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

public class HearItBleMicrophone {
    private static final String TAG = "HearItBleMicrophone";

    private static final UUID VOICE_SERVICE_UUID = UUID.fromString("00001853-0000-1000-8000-00805f9b34fb");
    private static final UUID VOICE_DATA_CHARACTERISTIC_UUID = UUID.fromString("00002bcd-0000-1000-8000-00805f9b34fb");

    private BluetoothAdapter bluetoothAdapter;
    private BluetoothGatt bluetoothGatt;
    private BluetoothGattCharacteristic voiceDataCharacteristic;
    private Context context;
    private AtomicBoolean isConnected = new AtomicBoolean(false);
    private boolean foundHearIt = false;

    private final int[] idxtbl = {-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8};
    private final int[] steptbl = {
            7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
            50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
            337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
            2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
            15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767
    };

    private int lastPacketNumber = -1;

    public interface HearItBleMicCallback {
        void onConnected();
        void onPcmDataAvailable(byte[] pcmData);
    }

    private HearItBleMicCallback hearItBleMicCallback;

    public void setHearItBleMicCallback(HearItBleMicCallback hearItBleMicCallback) {
        this.hearItBleMicCallback = hearItBleMicCallback;
    }

    public boolean isConnected(){
        return isConnected.get();
    }

    public HearItBleMicrophone(Context context) {
        this.context = context;
        this.bluetoothAdapter = BluetoothAdapter.getDefaultAdapter();
    }

    public void startScanning() {
        if (!bluetoothAdapter.isEnabled()) {
            Log.e(TAG, "Bluetooth is not enabled. Cannot start scanning.");
            return;
        }
        bluetoothAdapter.startLeScan(leScanCallback);
    }

    private BluetoothAdapter.LeScanCallback leScanCallback = new BluetoothAdapter.LeScanCallback() {
        @Override
        public void onLeScan(BluetoothDevice device, int rssi, byte[] scanRecord) {
            if (!foundHearIt && device.getName() != null && device.getName().startsWith("GMIC")) {
                foundHearIt = true;
                bluetoothAdapter.stopLeScan(leScanCallback);
                connectToDevice(device);
            }
        }
    };

    private void connectToDevice(BluetoothDevice device) {
        if (!bluetoothAdapter.isEnabled()) {
            Log.e(TAG, "Bluetooth is not enabled. Cannot connect to device.");
            return;
        }
        bluetoothGatt = device.connectGatt(context, false, gattCallback);
    }

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt gatt, int status, int newState) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                Log.i(TAG, "Connected to GATT server.");
                bluetoothGatt.discoverServices();
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                Log.i(TAG, "Disconnected from GATT server.");
                isConnected.set(false);
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt gatt, int status) {
            if (status == BluetoothGatt.GATT_SUCCESS) {
                List<BluetoothGattService> services = bluetoothGatt.getServices();
                for (BluetoothGattService service : services) {
                    if (VOICE_SERVICE_UUID.equals(service.getUuid())) {
                        voiceDataCharacteristic = service.getCharacteristic(VOICE_DATA_CHARACTERISTIC_UUID);
                        if (voiceDataCharacteristic != null) {
                            bluetoothGatt.setCharacteristicNotification(voiceDataCharacteristic, true);
                            isConnected.set(true);
                            if (hearItBleMicCallback != null) {
                                hearItBleMicCallback.onConnected();
                            }
                        }
                    }
                }
            }
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) {
            if (VOICE_DATA_CHARACTERISTIC_UUID.equals(characteristic.getUuid())) {
                byte[] adpcmData = characteristic.getValue();
                int sampleCount = adpcmData[3] * 2;
                ByteBuffer pcmDataBuffer = ByteBuffer.allocate(sampleCount * 2).order(ByteOrder.LITTLE_ENDIAN); // Dynamically allocate buffer
                adpcmToPcm(adpcmData, pcmDataBuffer);
                byte[] pcmData = pcmDataBuffer.array();
                if (hearItBleMicCallback != null) {
                    hearItBleMicCallback.onPcmDataAvailable(pcmData);
                }
            }
        }
    };

    private void adpcmToPcm(byte[] adpcmData, ByteBuffer pcmDataBuffer) {
        int sampleCount = adpcmData[3] * 2;
        int currentPacketNumber = -1;

        // Check and set currentPacketNumber
        if (adpcmData.length == sampleCount / 2 + 6) {
            currentPacketNumber = (adpcmData[adpcmData.length - 1] << 8) + adpcmData[adpcmData.length - 2];

            if (lastPacketNumber != -1 && currentPacketNumber != lastPacketNumber + 1) {
                int lostPackets = currentPacketNumber - lastPacketNumber - 1;
                Log.w(TAG, "Warning: Packet loss detected, number of lost packets: " + lostPackets);
            }

            lastPacketNumber = currentPacketNumber;
        }

        int predict = (adpcmData[0] | (adpcmData[1] << 8)) << 16 >> 16;
        int predict_idx = adpcmData[2];
        byte[] pcode = new byte[adpcmData.length - 4];
        System.arraycopy(adpcmData, 4, pcode, 0, pcode.length);

        int code = pcode[0];

        for (int i = 0; i < sampleCount; i++) {
            int step = steptbl[predict_idx];
            int diffq = step >> 3;

            if ((code & 4) != 0) diffq += step;
            step >>= 1;
            if ((code & 2) != 0) diffq += step;
            step >>= 1;
            if ((code & 1) != 0) diffq += step;

            if ((code & 8) != 0) predict -= diffq;
            else predict += diffq;

            predict = Math.max(-32768, Math.min(32767, predict));
            predict_idx = Math.max(0, Math.min(88, predict_idx + idxtbl[code & 15]));

            if (i % 2 == 0) code = pcode[i / 2];
            else code >>= 4;

            pcmDataBuffer.putShort((short) predict);
        }
    }

    public void destroy() {
        if (bluetoothGatt != null) {
            bluetoothGatt.disconnect();
            bluetoothGatt.close();
            bluetoothGatt = null;
        }
        hearItBleMicCallback = null;
        isConnected.set(false);
        Log.i(TAG, "Bluetooth connection closed and callback turned off.");
    }

}