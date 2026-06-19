package com.mentra.asg_client.io.peripheral.events;

/** Bluetooth MAC address response from the BES chip (BES command {@code sr_btaddr}). */
public final class BtMacEvent extends McuEvent {

    private final String macAddress;

    public BtMacEvent(String macAddress) {
        this.macAddress = macAddress;
    }

    /** Bluetooth MAC address from JSON field {@code btaddr}. */
    public String getMacAddress() {
        return macAddress;
    }
}
