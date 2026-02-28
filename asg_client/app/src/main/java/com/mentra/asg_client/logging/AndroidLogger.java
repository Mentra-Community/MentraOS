package com.mentra.asg_client.logging;

import android.util.Log;

/**
 * Android-specific implementation of Logger using Android's Log class.
 * Follows Single Responsibility Principle by handling only logging.
 */
public class AndroidLogger implements Logger {
    private static final String DEFAULT_TAG = "ASG_Server";
    
    @Override
    public void debug(String tag, String message) {
        Log.d(tag != null ? tag : DEFAULT_TAG, message);
    }
    
    @Override
    public void info(String tag, String message) {
        Log.i(tag != null ? tag : DEFAULT_TAG, message);
    }
    
    @Override
    public void warn(String tag, String message) {
        Log.w(tag != null ? tag : DEFAULT_TAG, message);
    }
    
    @Override
    public void error(String tag, String message) {
        Log.e(tag != null ? tag : DEFAULT_TAG, message);
    }
    
    @Override
    public void error(String tag, String message, Throwable throwable) {
        Log.e(tag != null ? tag : DEFAULT_TAG, message, throwable);
    }
} 