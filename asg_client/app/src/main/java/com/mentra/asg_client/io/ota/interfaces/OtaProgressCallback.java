package com.mentra.asg_client.io.ota.interfaces;

/**
 * Callback interface for receiving OTA progress updates.
 * Provides unified progress reporting for download and installation operations.
 */
public interface OtaProgressCallback {
    
    /**
     * Called when OTA check starts
     */
    void onOtaCheckStarted();
    
    /**
     * Called when OTA check completes
     * @param hasUpdate true if update is available, false otherwise
     * @param versionInfo Version information if available
     */
    void onOtaCheckCompleted(boolean hasUpdate, String versionInfo);
    
    /**
     * Called when OTA check fails
     * @param error Error message
     */
    void onOtaCheckFailed(String error);
    
    /**
     * Called when download starts
     * @param totalBytes Total bytes to download
     */
    void onDownloadStarted(long totalBytes);
    
    /**
     * Called when download progress updates
     * @param progress Progress percentage (0-100)
     * @param bytesDownloaded Bytes downloaded so far
     * @param totalBytes Total bytes to download
     */
    void onDownloadProgress(int progress, long bytesDownloaded, long totalBytes);
    
    /**
     * Called when download completes
     * @param apkPath Path to the downloaded APK
     */
    void onDownloadCompleted(String apkPath);
    
    /**
     * Called when download fails
     * @param error Error message
     */
    void onDownloadFailed(String error);
    
    /**
     * Called when installation starts
     * @param apkPath Path to the APK being installed
     */
    void onInstallationStarted(String apkPath);
    
    /**
     * Called when installation completes
     * @param apkPath Path to the installed APK
     */
    void onInstallationCompleted(String apkPath);
    
    /**
     * Called when installation fails
     * @param error Error message
     */
    void onInstallationFailed(String error);
    
    /**
     * Called when backup is created
     * @param backupPath Path to the backup file
     */
    void onBackupCreated(String backupPath);
    
    /**
     * Called when backup restoration starts
     * @param backupPath Path to the backup file
     */
    void onBackupRestorationStarted(String backupPath);
    
    /**
     * Called when backup restoration completes
     * @param backupPath Path to the backup file
     */
    void onBackupRestorationCompleted(String backupPath);
    
    /**
     * Called when backup restoration fails
     * @param error Error message
     */
    void onBackupRestorationFailed(String error);
    
    /**
     * Called when battery status changes
     * @param batteryLevel Battery level (0-100)
     * @param isCharging true if charging, false otherwise
     */
    void onBatteryStatusChanged(int batteryLevel, boolean isCharging);
    
    /**
     * Called when network status changes
     * @param isAvailable true if network is available, false otherwise
     */
    void onNetworkStatusChanged(boolean isAvailable);
} 