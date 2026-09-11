package com.mentra.asg_client.io.peripheral;

import android.util.Log;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Thread-safe {@link IPeripheralBus} backed by a {@link CopyOnWriteArrayList}. A subscriber that
 * throws while handling an event is logged and skipped so it cannot block delivery to the others.
 */
public final class SimplePeripheralBus implements IPeripheralBus {

    private static final String TAG = "PeripheralBus";

    private final CopyOnWriteArrayList<McuEventListener> listeners = new CopyOnWriteArrayList<>();

    @Override
    public void subscribe(McuEventListener listener) {
        if (listener != null) {
            listeners.addIfAbsent(listener);
        }
    }

    @Override
    public void unsubscribe(McuEventListener listener) {
        listeners.remove(listener);
    }

    @Override
    public void publish(McuEvent event) {
        if (event == null) {
            return;
        }
        for (McuEventListener listener : listeners) {
            try {
                listener.onMcuEvent(event);
            } catch (Exception e) {
                Log.e(TAG, "Subscriber threw on " + event.getClass().getSimpleName(), e);
                // Continue to next subscriber.
            }
        }
    }
}
