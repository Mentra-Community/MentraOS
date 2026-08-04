package com.mentra.asg_client.io.peripheral.events;

/** File transfer acknowledgment from the glasses (BES command {@code cs_flts}). */
public final class FileTransferAckEvent extends McuEvent {

    private final int state;
    private final int index;

    public FileTransferAckEvent(int state, int index) {
        this.state = state;
        this.index = index;
    }

    /** Transfer state from JSON field {@code state}. */
    public int getState() {
        return state;
    }

    /** Packet index from JSON field {@code index}. */
    public int getIndex() {
        return index;
    }
}
