package com.mentra.asg_client.io.server.core;

import com.mentra.asg_client.io.server.interfaces.CacheManager;
import com.mentra.asg_client.logging.Logger;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Default implementation of CacheManager with TTL support.
 * Follows Single Responsibility Principle by handling only caching.
 */
public class DefaultCacheManager implements CacheManager {
    private final ConcurrentHashMap<String, CacheEntry> cache;
    private final ScheduledExecutorService cleanupExecutor;
    private final Logger logger;
    private final AtomicLong hits;
    private final AtomicLong misses;
    
    public DefaultCacheManager(Logger logger) {
        this.cache = new ConcurrentHashMap<>();
        this.logger = logger;
        this.hits = new AtomicLong(0);
        this.misses = new AtomicLong(0);
        
        // Schedule cleanup of expired entries
        this.cleanupExecutor = Executors.newSingleThreadScheduledExecutor();
        this.cleanupExecutor.scheduleAtFixedRate(this::cleanupExpiredEntries, 
                                               1, 1, TimeUnit.MINUTES);
    }
    
    @Override
    public void put(String key, Object value, long ttlMs) {
        long expiryTime = System.currentTimeMillis() + ttlMs;
        CacheEntry entry = new CacheEntry(value, expiryTime);
        cache.put(key, entry);
        logger.debug("CacheManager", String.format("Cached key: %s (TTL: %dms)", key, ttlMs));
    }
    
    @Override
    public Object get(String key) {
        CacheEntry entry = cache.get(key);
        if (entry == null) {
            misses.incrementAndGet();
            logger.debug("CacheManager", String.format("Cache MISS for key: %s", key));
            return null;
        }
        
        if (entry.isExpired()) {
            cache.remove(key);
            misses.incrementAndGet();
            logger.debug("CacheManager", String.format("Cache EXPIRED for key: %s", key));
            return null;
        }
        
        hits.incrementAndGet();
        logger.debug("CacheManager", String.format("Cache HIT for key: %s", key));
        return entry.getValue();
    }
    
    @Override
    public void remove(String key) {
        CacheEntry removed = cache.remove(key);
        if (removed != null) {
            logger.debug("CacheManager", String.format("Removed key: %s", key));
        }
    }
    
    @Override
    public void clear() {
        int size = cache.size();
        cache.clear();
        logger.info("CacheManager", String.format("Cleared cache (%d entries)", size));
    }
    
    @Override
    public String getStats() {
        long totalRequests = hits.get() + misses.get();
        double hitRate = totalRequests > 0 ? (double) hits.get() / totalRequests * 100 : 0;
        
        return String.format("Cache Stats - Size: %d, Hits: %d, Misses: %d, Hit Rate: %.2f%%", 
                           cache.size(), hits.get(), misses.get(), hitRate);
    }
    
    @Override
    public int size() {
        return cache.size();
    }
    
    private void cleanupExpiredEntries() {
        long currentTime = System.currentTimeMillis();
        int removed = 0;
        
        for (java.util.Map.Entry<String, CacheEntry> entry : cache.entrySet()) {
            if (entry.getValue().isExpired(currentTime)) {
                cache.remove(entry.getKey());
                removed++;
            }
        }
        
        if (removed > 0) {
            logger.debug("CacheManager", String.format("Cleaned up %d expired entries", removed));
        }
    }
    
    public void shutdown() {
        cleanupExecutor.shutdown();
        try {
            if (!cleanupExecutor.awaitTermination(5, TimeUnit.SECONDS)) {
                cleanupExecutor.shutdownNow();
            }
        } catch (InterruptedException e) {
            cleanupExecutor.shutdownNow();
            Thread.currentThread().interrupt();
        }
    }
    
    /**
     * Internal class to store cache entries with expiry time
     */
    private static class CacheEntry {
        private final Object value;
        private final long expiryTime;
        
        public CacheEntry(Object value, long expiryTime) {
            this.value = value;
            this.expiryTime = expiryTime;
        }
        
        public Object getValue() {
            return value;
        }
        
        public boolean isExpired() {
            return isExpired(System.currentTimeMillis());
        }
        
        public boolean isExpired(long currentTime) {
            return currentTime > expiryTime;
        }
    }
} 