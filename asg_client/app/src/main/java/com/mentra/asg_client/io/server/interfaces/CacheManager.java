package com.mentra.asg_client.io.server.interfaces;

/**
 * Cache management interface for storing and retrieving data.
 * Follows Interface Segregation Principle by providing only caching methods.
 */
public interface CacheManager {
    /**
     * Store a value in the cache
     * @param key Cache key
     * @param value Value to store
     * @param ttlMs Time to live in milliseconds
     */
    void put(String key, Object value, long ttlMs);
    
    /**
     * Retrieve a value from the cache
     * @param key Cache key
     * @return Cached value or null if not found/expired
     */
    Object get(String key);
    
    /**
     * Remove a value from the cache
     * @param key Cache key
     */
    void remove(String key);
    
    /**
     * Clear all cached data
     */
    void clear();
    
    /**
     * Get cache statistics
     * @return Cache statistics as a string
     */
    String getStats();
    
    /**
     * Get the current number of items in the cache
     * @return Number of cached items
     */
    int size();
} 