package com.mentra.asg_client.service.system.interfaces;

import android.content.Intent;

/**
 * Interface for event handlers.
 * Follows Single Responsibility Principle by handling only specific event types.
 */
public interface IEventHandler {
    
    /**
     * Get the event type this handler can process
     * @return Event type string
     */
    String getEventType();
    
    /**
     * Handle the event
     * @param intent Intent containing event data
     * @return true if handled successfully, false otherwise
     */
    boolean handleEvent(Intent intent);
    
    /**
     * Check if this handler can process the given event
     * @param eventType Event type to check
     * @return true if can handle, false otherwise
     */
    default boolean canHandle(String eventType) {
        return getEventType().equals(eventType);
    }
} 