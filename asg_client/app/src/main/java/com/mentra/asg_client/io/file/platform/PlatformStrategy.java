package com.mentra.asg_client.io.file.platform;

import com.mentra.asg_client.logging.Logger;
import java.io.File;

/**
 * Strategy interface for platform-specific operations.
 * Follows Open/Closed Principle by allowing new platforms without modifying existing code.
 */
public interface PlatformStrategy {
    
    /**
     * Get the base directory for file storage
     * @return Base directory
     */
    File getBaseDirectory();
    
    /**
     * Create a logger for this platform
     * @return Logger instance
     */
    Logger createLogger();
    
    /**
     * Get the platform name
     * @return Platform name
     */
    String getPlatformName();
    
    /**
     * Check if this platform is supported
     * @return true if supported, false otherwise
     */
    boolean isSupported();
} 