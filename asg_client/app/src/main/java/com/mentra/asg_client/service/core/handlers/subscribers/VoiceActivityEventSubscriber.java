package com.mentra.asg_client.service.core.handlers.subscribers;

import android.util.Log;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.io.peripheral.events.VoiceActivityEvent;

/**
 * Reacts to {@link VoiceActivityEvent}s. These are logged only; no further processing is needed.
 * Moved verbatim from {@code K900CommandHandler.handleVoiceActivityDetection}.
 */
public final class VoiceActivityEventSubscriber implements IPeripheralBus.McuEventListener {

    private static final String TAG = "VoiceActivityEventSubscriber";

    @Override
    public void onMcuEvent(McuEvent event) {
        if (!(event instanceof VoiceActivityEvent)) {
            return;
        }
        boolean active = ((VoiceActivityEvent) event).isActive();
        Log.d(TAG, "🎤 Voice Activity Detection event received - VAD " + (active ? "ON" : "OFF"));
    }
}
