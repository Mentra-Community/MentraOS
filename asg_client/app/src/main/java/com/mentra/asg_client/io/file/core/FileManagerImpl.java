package com.mentra.asg_client.io.file.core;

import com.mentra.asg_client.logging.Logger;
import com.mentra.asg_client.io.file.managers.FileOperationsManager;
import com.mentra.asg_client.io.file.managers.FileSecurityManager;
import com.mentra.asg_client.io.file.managers.FileLockManager;
import com.mentra.asg_client.io.file.managers.DirectoryManager;
import com.mentra.asg_client.io.file.managers.ThumbnailManager;
import com.mentra.asg_client.io.file.utils.FileOperationLogger;
import com.mentra.asg_client.io.file.utils.MimeTypeRegistry;
import java.io.File;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.locks.ReadWriteLock;
import android.util.Log;
import java.util.Map;

/**
 * SOLID-compliant FileManager implementation that orchestrates focused managers.
 * Follows Single Responsibility Principle by delegating to specialized managers.
 */
public class FileManagerImpl implements FileManager {
    
    private static final String TAG = "FileManagerImpl";
    
    // Focused managers (SRP)
    private final FileOperationsManager operationsManager;
    private final FileSecurityManager securityManager;
    private final FileLockManager lockManager;
    private final DirectoryManager directoryManager;
    private final ThumbnailManager thumbnailManager;
    private final FileOperationLogger operationLogger;
    
    // Dependencies
    private final Logger logger;
    private final File baseDirectory;
    
    public FileManagerImpl(File baseDirectory, Logger logger) {
        this.baseDirectory = baseDirectory;
        this.logger = logger;
        
        // Initialize focused managers
        this.operationsManager = new FileOperationsManager(baseDirectory, logger);
        this.securityManager = new FileSecurityManager(logger);
        this.lockManager = new FileLockManager(logger);
        this.directoryManager = new DirectoryManager(baseDirectory, logger);
        this.thumbnailManager = new ThumbnailManager(baseDirectory, logger);
        this.operationLogger = new FileOperationLogger(logger);
        
        logger.info(TAG, "FileManagerImpl initialized with base directory: " + baseDirectory.getAbsolutePath());
    }
    
    // FileOperations implementation
    @Override
    public FileOperationResult saveFile(String packageName, String fileName, InputStream inputStream, String mimeType) {
        // Security validation
        if (!securityManager.validateOperation(packageName, fileName, "SAVE")) {
            return FileOperationResult.error("Security validation failed");
        }
        
        // MIME type validation
        if (!securityManager.validateMimeType(mimeType)) {
            return FileOperationResult.error("Invalid MIME type");
        }
        
        // Thread synchronization
        ReadWriteLock lock = lockManager.acquireWriteLock(packageName);
        try {
            // Ensure directory exists
            if (!directoryManager.ensurePackageDirectoryExists(packageName)) {
                return FileOperationResult.error("Failed to create package directory");
            }
            
            // Perform file operation
            return operationsManager.saveFile(packageName, fileName, inputStream, mimeType);
        } finally {
            lockManager.releaseWriteLock(lock, packageName);
        }
    }
    
    @Override
    public File getFile(String packageName, String fileName) {
        Log.d(TAG, "📁 getFile() called - Package: " + packageName + ", File: " + fileName);
        
        // Security validation
        if (!securityManager.validateOperation(packageName, fileName, "READ")) {
            Log.w(TAG, "❌ Security validation failed for file read");
            return null;
        }
        
        // Thread synchronization with timeout for web server operations
        ReadWriteLock lock = null;
        try {
            Log.d(TAG, "🔐 Acquiring read lock for file read operation");
            // Use a shorter timeout for web server operations to prevent blocking cleanup
            lock = lockManager.acquireReadLock(packageName, 2000, "FILE_READ"); // 2 second timeout
            if (lock == null) {
                Log.w(TAG, "⚠️ Failed to acquire read lock for file read - timeout");
                return null;
            }
            
            File packageDir = directoryManager.getPackageDirectory(packageName);
            if (!packageDir.exists() || !packageDir.isDirectory()) {
                Log.d(TAG, "📁 Package directory does not exist: " + packageDir.getAbsolutePath());
                return null;
            }
            
            // Handle files in subdirectories by resolving the full path
            File file;
            if (fileName.contains(File.separator) || fileName.contains("/")) {
                // File is in a subdirectory, resolve the full path
                file = new File(packageDir, fileName);
                Log.d(TAG, "📁 Looking for file in subdirectory: " + file.getAbsolutePath());
            } else {
                // File is in root directory
                file = new File(packageDir, fileName);
                Log.d(TAG, "📁 Looking for file in root directory: " + file.getAbsolutePath());
            }
            
            if (!file.exists() || !file.isFile()) {
                Log.d(TAG, "📁 File does not exist: " + file.getAbsolutePath());
                return null;
            }
            
            // Security check: ensure the file is within the package directory
            try {
                String packagePath = packageDir.getCanonicalPath();
                String filePath = file.getCanonicalPath();
                
                if (!filePath.startsWith(packagePath)) {
                    Log.w(TAG, "❌ Security violation: File path outside package directory");
                    return null;
                }
            } catch (Exception e) {
                Log.w(TAG, "⚠️ Error checking file path security", e);
                return null;
            }
            
            Log.d(TAG, "✅ File found: " + file.getAbsolutePath() + " (Size: " + file.length() + " bytes)");
            return file;
            
        } catch (Exception e) {
            Log.e(TAG, "💥 Error getting file", e);
            return null;
        } finally {
            if (lock != null) {
                Log.d(TAG, "🔓 Releasing read lock for file read operation");
                lockManager.releaseReadLock(lock, packageName);
            }
        }
    }
    
    @Override
    public FileOperationResult deleteFile(String packageName, String fileName) {
        Log.d(TAG, "🗑️ deleteFile() called - Package: " + packageName + ", File: " + fileName);
        
        // Security validation
        if (!securityManager.validateOperation(packageName, fileName, "DELETE")) {
            Log.w(TAG, "❌ Security validation failed for file deletion");
            return FileOperationResult.error("Security validation failed");
        }
        
        // Thread synchronization
        ReadWriteLock lock = lockManager.acquireWriteLock(packageName);
        try {
            return operationsManager.deleteFile(packageName, fileName);
        } finally {
            lockManager.releaseWriteLock(lock, packageName);
        }
    }
    
    @Override
    public FileOperationResult updateFile(String packageName, String fileName, InputStream inputStream, String mimeType) {
        Log.d(TAG, "📝 updateFile() called - Package: " + packageName + ", File: " + fileName);
        
        // Security validation
        if (!securityManager.validateOperation(packageName, fileName, "UPDATE")) {
            Log.w(TAG, "❌ Security validation failed for file update");
            return FileOperationResult.error("Security validation failed");
        }
        
        // MIME type validation
        if (!securityManager.validateMimeType(mimeType)) {
            return FileOperationResult.error("Invalid MIME type");
        }
        
        // Thread synchronization
        ReadWriteLock lock = lockManager.acquireWriteLock(packageName);
        try {
            return operationsManager.updateFile(packageName, fileName, inputStream, mimeType);
        } finally {
            lockManager.releaseWriteLock(lock, packageName);
        }
    }
    
    // FileMetadataOperations implementation
    @Override
    public FileMetadata getFileMetadata(String packageName, String fileName) {
        Log.d(TAG, "📋 getFileMetadata() called - Package: " + packageName + ", File: " + fileName);
        
        // Security validation
        if (!securityManager.validateOperation(packageName, fileName, "METADATA")) {
            Log.w(TAG, "❌ Security validation failed for metadata request");
            return null;
        }
        
        // Thread synchronization with timeout for web server operations
        ReadWriteLock lock = null;
        try {
            Log.d(TAG, "🔐 Acquiring read lock for metadata operation");
            // Use a shorter timeout for web server operations to prevent blocking cleanup
            lock = lockManager.acquireReadLock(packageName, 2000, "FILE_METADATA"); // 2 second timeout
            if (lock == null) {
                Log.w(TAG, "⚠️ Failed to acquire read lock for metadata - timeout");
                return null;
            }
            
            File file = getFile(packageName, fileName);
            if (file == null || !file.exists()) {
                Log.d(TAG, "📋 File does not exist: " + fileName);
                return null;
            }
            
            Log.d(TAG, "📋 Creating metadata for file: " + fileName);
            
            // Use the original fileName (which may be a relative path) for the metadata
            // This preserves the directory structure information
            String mimeType = new MimeTypeRegistry().getMimeType(file.getName());
            
            FileMetadata metadata = new FileMetadata(
                    fileName, // Use the original fileName to preserve path structure
                file.getAbsolutePath(),
                file.length(),
                file.lastModified(),
                mimeType,
                packageName
            );
            
            Log.d(TAG, "✅ Metadata created successfully for: " + fileName + " (Size: " + file.length() + " bytes)");
            return metadata;
            
        } catch (Exception e) {
            Log.e(TAG, "💥 Error getting file metadata", e);
            return null;
        } finally {
            if (lock != null) {
                Log.d(TAG, "🔓 Releasing read lock for metadata operation");
                lockManager.releaseReadLock(lock, packageName);
            }
        }
    }
    
    @Override
    public List<FileMetadata> listFiles(String packageName) {
        Log.d(TAG, "📋 listFiles() called - Package: " + packageName);
        
        // Security validation
        if (!securityManager.validateOperation(packageName, null, "LIST")) {
            Log.w(TAG, "❌ Security validation failed for file listing");
            return new ArrayList<>();
        }
        
        // Thread synchronization with timeout
        ReadWriteLock lock = null;
        try {
            Log.d(TAG, "🔐 Acquiring read lock for file listing operation");
            lock = lockManager.acquireReadLock(packageName, 3000, "FILE_LIST"); // 3 second timeout
            if (lock == null) {
                Log.w(TAG, "⚠️ Failed to acquire read lock for file listing - timeout");
                return new ArrayList<>();
            }
            
            File packageDir = directoryManager.getPackageDirectory(packageName);
            if (!packageDir.exists() || !packageDir.isDirectory()) {
                Log.d(TAG, "📁 Package directory does not exist: " + packageDir.getAbsolutePath());
                return new ArrayList<>();
            }
            
            // Recursively collect all files from package directory and subdirectories
            List<FileMetadata> metadataList = new ArrayList<>();
            int totalFiles = collectFilesRecursively(packageDir, packageName, metadataList);
            
            operationLogger.logOperation("LIST", packageName, null, metadataList.size(), true);
            Log.d(TAG, "✅ File listing completed - " + metadataList.size() + " files found in " + totalFiles + " locations");
            return metadataList;
        } catch (Exception e) {
            Log.e(TAG, "💥 Error listing files", e);
            return new ArrayList<>();
        } finally {
            if (lock != null) {
                Log.d(TAG, "🔓 Releasing read lock for file listing operation");
                lockManager.releaseReadLock(lock, packageName);
            }
        }
    }
    
    /**
     * Recursively collect all files from a directory and its subdirectories
     * @param directory The directory to scan
     * @param packageName The package name for metadata
     * @param metadataList The list to populate with file metadata
     * @return Total number of files found
     */
    private int collectFilesRecursively(File directory, String packageName, List<FileMetadata> metadataList) {
        if (!directory.exists() || !directory.isDirectory()) {
            return 0;
        }
        
        int fileCount = 0;
        File[] items = directory.listFiles();
        
        if (items != null) {
            for (File item : items) {
                if (item.isFile()) {
                    // Add file to metadata list
                    String mimeType = new MimeTypeRegistry().getMimeType(item.getName());
                    String relativePath = getRelativePath(directory, item);
                    
                    metadataList.add(new FileMetadata(
                        relativePath, // Use relative path as filename to preserve directory structure
                        item.getAbsolutePath(),
                        item.length(),
                        item.lastModified(),
                        mimeType,
                        packageName
                    ));
                    fileCount++;
                    
                    Log.d(TAG, "📄 Found file: " + relativePath + " (" + item.length() + " bytes)");
                } else if (item.isDirectory()) {
                    // Recursively scan subdirectory
                    Log.d(TAG, "📁 Scanning subdirectory: " + item.getName());
                    fileCount += collectFilesRecursively(item, packageName, metadataList);
                }
            }
        }
        
        return fileCount;
    }
    
    /**
     * Get relative path from base directory to file
     * @param baseDir The base directory
     * @param file The file
     * @return Relative path string
     */
    private String getRelativePath(File baseDir, File file) {
        try {
            String basePath = baseDir.getAbsolutePath();
            String filePath = file.getAbsolutePath();
            
            if (filePath.startsWith(basePath)) {
                String relativePath = filePath.substring(basePath.length());
                // Remove leading slash if present
                if (relativePath.startsWith(File.separator)) {
                    relativePath = relativePath.substring(1);
                }
                return relativePath;
            }
        } catch (Exception e) {
            Log.w(TAG, "⚠️ Error calculating relative path for: " + file.getAbsolutePath(), e);
        }
        
        // Fallback to just filename if relative path calculation fails
        return file.getName();
    }
    
    @Override
    public boolean fileExists(String packageName, String fileName) {
        return getFile(packageName, fileName) != null;
    }
    
    // PackageOperations implementation
    @Override
    public File getPackageDirectory(String packageName) {
        // Security validation
        if (!securityManager.validateOperation(packageName, null, "DIRECTORY")) {
            return null;
        }
        return directoryManager.getPackageDirectory(packageName);
    }
    
    @Override
    public boolean ensurePackageDirectoryExists(String packageName) {
        // Security validation
        if (!securityManager.validateOperation(packageName, null, "DIRECTORY")) {
            return false;
        }
        
        return directoryManager.ensurePackageDirectoryExists(packageName);
    }
    
    @Override
    public long getPackageSize(String packageName) {
        Log.d(TAG, "📊 getPackageSize() called - Package: " + packageName);
        
        // Security validation
        if (!securityManager.validateOperation(packageName, null, "SIZE")) {
            Log.w(TAG, "❌ Security validation failed for package size");
            return 0;
        }
        
        // Thread synchronization with timeout
        ReadWriteLock lock = null;
        try {
            Log.d(TAG, "🔐 Acquiring read lock for package size operation");
            lock = lockManager.acquireReadLock(packageName, 3000, "PACKAGE_SIZE"); // 3 second timeout
            if (lock == null) {
                Log.w(TAG, "⚠️ Failed to acquire read lock for package size - timeout");
                return 0;
            }
            
            File packageDir = directoryManager.getPackageDirectory(packageName);
            if (!packageDir.exists() || !packageDir.isDirectory()) {
                Log.d(TAG, "📁 Package directory does not exist: " + packageDir.getAbsolutePath());
                return 0;
            }
            
            // Recursively calculate size of all files in package directory and subdirectories
            long totalSize = calculateDirectorySizeRecursively(packageDir);
            
            Log.d(TAG, "✅ Package size calculated: " + totalSize + " bytes");
            return totalSize;
        } catch (Exception e) {
            Log.e(TAG, "💥 Error calculating package size", e);
            return 0;
        } finally {
            if (lock != null) {
                Log.d(TAG, "🔓 Releasing read lock for package size operation");
                lockManager.releaseReadLock(lock, packageName);
            }
        }
    }
    
    /**
     * Recursively calculate the total size of all files in a directory and its subdirectories
     * @param directory The directory to calculate size for
     * @return Total size in bytes
     */
    private long calculateDirectorySizeRecursively(File directory) {
        if (!directory.exists() || !directory.isDirectory()) {
            return 0;
        }
        
        long totalSize = 0;
        File[] items = directory.listFiles();
        
        if (items != null) {
            for (File item : items) {
                if (item.isFile()) {
                    totalSize += item.length();
                    Log.d(TAG, "📄 File size: " + item.getName() + " (" + item.length() + " bytes)");
                } else if (item.isDirectory()) {
                    // Recursively calculate size of subdirectory
                    Log.d(TAG, "📁 Calculating size of subdirectory: " + item.getName());
                    totalSize += calculateDirectorySizeRecursively(item);
                }
            }
        }
        
        return totalSize;
    }
    
    @Override
    public int cleanupOldFiles(String packageName, long maxAgeMs) {
        Log.d(TAG, "🧹 cleanupOldFiles() started - Package: " + packageName + ", MaxAge: " + maxAgeMs + "ms");
        
        // Calculate max age in hours for logging
        long maxAgeHours = maxAgeMs / (1000 * 60 * 60);
        Log.d(TAG, "📊 Max age in hours: " + maxAgeHours + " hours");
        
        // Security validation
        Log.d(TAG, "🔒 Performing security validation for cleanup operation");
        if (!securityManager.validateOperation(packageName, null, "CLEANUP")) {
            Log.e(TAG, "❌ Security validation failed for package: " + packageName);
            return 0;
        }
        Log.d(TAG, "✅ Security validation passed for package: " + packageName);
        
        // Acquire write lock with timeout
        ReadWriteLock lock = null;
        long lockStartTime = System.currentTimeMillis();
        Log.d(TAG, "🔐 Attempting to acquire write lock for package: " + packageName);
        
        long lockTimeoutMs = 5000; // 5 seconds timeout for cleanup
        try {
            String lockInfo = lockManager.getLockInfo(packageName);
            Log.d(TAG, "📋 Lock status before acquisition: " + lockInfo);
            
            int expiredLocksReleased = lockManager.releaseExpiredLocks(packageName);
            if (expiredLocksReleased > 0) {
                Log.w(TAG, "🧹 Released " + expiredLocksReleased + " expired locks before cleanup");
            }
            
            lock = lockManager.acquireWriteLock(packageName, lockTimeoutMs, "FILE_CLEANUP");
            long lockAcquisitionTime = System.currentTimeMillis() - lockStartTime;
            
            if (lock != null) {
                Log.d(TAG, "✅ Write lock acquired successfully in " + lockAcquisitionTime + "ms");
                if (lockAcquisitionTime > 1000) {
                    Log.w(TAG, "⚠️ Write lock acquisition took longer than expected: " + lockAcquisitionTime + "ms");
                }
            } else {
                Log.e(TAG, "❌ Failed to acquire write lock within " + lockTimeoutMs + "ms timeout");
                Log.d(TAG, "🏁 cleanupOldFiles() completed - Lock acquisition timeout");
                
                // Log all active lock holders for debugging
                Map<String, ?> allHolders = lockManager.getAllLockHolders();
                if (!allHolders.isEmpty()) {
                    Log.w(TAG, "🔍 Active lock holders across all packages:");
                    for (Map.Entry<String, ?> entry : allHolders.entrySet()) {
                        Log.w(TAG, "  " + entry.getKey() + " -> " + entry.getValue());
                    }
                }
                
                // Log detailed lock statistics
                String lockStats = lockManager.getLockStatistics(packageName);
                Log.w(TAG, "📊 Lock Statistics:\n" + lockStats);
                
                // Try emergency lock release for this specific package
                Log.w(TAG, "🚨 Attempting emergency lock release for package: " + packageName);
                int forceReleased = lockManager.forceReleaseAllLocks(packageName);
                if (forceReleased > 0) {
                    Log.w(TAG, "⚠️ Force released " + forceReleased + " locks for package: " + packageName);
                    Log.w(TAG, "⚠️ This may indicate a deadlock or stuck operation");
                    
                    // Log updated statistics after force release
                    String updatedStats = lockManager.getLockStatistics(packageName);
                    Log.w(TAG, "📊 Updated Lock Statistics:\n" + updatedStats);
                }
                
                return 0;
            }
        } catch (Exception e) {
            Log.e(TAG, "💥 Exception during write lock acquisition for package: " + packageName, e);
            Log.d(TAG, "🏁 cleanupOldFiles() completed - Lock acquisition exception");
            return 0;
        } finally {
            if (lock != null) {
                Log.d(TAG, "🔓 Releasing write lock for package: " + packageName);
                try {
                    lockManager.releaseWriteLock(lock, packageName);
                    Log.d(TAG, "✅ Write lock released successfully");
                } catch (Exception e) {
                    Log.e(TAG, "💥 Error releasing write lock for package: " + packageName, e);
                }
            } else {
                Log.w(TAG, "⚠️ Cannot release write lock - lock is null");
            }
        }
        
        // Proceed with cleanup under lock
        try {
            // Get package directory
            File packageDir = directoryManager.getPackageDirectory(packageName);
            if (!packageDir.exists() || !packageDir.isDirectory()) {
                Log.w(TAG, "⚠️ Package directory does not exist: " + packageDir.getAbsolutePath());
                return 0;
            }
            
            Log.d(TAG, "📁 Scanning directory: " + packageDir.getAbsolutePath());
            
            // Calculate cutoff time
            long cutoffTime = System.currentTimeMillis() - maxAgeMs;
            Log.d(TAG, "⏰ Cutoff time: " + new java.util.Date(cutoffTime));
            
            // Recursively scan and clean up old files
            int deletedCount = 0;
            long totalDeletedSize = 0;
            
            deletedCount = cleanupFilesRecursively(packageDir, packageName, cutoffTime, totalDeletedSize);
            
            Log.i(TAG, "✅ Cleanup completed: " + deletedCount + " files deleted, " + totalDeletedSize + " bytes freed");
            return deletedCount;
            
        } catch (Exception e) {
            Log.e(TAG, "💥 Exception during file cleanup for package: " + packageName, e);
            return 0;
        }
    }
    
    /**
     * Recursively scan and clean up old files in a directory and its subdirectories
     * @param directory The directory to scan
     * @param packageName The package name for logging
     * @param cutoffTime The cutoff time for file deletion
     * @param totalDeletedSize Running total of deleted size
     * @return Number of files deleted
     */
    private int cleanupFilesRecursively(File directory, String packageName, long cutoffTime, long totalDeletedSize) {
        if (!directory.exists() || !directory.isDirectory()) {
            return 0;
        }
        
        int deletedCount = 0;
        File[] items = directory.listFiles();
        
        if (items != null) {
            Log.d(TAG, "🔍 Scanning " + items.length + " items in: " + directory.getName());
            
            for (File item : items) {
                if (item.isFile()) {
                    long lastModified = item.lastModified();
                    if (lastModified < cutoffTime) {
                        long fileSize = item.length();
                        String relativePath = getRelativePath(directory, item);
                        
                        Log.d(TAG, "🗑️ Deleting old file: " + relativePath + " (last modified: " + new java.util.Date(lastModified) + ", size: " + fileSize + " bytes)");
                        
                        try {
                            if (item.delete()) {
                                deletedCount++;
                                totalDeletedSize += fileSize;
                                Log.d(TAG, "✅ Successfully deleted: " + relativePath);
                                
                                // Log the deletion
                                operationLogger.logOperation("DELETE", packageName, relativePath, fileSize, true);
                            } else {
                                Log.w(TAG, "❌ Failed to delete file: " + relativePath);
                            }
                        } catch (Exception e) {
                            Log.e(TAG, "💥 Exception deleting file: " + relativePath, e);
                        }
                    }
                } else if (item.isDirectory()) {
                    // Recursively clean up subdirectory
                    Log.d(TAG, "📁 Scanning subdirectory for cleanup: " + item.getName());
                    deletedCount += cleanupFilesRecursively(item, packageName, cutoffTime, totalDeletedSize);
                }
            }
        }
        
        return deletedCount;
    }
    
    // StorageOperations implementation
    @Override
    public long getAvailableSpace() {
        return baseDirectory.getFreeSpace();
    }
    
    @Override
    public long getTotalSpace() {
        return baseDirectory.getTotalSpace();
    }

    @Override
    public File getDefaultMediaDirectory() {
        ensurePackageDirectoryExists(getDefaultPackageName());
        return getPackageDirectory(getDefaultPackageName());
    }

    @Override
    public FileOperationLogger getOperationLogger() {
        return operationLogger;
    }
    
    @Override
    public String getDefaultPackageName() {
        return "com.mentra.asg_client.camera";
    }
    
    @Override
    public ThumbnailManager getThumbnailManager() {
        return thumbnailManager;
    }
} 