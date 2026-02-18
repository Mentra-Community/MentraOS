package com.mentra.asg_client.service.legacy.interfaces;

import org.json.JSONObject;
import java.util.Set;

/**
 * Interface for command handlers.
 * Each handler can process multiple related command types.
 * Follows Single Responsibility Principle by handling only specific command categories.
 */
public interface ICommandHandler {
    
    /**
     * Get all command types this handler can process
     * @return Set of command type strings
     */
    Set<String> getSupportedCommandTypes();
    
    /**
     * Process the command
     * @param commandType The specific command type being processed
     * @param data Command data
     * @return true if processed successfully, false otherwise
     */
    boolean handleCommand(String commandType, JSONObject data);
    
    /**
     * Check if this handler can process the given command
     * @param commandType Command type to check
     * @return true if can handle, false otherwise
     */
    default boolean canHandle(String commandType) {
        return getSupportedCommandTypes().contains(commandType);
    }
    
    /**
     * Get the primary command type for this handler (for backward compatibility)
     * @return Primary command type string
     */
    default String getPrimaryCommandType() {
        Set<String> types = getSupportedCommandTypes();
        return types.isEmpty() ? "" : types.iterator().next();
    }
} 