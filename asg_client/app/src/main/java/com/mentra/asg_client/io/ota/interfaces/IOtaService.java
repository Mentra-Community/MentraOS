package com.mentra.asg_client.io.ota.interfaces;

import android.content.Context;

/**
 * Core interface for OTA (Over-The-Air) update services that provides unified
 * OTA operations across different update mechanisms and implementations.
 */
public interface IOtaService {
    
    /**
     * Initialize the OTA service
     * @param context Application context
     */
    void initialize(Context context);
    
    /**
     * Start the OTA service
     * @return true if service started successfully, false otherwise
     */
    boolean startService();
    
    /**
     * Stop the OTA service
     * @return true if service stopped successfully, false otherwise
     */
    boolean stopService();
    
    /**
     * Check if OTA service is running
     * @return true if service is running, false otherwise
     */
    boolean isServiceRunning();
    
    /**
     * Check for available updates
     * @return true if update check started successfully, false otherwise
     */
    boolean checkForUpdates();
    
    /**
     * Download an update
     * @param updateUrl URL of the update to download
     * @return true if download started successfully, false otherwise
     */
    boolean downloadUpdate(String updateUrl);
    
    /**
     * Install a downloaded update
     * @param apkPath Path to the APK file to install
     * @return true if installation started successfully, false otherwise
     */
    boolean installUpdate(String apkPath);
    
    /**
     * Get current OTA status
     * @return Current OTA status
     */
    OtaStatus getStatus();
    
    /**
     * Set OTA progress callback
     * @param callback The callback to receive OTA progress updates
     */
    void setProgressCallback(OtaProgressCallback callback);
    
    /**
     * Remove OTA progress callback
     */
    void removeProgressCallback();
    
    /**
     * Get OTA statistics
     * @return OTA statistics or null if not available
     */
    OtaStatistics getStatistics();
    
    /**
     * Cleanup resources when service is no longer needed
     */
    void shutdown();
    
    /**
     * OTA status enum
     */
    enum OtaStatus {
        IDLE,
        CHECKING,
        DOWNLOADING,
        INSTALLING,
        COMPLETED,
        FAILED
    }
    
    /**
     * OTA statistics interface
     */
    interface OtaStatistics {
        /**
         * Get last check time
         * @return Last check time in milliseconds
         */
        long getLastCheckTime();
        
        /**
         * Get total updates downloaded
         * @return Total number of updates downloaded
         */
        int getTotalUpdatesDownloaded();
        
        /**
         * Get total updates installed
         * @return Total number of updates installed
         */
        int getTotalUpdatesInstalled();
        
        /**
         * Get last update time
         * @return Last update time in milliseconds
         */
        long getLastUpdateTime();
        
        /**
         * Get current version
         * @return Current app version
         */
        String getCurrentVersion();
        
        /**
         * Get available version
         * @return Available version for update
         */
        String getAvailableVersion();
    }
} 