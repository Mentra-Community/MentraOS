package com.mentra.asg_client.io.peripheral.events;

/** Physical button press reported by the MCU. */
public final class ButtonEvent extends McuEvent {

    /** The kind of button press that was reported. */
    public enum Type {
        /** Camera button short press ({@code cs_pho}, {@code hs_ntfy} msg="button click"). */
        CAMERA_SHORT_PRESS,
        /** Camera button long press ({@code cs_vdo}, {@code hs_ntfy} msg="button long click"). */
        CAMERA_LONG_PRESS,
        /** Power button short press ({@code sr_keyevt} button=0 type=0). */
        POWER_SHORT_PRESS
    }

    private final Type type;

    public ButtonEvent(Type type) {
        this.type = type;
    }

    public Type getType() {
        return type;
    }
}
