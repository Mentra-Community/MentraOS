package com.mentra.asg_client.io.file.managers;

import com.mentra.asg_client.logging.Logger;
import com.mentra.asg_client.io.file.core.FileManager.FileOperationResult;
import com.mentra.asg_client.io.file.utils.MimeTypeRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;

/**
 * Manages file operations.
 * Follows Single Responsibility Principle by handling only file operations.
 */
public class FileOperationsManager {
    
    private static final String TAG = "FileOperationsManager";
    
    private final File baseDirectory;
    private final Logger logger;
    private final MimeTypeRegistry mimeTypeRegistry;
    
    public FileOperationsManager(File baseDirectory, Logger logger) {
        this.baseDirectory = baseDirectory;
        this.logger = logger;
        this.mimeTypeRegistry = new MimeTypeRegistry();
    }
    
    /**
     * Save a file to the specified package
     * @param packageName The package name
     * @param fileName The file name
     * @param inputStream The file content
     * @param mimeType The MIME type
     * @return Operation result
     */
    public FileOperationResult saveFile(String packageName, String fileName, InputStream inputStream, String mimeType) {
        try {
            File packageDir = new File(baseDirectory, packageName);
            if (!packageDir.exists() && !packageDir.mkdirs()) {
                logger.error(TAG, "Failed to create package directory: " + packageDir.getAbsolutePath());
                return FileOperationResult.error("Failed to create package directory");
            }
            
            File targetFile = new File(packageDir, fileName);
            File tempFile = new File(packageDir, fileName + ".tmp");
            
            // Write to temporary file first
            try (FileOutputStream fos = new FileOutputStream(tempFile)) {
                byte[] buffer = new byte[8192];
                int bytesRead;
                while ((bytesRead = inputStream.read(buffer)) != -1) {
                    fos.write(buffer, 0, bytesRead);
                }
            }
            
            // Atomic move to target file
            Files.move(tempFile.toPath(), targetFile.toPath(), StandardCopyOption.REPLACE_EXISTING);
            
            logger.info(TAG, "File saved successfully: " + targetFile.getAbsolutePath());
            return FileOperationResult.success("File saved successfully", targetFile.getAbsolutePath());
            
        } catch (IOException e) {
            logger.error(TAG, "Error saving file: " + fileName, e);
            return FileOperationResult.error("Error saving file: " + e.getMessage());
        }
    }
    
    /**
     * Get a file from the specified package
     * @param packageName The package name
     * @param fileName The file name
     * @return The file or null if not found
     */
    public File getFile(String packageName, String fileName) {
        File packageDir = new File(baseDirectory, packageName);
        File file = new File(packageDir, fileName);
        
        if (file.exists() && file.isFile()) {
            logger.debug(TAG, "File found: " + file.getAbsolutePath());
            return file;
        } else {
            logger.debug(TAG, "File not found: " + file.getAbsolutePath());
            return null;
        }
    }
    
    /**
     * Delete a file from the specified package
     * @param packageName The package name
     * @param fileName The file name
     * @return Operation result
     */
    public FileOperationResult deleteFile(String packageName, String fileName) {
        try {
            File file = getFile(packageName, fileName);
            if (file == null) {
                return FileOperationResult.error("File not found");
            }
            
            if (file.delete()) {
                logger.info(TAG, "File deleted successfully: " + file.getAbsolutePath());
                return FileOperationResult.success("File deleted successfully", file.getAbsolutePath());
            } else {
                logger.error(TAG, "Failed to delete file: " + file.getAbsolutePath());
                return FileOperationResult.error("Failed to delete file");
            }
            
        } catch (Exception e) {
            logger.error(TAG, "Error deleting file: " + fileName, e);
            return FileOperationResult.error("Error deleting file: " + e.getMessage());
        }
    }
    
    /**
     * Update an existing file in the specified package
     * @param packageName The package name
     * @param fileName The file name
     * @param inputStream The new file content
     * @param mimeType The MIME type
     * @return Operation result
     */
    public FileOperationResult updateFile(String packageName, String fileName, InputStream inputStream, String mimeType) {
        // Check if file exists
        File existingFile = getFile(packageName, fileName);
        if (existingFile == null) {
            return FileOperationResult.error("File not found for update");
        }
        
        // Use saveFile with atomic operation (it will replace existing file)
        return saveFile(packageName, fileName, inputStream, mimeType);
    }
} 