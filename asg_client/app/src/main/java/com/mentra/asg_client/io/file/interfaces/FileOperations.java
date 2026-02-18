package com.mentra.asg_client.io.file.interfaces;

import com.mentra.asg_client.io.file.core.FileManager.FileOperationResult;
import java.io.InputStream;

/**
 * Interface for basic file operations.
 * Follows Interface Segregation Principle by focusing only on file operations.
 */
public interface FileOperations {
    
    /**
     * Save a file to the specified package
     * @param packageName The package name
     * @param fileName The file name
     * @param inputStream The file content
     * @param mimeType The MIME type
     * @return Operation result
     */
    FileOperationResult saveFile(String packageName, String fileName, InputStream inputStream, String mimeType);
    
    /**
     * Get a file from the specified package
     * @param packageName The package name
     * @param fileName The file name
     * @return The file or null if not found
     */
    java.io.File getFile(String packageName, String fileName);
    
    /**
     * Delete a file from the specified package
     * @param packageName The package name
     * @param fileName The file name
     * @return Operation result
     */
    FileOperationResult deleteFile(String packageName, String fileName);
    
    /**
     * Update an existing file in the specified package
     * @param packageName The package name
     * @param fileName The file name
     * @param inputStream The new file content
     * @param mimeType The MIME type
     * @return Operation result
     */
    FileOperationResult updateFile(String packageName, String fileName, InputStream inputStream, String mimeType);
} 