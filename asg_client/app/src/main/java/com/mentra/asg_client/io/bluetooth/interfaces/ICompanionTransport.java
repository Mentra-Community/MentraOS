package com.mentra.asg_client.io.bluetooth.interfaces;

/**
 * Companion link transport (BLE, UART bridge, etc.). Mentra Live uses UART to BES; generic Android
 * may use GATT directly.
 */
public interface ICompanionTransport extends IBluetoothManager {}
