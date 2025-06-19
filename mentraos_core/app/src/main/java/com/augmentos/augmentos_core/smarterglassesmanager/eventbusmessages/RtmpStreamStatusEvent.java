package com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages;

import org.json.JSONObject;

/**
 * Event sent when RTMP streaming status changes on the smart glasses.
 * This event is posted by SmartGlassesCommunicators when they receive
 * RTMP stream status updates from the glasses.
 */
public class RtmpStreamStatusEvent {
    // The original status message JSON from the glasses
    public final JSONObject statusMessage;
    
    /**
     * Create a new RtmpStreamStatusEvent
     * 
     * @param statusMessage The complete RTMP status JSON message from glasses
     */
    public RtmpStreamStatusEvent(JSONObject statusMessage) {
        this.statusMessage = statusMessage;
    }
}