package com.mentra.asg_client.io.file.core;

import com.mentra.asg_client.io.file.interfaces.FileOperations;
import com.mentra.asg_client.io.file.interfaces.FileMetadataOperations;
import com.mentra.asg_client.io.file.interfaces.PackageOperations;
import com.mentra.asg_client.io.file.interfaces.StorageOperations;
import com.mentra.asg_client.io.file.utils.FileOperationLogger;
import com.mentra.asg_client.io.file.managers.ThumbnailManager;
import java.io.File;

/**
 * FileManager interface following SOLID principles.
 * 
 * Single Responsibility: Manages file operations
 * Open/Closed: Extensible through implementations
 * Liskov Substitution: Implementations can be substituted
 * Interface Segregation: Composes focused interfaces
 * Dependency Inversion: Depends on abstractions
 */
public interface FileManager extends FileOperations, FileMetadataOperations, PackageOperations, StorageOperations {



    /**
     * File operation result containing success status and metadata
     */
    class FileOperationResult {
        private final boolean success;
        private final String message;
        private final String filePath;
        private final long fileSize;
        private final long timestamp;
        
        public FileOperationResult(boolean success, String message, String filePath, long fileSize, long timestamp) {
            this.success = success;
            this.message = message;
            this.filePath = filePath;
            this.fileSize = fileSize;
            this.timestamp = timestamp;
        }
        
        public boolean isSuccess() { return success; }
        public String getMessage() { return message; }
        public String getFilePath() { return filePath; }
        public long getFileSize() { return fileSize; }
        public long getTimestamp() { return timestamp; }
        
        public static FileOperationResult success(String message, String filePath) {
            return new FileOperationResult(true, message, filePath, 0, System.currentTimeMillis());
        }
        
        public static FileOperationResult success(String filePath, long fileSize) {
            return new FileOperationResult(true, "Operation completed successfully", filePath, fileSize, System.currentTimeMillis());
        }
        
        public static FileOperationResult error(String message) {
            return new FileOperationResult(false, message, null, 0, System.currentTimeMillis());
        }
    }
    
    /**
     * File metadata information
     */
    class FileMetadata {
        private final String fileName;
        private final String filePath;
        private final long fileSize;
        private final long lastModified;
        private final String mimeType;
        private final String packageName;
        
        public FileMetadata(String fileName, String filePath, long fileSize, long lastModified, String mimeType, String packageName) {
            this.fileName = fileName;
            this.filePath = filePath;
            this.fileSize = fileSize;
            this.lastModified = lastModified;
            this.mimeType = mimeType;
            this.packageName = packageName;
        }
        
        public String getFileName() { return fileName; }
        public String getFilePath() { return filePath; }
        public long getFileSize() { return fileSize; }
        public long getLastModified() { return lastModified; }
        public String getMimeType() { return mimeType; }
        public String getPackageName() { return packageName; }
    }
    
    /**
     * Get the operation logger for performance monitoring and audit trails.
     * @return FileOperationLogger instance
     */
    FileOperationLogger getOperationLogger();
    
    /**
     * Get the default package name for file operations.
     * This is used when no specific package is provided.
     * @return Default package name
     */
    String getDefaultPackageName();
    
    /**
     * Get the default media directory for file operations.
     * @return Default media directory
     */
    File getDefaultMediaDirectory();
    
    /**
     * Get the thumbnail manager for video thumbnail operations.
     * @return ThumbnailManager instance
     */
    ThumbnailManager getThumbnailManager();
} 