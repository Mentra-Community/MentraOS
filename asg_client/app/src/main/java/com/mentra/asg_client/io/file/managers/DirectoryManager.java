package com.mentra.asg_client.io.file.managers;

import com.mentra.asg_client.logging.Logger;
import java.io.File;
import java.util.ArrayList;
import java.util.List;

/**
 * Manages directory operations and structure.
 * Follows Single Responsibility Principle by handling only directory operations.
 */
public class DirectoryManager {
    
    private static final String TAG = "DirectoryManager";
    
    private final File baseDirectory;
    private final Logger logger;
    
    public DirectoryManager(File baseDirectory, Logger logger) {
        this.baseDirectory = baseDirectory;
        this.logger = logger;
        ensureBaseDirectoryExists();
    }
    
    /**
     * Ensure the base directory exists
     */
    private void ensureBaseDirectoryExists() {
        if (!baseDirectory.exists()) {
            if (baseDirectory.mkdirs()) {
                logger.info(TAG, "Created base directory: " + baseDirectory.getAbsolutePath());
            } else {
                logger.error(TAG, "Failed to create base directory: " + baseDirectory.getAbsolutePath());
            }
        }
    }
    
    /**
     * Get the base directory
     * @return Base directory
     */
    public File getBaseDirectory() {
        return baseDirectory;
    }
    
    /**
     * Get package directory
     * @param packageName The package name
     * @return Package directory
     */
    public File getPackageDirectory(String packageName) {
        return new File(baseDirectory, sanitizePackageName(packageName));
    }
    
    /**
     * Create package directory if it doesn't exist
     * @param packageName The package name
     * @return true if created or exists, false otherwise
     */
    public boolean ensurePackageDirectoryExists(String packageName) {
        File packageDir = getPackageDirectory(packageName);
        if (!packageDir.exists()) {
            if (packageDir.mkdirs()) {
                logger.debug(TAG, "Created package directory: " + packageDir.getAbsolutePath());
                return true;
            } else {
                logger.error(TAG, "Failed to create package directory: " + packageDir.getAbsolutePath());
                return false;
            }
        }
        return true;
    }
    
    /**
     * List all package directories
     * @return List of package directories
     */
    public List<File> listPackageDirectories() {
        List<File> packageDirs = new ArrayList<>();
        if (baseDirectory.exists() && baseDirectory.isDirectory()) {
            File[] dirs = baseDirectory.listFiles(File::isDirectory);
            if (dirs != null) {
                for (File dir : dirs) {
                    packageDirs.add(dir);
                }
            }
        }
        logger.debug(TAG, "Found " + packageDirs.size() + " package directories");
        return packageDirs;
    }
    
    /**
     * Get total size of all package directories
     * @return Total size in bytes
     */
    public long getTotalSize() {
        long totalSize = 0;
        List<File> packageDirs = listPackageDirectories();
        for (File packageDir : packageDirs) {
            totalSize += calculateDirectorySize(packageDir);
        }
        logger.debug(TAG, "Total directory size: " + totalSize + " bytes");
        return totalSize;
    }
    
    /**
     * Calculate size of a directory recursively
     * @param directory The directory to calculate size for
     * @return Size in bytes
     */
    private long calculateDirectorySize(File directory) {
        long size = 0;
        if (directory.exists() && directory.isDirectory()) {
            File[] files = directory.listFiles();
            if (files != null) {
                for (File file : files) {
                    if (file.isFile()) {
                        size += file.length();
                    } else if (file.isDirectory()) {
                        size += calculateDirectorySize(file);
                    }
                }
            }
        }
        return size;
    }
    
    /**
     * Sanitize package name for directory creation
     * @param packageName The package name
     * @return Sanitized package name
     */
    private String sanitizePackageName(String packageName) {
        return packageName.replaceAll("[^a-zA-Z0-9._-]", "_");
    }
} 