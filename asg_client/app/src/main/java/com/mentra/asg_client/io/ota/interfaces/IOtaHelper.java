package com.mentra.asg_client.io.ota.interfaces;

import android.content.Context;

/**
 * Core interface for OTA (Over-The-Air) helper operations that provides unified
 * OTA helper functionality across different update mechanisms.
 */
public interface IOtaHelper {
    
    /**
     * Initialize the OTA helper
     * @param context Application context
     */
    void initialize(Context context);
    
    /**
     * Start version checking
     * @param context Application context
     * @return true if version check started successfully, false otherwise
     */
    boolean startVersionCheck(Context context);
    
    /**
     * Check if version checking is in progress
     * @return true if checking, false otherwise
     */
    boolean isCheckingVersion();
    
    /**
     * Check if update is in progress
     * @return true if updating, false otherwise
     */
    boolean isUpdating();
    
    /**
     * Download APK file
     * @param urlStr URL of the APK to download
     * @param json Metadata JSON object
     * @param context Application context
     * @return true if download started successfully, false otherwise
     */
    boolean downloadApk(String urlStr, org.json.JSONObject json, Context context);
    
    /**
     * Download APK file with custom filename
     * @param urlStr URL of the APK to download
     * @param json Metadata JSON object
     * @param context Application context
     * @param filename Custom filename for the APK
     * @return true if download started successfully, false otherwise
     */
    boolean downloadApk(String urlStr, org.json.JSONObject json, Context context, String filename);
    
    /**
     * Install APK file
     * @param context Application context
     * @return true if installation started successfully, false otherwise
     */
    boolean installApk(Context context);
    
    /**
     * Install APK file from specific path
     * @param context Application context
     * @param apkPath Path to the APK file
     * @return true if installation started successfully, false otherwise
     */
    boolean installApk(Context context, String apkPath);
    
    /**
     * Check for older APK files
     * @param context Application context
     */
    void checkOlderApkFile(Context context);
    
    /**
     * Reinstall APK from backup
     * @return true if reinstallation started successfully, false otherwise
     */
    boolean reinstallApkFromBackup();
    
    /**
     * Save backup APK
     * @param sourceApkPath Path to the source APK
     * @return true if backup saved successfully, false otherwise
     */
    boolean saveBackupApk(String sourceApkPath);
    
    /**
     * Get battery status string
     * @return Battery status string
     */
    String getBatteryStatusString();
    
    /**
     * Get last battery update time
     * @return Last battery update time in milliseconds
     */
    long getLastBatteryUpdateTime();
    
    /**
     * Check if battery is sufficient for updates
     * @return true if battery is sufficient, false otherwise
     */
    boolean isBatterySufficientForUpdates();
    
    /**
     * Start periodic checks
     */
    void startPeriodicChecks();
    
    /**
     * Stop periodic checks
     */
    void stopPeriodicChecks();
    
    /**
     * Register network callback
     * @param context Application context
     */
    void registerNetworkCallback(Context context);
    
    /**
     * Unregister network callback
     */
    void unregisterNetworkCallback();
    
    /**
     * Check if network is available
     * @param context Application context
     * @return true if network is available, false otherwise
     */
    boolean isNetworkAvailable(Context context);
    
    /**
     * Cleanup resources when helper is no longer needed
     */
    void cleanup();
} 