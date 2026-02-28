package com.mentra.asg_client.logging;

/**
 * Console-based implementation of Logger for non-Android platforms.
 * Follows Single Responsibility Principle by handling only logging.
 */
public class ConsoleLogger implements Logger {
    private static final String DEFAULT_TAG = "ASG_Server";
    
    @Override
    public void debug(String tag, String message) {
        System.out.println("[DEBUG] " + (tag != null ? tag : DEFAULT_TAG) + ": " + message);
    }
    
    @Override
    public void info(String tag, String message) {
        System.out.println("[INFO] " + (tag != null ? tag : DEFAULT_TAG) + ": " + message);
    }
    
    @Override
    public void warn(String tag, String message) {
        System.err.println("[WARN] " + (tag != null ? tag : DEFAULT_TAG) + ": " + message);
    }
    
    @Override
    public void error(String tag, String message) {
        System.err.println("[ERROR] " + (tag != null ? tag : DEFAULT_TAG) + ": " + message);
    }
    
    @Override
    public void error(String tag, String message, Throwable throwable) {
        System.err.println("[ERROR] " + (tag != null ? tag : DEFAULT_TAG) + ": " + message);
        throwable.printStackTrace();
    }
} 