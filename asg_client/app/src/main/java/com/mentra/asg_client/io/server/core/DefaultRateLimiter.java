package com.mentra.asg_client.io.server.core;

import com.mentra.asg_client.io.server.interfaces.RateLimiter;
import com.mentra.asg_client.logging.Logger;

import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Default implementation of RateLimiter using sliding window approach.
 * Follows Single Responsibility Principle by handling only rate limiting.
 */
public class DefaultRateLimiter implements RateLimiter {
    private final int maxRequests;
    private final long timeWindow;
    private final ConcurrentHashMap<String, RequestWindow> clientWindows;
    private final ScheduledExecutorService cleanupExecutor;
    private final Logger logger;
    
    public DefaultRateLimiter(int maxRequests, long timeWindow, Logger logger) {
        this.maxRequests = maxRequests;
        this.timeWindow = timeWindow;
        this.clientWindows = new ConcurrentHashMap<>();
        this.logger = logger;
        
        // Schedule cleanup of expired windows
        this.cleanupExecutor = Executors.newSingleThreadScheduledExecutor();
        this.cleanupExecutor.scheduleWithFixedDelay(this::cleanupExpiredWindows,
                                               timeWindow, timeWindow, TimeUnit.MILLISECONDS);
    }
    
    @Override
    public boolean isAllowed(String clientId) {
        RequestWindow window = clientWindows.get(clientId);
        if (window == null) {
            return true;
        }
        
        long currentTime = System.currentTimeMillis();
        window.removeExpiredRequests(currentTime);
        
        boolean allowed = window.getRequestCount() < maxRequests;
        logger.debug("RateLimiter", String.format(Locale.getDefault(),"Client %s: %s (count: %d/%d)", clientId, allowed ? "ALLOWED" : "RATE_LIMITED", window.getRequestCount(), maxRequests));
        return allowed;
    }
    
    @Override
    public void recordRequest(String clientId) {
        long currentTime = System.currentTimeMillis();
        RequestWindow window = clientWindows.computeIfAbsent(clientId, 
                                                            k -> new RequestWindow());
        window.addRequest(currentTime);
        logger.debug("RateLimiter", String.format("Recorded request for client %s", clientId));
    }
    
    @Override
    public int getMaxRequests() {
        return maxRequests;
    }
    
    @Override
    public long getTimeWindow() {
        return timeWindow;
    }
    
    private void cleanupExpiredWindows() {
        long currentTime = System.currentTimeMillis();
        clientWindows.entrySet().removeIf(entry -> {
            RequestWindow window = entry.getValue();
            window.removeExpiredRequests(currentTime);
            return window.getRequestCount() == 0;
        });
        logger.debug("RateLimiter", "Cleaned up expired rate limit windows");
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
     * Internal class to track request timestamps for a client
     */
    private static class RequestWindow {
        private final java.util.List<Long> requestTimes = new java.util.ArrayList<>();
        
        public synchronized void addRequest(long timestamp) {
            requestTimes.add(timestamp);
        }
        
        public synchronized void removeExpiredRequests(long currentTime) {
            requestTimes.removeIf(time -> currentTime - time > 60000); // 1 minute window
        }
        
        public synchronized int getRequestCount() {
            return requestTimes.size();
        }
    }
} 