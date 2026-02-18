package com.mentra.asg_client.io.ota.utils;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * Utility class for OTA operations.
 * Provides common functionality used across different OTA implementations.
 */
public class OtaUtils {
    private static final String TAG = OtaConstants.TAG;
    
    /**
     * Get current app version code
     * @param context Application context
     * @return Current version code or -1 if not available
     */
    public static long getCurrentVersionCode(Context context) {
        try {
            PackageInfo packageInfo = context.getPackageManager()
                .getPackageInfo(context.getPackageName(), 0);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                return packageInfo.getLongVersionCode();
            } else {
                return packageInfo.versionCode;
            }
        } catch (PackageManager.NameNotFoundException e) {
            Log.e(TAG, "Failed to get current version code", e);
            return -1;
        }
    }
    
    /**
     * Get current app version name
     * @param context Application context
     * @return Current version name or null if not available
     */
    public static String getCurrentVersionName(Context context) {
        try {
            PackageInfo packageInfo = context.getPackageManager()
                .getPackageInfo(context.getPackageName(), 0);
            return packageInfo.versionName;
        } catch (PackageManager.NameNotFoundException e) {
            Log.e(TAG, "Failed to get current version name", e);
            return null;
        }
    }
    
    /**
     * Calculate MD5 hash of a file
     * @param file File to calculate hash for
     * @return MD5 hash string or null if failed
     */
    public static String calculateMd5(File file) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            FileInputStream fis = new FileInputStream(file);
            byte[] buffer = new byte[8192];
            int bytesRead;
            
            while ((bytesRead = fis.read(buffer)) != -1) {
                md.update(buffer, 0, bytesRead);
            }
            
            fis.close();
            
            byte[] digest = md.digest();
            StringBuilder sb = new StringBuilder();
            for (byte b : digest) {
                sb.append(String.format("%02x", b));
            }
            
            return sb.toString();
        } catch (NoSuchAlgorithmException | IOException e) {
            Log.e(TAG, "Failed to calculate MD5 hash", e);
            return null;
        }
    }
    
    /**
     * Verify APK file integrity
     * @param apkPath Path to the APK file
     * @param expectedMd5 Expected MD5 hash
     * @return true if verification successful, false otherwise
     */
    public static boolean verifyApkIntegrity(String apkPath, String expectedMd5) {
        if (apkPath == null || expectedMd5 == null) {
            Log.e(TAG, "APK path or expected MD5 is null");
            return false;
        }
        
        File apkFile = new File(apkPath);
        if (!apkFile.exists()) {
            Log.e(TAG, "APK file does not exist: " + apkPath);
            return false;
        }
        
        String actualMd5 = calculateMd5(apkFile);
        if (actualMd5 == null) {
            Log.e(TAG, "Failed to calculate MD5 for APK file");
            return false;
        }
        
        boolean isValid = actualMd5.equalsIgnoreCase(expectedMd5);
        if (!isValid) {
            Log.e(TAG, "MD5 verification failed. Expected: " + expectedMd5 + ", Actual: " + actualMd5);
        }
        
        return isValid;
    }
    
    /**
     * Format file size in bytes to human readable string
     * @param bytes File size in bytes
     * @return Formatted file size string
     */
    public static String formatFileSize(long bytes) {
        if (bytes < 1024) {
            return bytes + " B";
        } else if (bytes < 1024 * 1024) {
            return String.format("%.1f KB", bytes / 1024.0);
        } else if (bytes < 1024 * 1024 * 1024) {
            return String.format("%.1f MB", bytes / (1024.0 * 1024.0));
        } else {
            return String.format("%.1f GB", bytes / (1024.0 * 1024.0 * 1024.0));
        }
    }
    
    /**
     * Format download speed in bytes per second to human readable string
     * @param bytesPerSecond Download speed in bytes per second
     * @return Formatted speed string
     */
    public static String formatDownloadSpeed(long bytesPerSecond) {
        if (bytesPerSecond < 1024) {
            return bytesPerSecond + " B/s";
        } else if (bytesPerSecond < 1024 * 1024) {
            return String.format("%.1f KB/s", bytesPerSecond / 1024.0);
        } else {
            return String.format("%.1f MB/s", bytesPerSecond / (1024.0 * 1024.0));
        }
    }
    
    /**
     * Calculate download progress percentage.
     * @param bytesDownloaded Bytes downloaded so far
     * @param totalBytes Total bytes to download
     * @return Progress percentage (0-100)
     */
    public static int calculateProgress(long bytesDownloaded, long totalBytes) {
        if (totalBytes <= 0) {
            return 0;
        }

        int progress = (int) ((bytesDownloaded * 100) / totalBytes);
        return Math.min(progress, 100); // Ensure progress doesn't exceed 100%
    }
    
    /**
     * Check if device has sufficient storage space
     * @param requiredBytes Required bytes for the update
     * @return true if sufficient space available, false otherwise
     */
    public static boolean hasSufficientStorage(long requiredBytes) {
        File baseDir = new File(OtaConstants.BASE_DIR);
        if (!baseDir.exists()) {
            baseDir.mkdirs();
        }
        
        long availableSpace = baseDir.getFreeSpace();
        return availableSpace >= requiredBytes;
    }
    
    /**
     * Create backup directory if it doesn't exist
     * @return true if directory created or exists, false otherwise
     */
    public static boolean ensureBackupDirectory() {
        File backupDir = new File(OtaConstants.BASE_DIR);
        if (!backupDir.exists()) {
            return backupDir.mkdirs();
        }
        return true;
    }
    
    /**
     * Clean up old APK files
     * @param keepLatestCount Number of latest files to keep
     */
    public static void cleanupOldApkFiles(int keepLatestCount) {
        File baseDir = new File(OtaConstants.BASE_DIR);
        if (!baseDir.exists()) {
            return;
        }
        
        File[] apkFiles = baseDir.listFiles((dir, name) -> name.endsWith(".apk"));
        if (apkFiles == null || apkFiles.length <= keepLatestCount) {
            return;
        }
        
        // Sort files by last modified time (oldest first)
        java.util.Arrays.sort(apkFiles, (f1, f2) -> Long.compare(f1.lastModified(), f2.lastModified()));
        
        // Delete oldest files
        int filesToDelete = apkFiles.length - keepLatestCount;
        for (int i = 0; i < filesToDelete; i++) {
            if (apkFiles[i].delete()) {
                Log.d(TAG, "Deleted old APK file: " + apkFiles[i].getName());
            } else {
                Log.w(TAG, "Failed to delete old APK file: " + apkFiles[i].getName());
            }
        }
    }
    
    /**
     * Check if APK file is valid
     * @param apkPath Path to the APK file
     * @return true if APK is valid, false otherwise
     */
    public static boolean isValidApkFile(String apkPath) {
        if (apkPath == null) {
            return false;
        }
        
        File apkFile = new File(apkPath);
        if (!apkFile.exists()) {
            return false;
        }
        
        // Check if file has .apk extension
        if (!apkPath.toLowerCase().endsWith(".apk")) {
            return false;
        }
        
        // Check if file size is reasonable (at least 1MB)
        if (apkFile.length() < 1024 * 1024) {
            return false;
        }
        
        return true;
    }
    
    /**
     * Get available storage space in bytes
     * @return Available storage space in bytes
     */
    public static long getAvailableStorageSpace() {
        File baseDir = new File(OtaConstants.BASE_DIR);
        if (!baseDir.exists()) {
            baseDir.mkdirs();
        }
        return baseDir.getFreeSpace();
    }
    
    /**
     * Convert int to byte array (little-endian)
     * @param value Integer value to convert
     * @return 4-byte array
     */
    public static byte[] int2Bytes(int value) {
        byte[] src = new byte[4];
        src[3] = (byte) ((value >> 24) & 0xFF);
        src[2] = (byte) ((value >> 16) & 0xFF);
        src[1] = (byte) ((value >> 8) & 0xFF);
        src[0] = (byte) (value & 0xFF);
        return src;
    }

    /**
     * Convert long to byte array (little-endian)
     * @param value Long value to convert
     * @return 4-byte array
     */
    public static byte[] long2Bytes(long value) {
        byte[] src = new byte[4];
        src[3] = (byte) ((value >> 24) & 0xFF);
        src[2] = (byte) ((value >> 16) & 0xFF);
        src[1] = (byte) ((value >> 8) & 0xFF);
        src[0] = (byte) (value & 0xFF);
        return src;
    }

    /**
     * Calculate CRC32 checksum
     * @param data Data to calculate checksum for
     * @param offset Starting offset in data array
     * @param length Number of bytes to include
     * @return CRC32 value
     */
    public static long crc32(byte[] data, int offset, int length) {
        java.util.zip.CRC32 crc32 = new java.util.zip.CRC32();
        crc32.update(data, offset, length);
        return crc32.getValue();
    }

    /**
     * Convert byte array to int (little-endian)
     * @param src Source byte array
     * @param offset Starting offset
     * @param len Number of bytes to read
     * @return Integer value
     */
    public static int bytes2Int(byte[] src, int offset, int len) {
        if (src == null || offset + len > src.length) {
            return 0;
        }
        int v = 0;
        for (int i = offset + len - 1; i >= offset; i--) {
            v = (v << 8);
            v += (src[i] < 0) ? (256 + src[i]) : src[i];
        }
        return v;
    }
} 