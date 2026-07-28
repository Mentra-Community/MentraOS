package com.mentra.asg_client.io.peripheral.events;

/** System version report from the BES chip (BES command {@code hs_syvr}). */
public final class BesVersionEvent extends McuEvent {

    private final String firmwareVersion;
    private final String bleName;
    private final String btName;
    private final String btAddress;
    private final String bleAddress;
    private final String manufacturingSerial;

    public BesVersionEvent(
            String firmwareVersion,
            String bleName,
            String btName,
            String btAddress,
            String bleAddress,
            String manufacturingSerial) {
        this.firmwareVersion = firmwareVersion;
        this.bleName = bleName;
        this.btName = btName;
        this.btAddress = btAddress;
        this.bleAddress = bleAddress;
        this.manufacturingSerial = manufacturingSerial;
    }

    /** BES firmware version from JSON field {@code version}. */
    public String getFirmwareVersion() {
        return firmwareVersion;
    }

    /** BLE device name from JSON field {@code ble}. */
    public String getBleName() {
        return bleName;
    }

    /** Bluetooth device name from JSON field {@code bt}. */
    public String getBtName() {
        return btName;
    }

    /** Bluetooth MAC address from JSON field {@code btaddr}. */
    public String getBtAddress() {
        return btAddress;
    }

    /** BLE MAC address from JSON field {@code bleaddr}. */
    public String getBleAddress() {
        return bleAddress;
    }

    /** Manufacturing serial from JSON field {@code serial_number}. */
    public String getManufacturingSerial() {
        return manufacturingSerial;
    }
}
