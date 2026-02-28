package com.mentra.asg_client.io.file.interfaces;

import java.io.File;

/**
 * Interface for package-level operations.
 * Follows Interface Segregation Principle by focusing only on package operations.
 */
public interface PackageOperations {
    
    /**
     * Get the package directory for a given package name
     * @param packageName The package name
     * @return Package directory File object
     */
    File getPackageDirectory(String packageName);
    
    /**
     * Ensure the package directory exists, creating it if necessary
     * @param packageName The package name
     * @return true if directory exists or was created successfully, false otherwise
     */
    boolean ensurePackageDirectoryExists(String packageName);
    
    /**
     * Get the total size of all files in a package
     * @param packageName The package name
     * @return Total size in bytes
     */
    long getPackageSize(String packageName);
    
    /**
     * Clean up old files in a package based on age
     * @param packageName The package name
     * @param maxAgeMs Maximum age in milliseconds
     * @return Number of files cleaned up
     */
    int cleanupOldFiles(String packageName, long maxAgeMs);
} 