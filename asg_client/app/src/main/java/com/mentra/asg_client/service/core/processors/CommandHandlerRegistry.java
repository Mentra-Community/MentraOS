package com.mentra.asg_client.service.core.processors;

import android.util.Log;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;

/**
 * Command handler registry following Open/Closed Principle.
 * 
 * This class manages the registration and retrieval of command handlers.
 * It allows new handlers to be added without modifying existing code,
 * following the Open/Closed Principle.
 */
public class CommandHandlerRegistry {
    private static final String TAG = "CommandHandlerRegistry";
    private final Map<String, ICommandHandler> handlers = new HashMap<>();

    /**
     * Register a new command handler.
     * @param handler The command handler to register
     */
    public void registerHandler(ICommandHandler handler) {
        if (handler == null) {
            Log.w(TAG, "Attempted to register null handler");
            return;
        }
        
        Set<String> commandTypes = handler.getSupportedCommandTypes();
        if (commandTypes == null || commandTypes.isEmpty()) {
            Log.w(TAG, "Handler has no supported command types");
            return;
        }
        
        for (String commandType : commandTypes) {
            if (commandType != null && !commandType.trim().isEmpty()) {
                handlers.put(commandType, handler);
                Log.d(TAG, "✅ Registered command handler for: " + commandType);
            }
        }
    }

    /**
     * Get a handler for the specified command type.
     * @param type The command type to look up
     * @return The handler for the command type, or null if not found
     */
    public ICommandHandler getHandlerByCommandType(String type) {
        if (type == null || type.trim().isEmpty()) {
            Log.w(TAG, "Attempted to get handler for null or empty type");
            return null;
        }
        
        ICommandHandler handler = handlers.get(type);
        if (handler == null) {
            Log.d(TAG, "No handler found for command type: " + type);
        }
        return handler;
    }

    /**
     * Get the total number of registered handlers.
     * @return The number of registered handlers
     */
    public int getHandlerCount() {
        return handlers.size();
    }

    /**
     * Check if a handler exists for the specified command type.
     * @param type The command type to check
     * @return true if a handler exists, false otherwise
     */
    public boolean hasHandler(String type) {
        return type != null && handlers.containsKey(type);
    }

    /**
     * Remove a handler for the specified command type.
     * @param type The command type to remove
     * @return true if the handler was removed, false if it didn't exist
     */
    public boolean removeHandler(String type) {
        if (type == null) {
            return false;
        }
        
        ICommandHandler removed = handlers.remove(type);
        if (removed != null) {
            Log.d(TAG, "🗑️ Removed command handler for: " + type);
            return true;
        }
        return false;
    }

    /**
     * Get all registered command types.
     * @return Array of registered command types
     */
    public String[] getRegisteredCommandTypes() {
        return handlers.keySet().toArray(new String[0]);
    }

    /**
     * Clear all registered handlers.
     */
    public void clear() {
        int count = handlers.size();
        handlers.clear();
        Log.d(TAG, "🧹 Cleared " + count + " command handlers");
    }
} 