package com.mentra.asg_client.io.peripheral;

import com.mentra.asg_client.io.peripheral.events.McuEvent;

/**
 * In-process event bus carrying typed {@link McuEvent}s parsed from BES/MCU UART traffic to any
 * number of subscribers. Decouples raw command parsing from the business logic that reacts to it.
 */
public interface IPeripheralBus {

    /** Listener notified whenever an {@link McuEvent} is published on the bus. */
    interface McuEventListener {
        void onMcuEvent(McuEvent event);
    }

    /** Register a listener. Registering the same listener twice has no additional effect. */
    void subscribe(McuEventListener listener);

    /** Remove a previously registered listener. */
    void unsubscribe(McuEventListener listener);

    /** Deliver an event to all registered listeners. */
    void publish(McuEvent event);
}
