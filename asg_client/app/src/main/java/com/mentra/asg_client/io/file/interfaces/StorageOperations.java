package com.mentra.asg_client.io.file.interfaces;

/**
 * Interface for storage-level operations.
 * Follows Interface Segregation Principle by focusing only on storage operations.
 */
public interface StorageOperations {
    
    /**
     * Get available storage space
     * @return Available space in bytes
     */
    long getAvailableSpace();
    
    /**
     * Get total storage space
     * @return Total space in bytes
     */
    long getTotalSpace();
} 