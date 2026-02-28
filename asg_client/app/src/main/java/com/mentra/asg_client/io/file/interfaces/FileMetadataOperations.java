package com.mentra.asg_client.io.file.interfaces;

import com.mentra.asg_client.io.file.core.FileManager.FileMetadata;
import java.util.List;

/**
 * Interface for file metadata operations.
 * Follows Interface Segregation Principle by focusing only on metadata operations.
 */
public interface FileMetadataOperations {
    
    /**
     * Get metadata for a specific file
     * @param packageName The package name
     * @param fileName The file name
     * @return File metadata or null if not found
     */
    FileMetadata getFileMetadata(String packageName, String fileName);
    
    /**
     * List all files in a package with their metadata
     * @param packageName The package name
     * @return List of file metadata
     */
    List<FileMetadata> listFiles(String packageName);
    
    /**
     * Check if a file exists
     * @param packageName The package name
     * @param fileName The file name
     * @return true if file exists, false otherwise
     */
    boolean fileExists(String packageName, String fileName);
} 