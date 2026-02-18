package com.mentra.asg_client.io.file.platform;

import java.util.HashMap;
import java.util.Map;

/**
 * Registry for platform strategies.
 * Follows Open/Closed Principle by allowing new platforms without modifying existing code.
 */
public class PlatformRegistry {
    
    private static final Map<String, PlatformStrategy> strategies = new HashMap<>();
    
    static {
        // Register default strategies
        strategies.put("java_se", new JavaSEPlatformStrategy());
    }
    
    /**
     * Register a new platform strategy
     * @param name The platform name
     * @param strategy The platform strategy
     */
    public static void registerStrategy(String name, PlatformStrategy strategy) {
        strategies.put(name.toLowerCase(), strategy);
    }
    
    /**
     * Get a platform strategy by name
     * @param name The platform name
     * @return Platform strategy or null if not found
     */
    public static PlatformStrategy getStrategy(String name) {
        return strategies.get(name.toLowerCase());
    }
    
    /**
     * Auto-detect platform strategy
     * @return Platform strategy for the current platform
     */
    public static PlatformStrategy detectPlatform() {
        try {
            // Try to detect Android
            Class.forName("android.content.Context");
            // If we reach here, we're on Android but no context provided
            throw new IllegalStateException("Android detected but no Context provided. Use AndroidPlatformStrategy(Context) instead.");
        } catch (ClassNotFoundException e) {
            // Not Android, use Java SE
            return new JavaSEPlatformStrategy();
        }
    }
    
    /**
     * Get all registered platform names
     * @return Array of platform names
     */
    public static String[] getRegisteredPlatforms() {
        return strategies.keySet().toArray(new String[0]);
    }
} 