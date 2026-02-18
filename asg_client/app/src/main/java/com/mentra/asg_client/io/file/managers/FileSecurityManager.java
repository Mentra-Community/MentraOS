package com.mentra.asg_client.io.file.managers;

import com.mentra.asg_client.logging.Logger;
import com.mentra.asg_client.io.file.security.FileSecurityValidator;

/**
 * Manages security validation for file operations.
 * Follows Single Responsibility Principle by handling only security validation.
 */
public class FileSecurityManager {
    
    private static final String TAG = "FileSecurityManager";
    
    private final FileSecurityValidator validator;
    private final Logger logger;
    
    public FileSecurityManager(Logger logger) {
        this.validator = new FileSecurityValidator();
        this.logger = logger;
    }
    
    /**
     * Validate a file operation
     * @param packageName The package name
     * @param fileName The file name
     * @param operation The operation being performed
     * @return true if valid, false otherwise
     */
    public boolean validateOperation(String packageName, String fileName, String operation) {
        if (!validator.validatePackageName(packageName)) {
            logger.warn(TAG, "Invalid package name for " + operation + ": " + packageName);
            return false;
        }
        
        if (fileName != null && !validator.validateFileName(fileName)) {
            logger.warn(TAG, "Invalid file name for " + operation + ": " + fileName);
            return false;
        }
        
        logger.debug(TAG, "Security validation passed for " + operation + ": " + packageName + "/" + fileName);
        return true;
    }
    
    /**
     * Validate file size
     * @param fileSize The file size in bytes
     * @return true if valid, false otherwise
     */
    public boolean validateFileSize(long fileSize) {
        boolean isValid = validator.validateFileSize(fileSize);
        if (!isValid) {
            logger.warn(TAG, "File size validation failed: " + fileSize + " bytes");
        }
        return isValid;
    }
    
    /**
     * Validate MIME type
     * @param mimeType The MIME type
     * @return true if valid, false otherwise
     */
    public boolean validateMimeType(String mimeType) {
        boolean isValid = validator.validateMimeType(mimeType);
        if (!isValid) {
            logger.warn(TAG, "MIME type validation failed: " + mimeType);
        }
        return isValid;
    }
    
    /**
     * Check if file has dangerous extension
     * @param fileName The file name
     * @return true if dangerous, false otherwise
     */
    public boolean hasDangerousExtension(String fileName) {
        boolean isDangerous = validator.hasDangerousExtension(fileName);
        if (isDangerous) {
            logger.warn(TAG, "Dangerous file extension detected: " + fileName);
        }
        return isDangerous;
    }
    
    /**
     * Sanitize file name
     * @param fileName The original file name
     * @return Sanitized file name
     */
    public String sanitizeFileName(String fileName) {
        String sanitized = validator.sanitizeFileName(fileName);
        if (!sanitized.equals(fileName)) {
            logger.info(TAG, "File name sanitized: " + fileName + " -> " + sanitized);
        }
        return sanitized;
    }
    
    /**
     * Sanitize package name
     * @param packageName The original package name
     * @return Sanitized package name
     */
    public String sanitizePackageName(String packageName) {
        String sanitized = validator.sanitizePackageName(packageName);
        if (!sanitized.equals(packageName)) {
            logger.info(TAG, "Package name sanitized: " + packageName + " -> " + sanitized);
        }
        return sanitized;
    }
} 