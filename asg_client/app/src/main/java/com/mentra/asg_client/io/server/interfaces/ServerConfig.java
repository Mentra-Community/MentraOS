package com.mentra.asg_client.io.server.interfaces;

import android.content.Context;

/**
 * Configuration interface for ASG servers.
 * Follows Interface Segregation Principle by providing only configuration-related methods.
 */
public interface ServerConfig {
    /**
     * Get the port number for the server
     */
    int getPort();
    
    /**
     * Get the server name/identifier
     */
    String getServerName();
    
    /**
     * Get the maximum request size in bytes
     */
    int getMaxRequestSize();
    
    /**
     * Get the request timeout in milliseconds
     */
    int getRequestTimeout();
    
    /**
     * Check if CORS is enabled
     */
    boolean isCorsEnabled();
    
    /**
     * Get allowed CORS origins
     */
    String[] getAllowedOrigins();
    
    /**
     * Get the Android context
     */
    Context getContext();
} 