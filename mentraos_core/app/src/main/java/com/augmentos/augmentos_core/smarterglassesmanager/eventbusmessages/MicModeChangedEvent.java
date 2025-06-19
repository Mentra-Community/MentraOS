package com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages;

import com.augmentos.augmentos_core.smarterglassesmanager.hci.PhoneMicrophoneManager;

/**
 * Event that signals a change in microphone mode
 */
public class MicModeChangedEvent {
    private final PhoneMicrophoneManager.MicStatus status;
    
    public MicModeChangedEvent(PhoneMicrophoneManager.MicStatus status) {
        this.status = status;
    }
    
    public PhoneMicrophoneManager.MicStatus getStatus() {
        return status;
    }
    
    @Override
    public String toString() {
        return "MicModeChangedEvent: " + status.name();
    }
}
