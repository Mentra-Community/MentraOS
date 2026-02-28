package com.mentra.asg_client.service.system.interfaces;

import android.os.Bundle;

/**
 * Interface for service lifecycle management.
 * Follows Interface Segregation Principle by providing focused lifecycle methods.
 */
public interface IServiceLifecycle {
    
    /**
     * Initialize the service components
     */
    void initialize();
    
    /**
     * Handle service startup
     */
    void onStart();
    
    /**
     * Handle service action
     * @param action The action to handle
     * @param extras Additional data
     */
    void handleAction(String action, Bundle extras);
    
    /**
     * Clean up service resources
     */
    void cleanup();
    
    /**
     * Check if service is initialized
     * @return true if initialized, false otherwise
     */
    boolean isInitialized();
} 