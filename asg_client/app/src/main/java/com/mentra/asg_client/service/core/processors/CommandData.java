package com.mentra.asg_client.service.core.processors;

import androidx.annotation.NonNull;

import org.json.JSONObject;

import java.util.Locale;

/**
 * Command data container following Single Responsibility Principle.
 * 
 * This record encapsulates the essential data needed for command processing:
 * - type: The command type identifier
 * - data: The JSON payload containing command parameters
 * - messageId: Unique identifier for message tracking and acknowledgment
 */
public record CommandData(String type, JSONObject data, long messageId) {
    
    /**
     * Check if this command has a valid message ID for acknowledgment.
     * @return true if messageId is not -1, false otherwise
     */
    public boolean hasMessageId() {
        return messageId != -1;
    }
    
    /**
     * Check if this command has a valid type.
     * @return true if type is not null or empty, false otherwise
     */
    public boolean hasValidType() {
        return type != null && !type.trim().isEmpty();
    }
    
    /**
     * Check if this command has valid data.
     * @return true if data is not null, false otherwise
     */
    public boolean hasValidData() {
        return data != null;
    }
    
    @NonNull
    @Override
    public String toString() {
        return String.format(Locale.getDefault(),"CommandData{type='%s', messageId=%d, hasData=%s}",
                type, messageId, data != null);
    }
} 