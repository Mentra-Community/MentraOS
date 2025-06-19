package com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages;

import org.json.JSONObject;

/**
 * Event sent when a keep-alive ACK is received from the smart glasses.
 * This event is posted by SmartGlassesCommunicators when they receive
 * keep-alive acknowledgments from the glasses.
 */
public class KeepAliveAckEvent {
    // The original ACK message JSON from the glasses
    public final JSONObject ackMessage;
    
    /**
     * Create a new KeepAliveAckEvent
     * 
     * @param ackMessage The complete keep-alive ACK JSON message from glasses
     */
    public KeepAliveAckEvent(JSONObject ackMessage) {
        this.ackMessage = ackMessage;
    }
}