package com.mentra.asg_client.io.server.interfaces;

/**
 * Rate limiting interface for controlling request frequency.
 * Follows Interface Segregation Principle by providing only rate limiting methods.
 */
public interface RateLimiter {
    /**
     * Check if a request from the given client is allowed
     * @param clientId Unique identifier for the client
     * @return true if request is allowed, false if rate limited
     */
    boolean isAllowed(String clientId);
    
    /**
     * Record a request from the given client
     * @param clientId Unique identifier for the client
     */
    void recordRequest(String clientId);
    
    /**
     * Get the maximum requests per time window
     */
    int getMaxRequests();
    
    /**
     * Get the time window in milliseconds
     */
    long getTimeWindow();
} 