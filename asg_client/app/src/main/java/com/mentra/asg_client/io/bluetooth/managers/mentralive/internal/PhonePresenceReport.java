package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

/** Strict decoding of the BES numeric 0/1 presence fields; malformed data is not absence. */
public final class PhonePresenceReport {
    private PhonePresenceReport() {}

    public static Boolean parse(Object value) {
        if (!(value instanceof Number)) return null;
        double number = ((Number) value).doubleValue();
        if (number == 0) return false;
        if (number == 1) return true;
        return null;
    }
}
