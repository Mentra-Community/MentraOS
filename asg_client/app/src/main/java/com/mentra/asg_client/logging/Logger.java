package com.mentra.asg_client.logging;

/**
 * Logging interface for server operations.
 * Follows Interface Segregation Principle by providing only logging methods.
 */
public interface Logger {
    /**
     * Log a debug message
     * @param tag Log tag
     * @param message Log message
     */
    void debug(String tag, String message);
    
    /**
     * Log an info message
     * @param tag Log tag
     * @param message Log message
     */
    void info(String tag, String message);
    
    /**
     * Log a warning message
     * @param tag Log tag
     * @param message Log message
     */
    void warn(String tag, String message);
    
    /**
     * Log an error message
     * @param tag Log tag
     * @param message Log message
     */
    void error(String tag, String message);
    
    /**
     * Log an error message with exception
     * @param tag Log tag
     * @param message Log message
     * @param throwable Exception to log
     */
    void error(String tag, String message, Throwable throwable);
} 