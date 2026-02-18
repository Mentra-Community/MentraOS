package com.mentra.asg_client.io.file.utils;

import com.mentra.asg_client.logging.Logger;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Logger for file operations to track and audit file activities.
 * Provides operation history and performance metrics.
 */
public class FileOperationLogger {
    
    private static final String TAG = "FileOperationLogger";
    
    // Maximum number of operations to keep in memory
    private static final int MAX_OPERATIONS = 1000;
    
    // Operation history queue
    private final ConcurrentLinkedQueue<OperationRecord> operationHistory;
    
    // Performance counters
    private final AtomicLong totalOperations;
    private final AtomicLong successfulOperations;
    private final AtomicLong failedOperations;
    private final AtomicLong totalBytesProcessed;
    
    // Date formatter for timestamps
    private final SimpleDateFormat dateFormat;
    
    // Logger instance
    private final Logger logger;
    
    public FileOperationLogger() {
        this.operationHistory = new ConcurrentLinkedQueue<>();
        this.totalOperations = new AtomicLong(0);
        this.successfulOperations = new AtomicLong(0);
        this.failedOperations = new AtomicLong(0);
        this.totalBytesProcessed = new AtomicLong(0);
        this.dateFormat = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US);
        this.logger = null; // Will be set by constructor with logger
    }
    
    public FileOperationLogger(Logger logger) {
        this.operationHistory = new ConcurrentLinkedQueue<>();
        this.totalOperations = new AtomicLong(0);
        this.successfulOperations = new AtomicLong(0);
        this.failedOperations = new AtomicLong(0);
        this.totalBytesProcessed = new AtomicLong(0);
        this.dateFormat = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US);
        this.logger = logger;
    }
    
    /**
     * Log a file operation
     * @param operation The operation type (SAVE, GET, DELETE, etc.)
     * @param packageName The package name
     * @param fileName The file name (can be null for list operations)
     * @param bytesProcessed Number of bytes processed
     * @param success Whether the operation was successful
     */
    public void logOperation(String operation, String packageName, String fileName, long bytesProcessed, boolean success) {
        long timestamp = System.currentTimeMillis();
        String timestampStr = dateFormat.format(new Date(timestamp));
        
        // Create operation record
        OperationRecord record = new OperationRecord(
            operation,
            packageName,
            fileName,
            bytesProcessed,
            success,
            timestamp,
            timestampStr
        );
        
        // Add to history
        operationHistory.offer(record);
        
        // Maintain history size
        while (operationHistory.size() > MAX_OPERATIONS) {
            operationHistory.poll();
        }
        
        // Update counters
        totalOperations.incrementAndGet();
        if (success) {
            successfulOperations.incrementAndGet();
        } else {
            failedOperations.incrementAndGet();
        }
        
        if (bytesProcessed > 0) {
            totalBytesProcessed.addAndGet(bytesProcessed);
        }
        
        // Log to logger if available
        if (logger != null) {
            String logMessage = String.format(
                "[%s] %s | Package: %s | File: %s | Bytes: %d | Success: %s",
                timestampStr,
                operation,
                packageName,
                fileName != null ? fileName : "N/A",
                bytesProcessed,
                success ? "YES" : "NO"
            );
            
            if (success) {
                logger.debug(TAG, logMessage);
            } else {
                logger.warn(TAG, logMessage);
            }
        }
    }
    
    /**
     * Get operation history
     * @return Array of operation records
     */
    public OperationRecord[] getOperationHistory() {
        return operationHistory.toArray(new OperationRecord[0]);
    }
    
    /**
     * Get recent operations for a specific package
     * @param packageName The package name
     * @param maxCount Maximum number of operations to return
     * @return Array of operation records
     */
    public OperationRecord[] getRecentOperations(String packageName, int maxCount) {
        return operationHistory.stream()
            .filter(record -> record.packageName.equals(packageName))
            .limit(maxCount)
            .toArray(OperationRecord[]::new);
    }
    
    /**
     * Get recent operations for a specific operation type
     * @param operation The operation type
     * @param maxCount Maximum number of operations to return
     * @return Array of operation records
     */
    public OperationRecord[] getRecentOperationsByType(String operation, int maxCount) {
        return operationHistory.stream()
            .filter(record -> record.operation.equals(operation))
            .limit(maxCount)
            .toArray(OperationRecord[]::new);
    }
    
    /**
     * Get failed operations
     * @param maxCount Maximum number of operations to return
     * @return Array of failed operation records
     */
    public OperationRecord[] getFailedOperations(int maxCount) {
        return operationHistory.stream()
            .filter(record -> !record.success)
            .limit(maxCount)
            .toArray(OperationRecord[]::new);
    }
    
    /**
     * Get performance statistics
     * @return PerformanceStats object
     */
    public PerformanceStats getPerformanceStats() {
        long total = totalOperations.get();
        long successful = successfulOperations.get();
        long failed = failedOperations.get();
        long bytes = totalBytesProcessed.get();
        
        double successRate = total > 0 ? (double) successful / total * 100.0 : 0.0;
        
        return new PerformanceStats(total, successful, failed, bytes, successRate);
    }
    
    /**
     * Clear operation history
     */
    public void clearHistory() {
        operationHistory.clear();
        if (logger != null) {
            logger.info(TAG, "Operation history cleared");
        }
    }
    
    /**
     * Get operation history size
     * @return Number of operations in history
     */
    public int getHistorySize() {
        return operationHistory.size();
    }
    
    /**
     * Check if an operation was recently performed
     * @param operation The operation type
     * @param packageName The package name
     * @param fileName The file name
     * @param timeWindowMs Time window in milliseconds
     * @return true if operation was performed recently
     */
    public boolean wasOperationPerformedRecently(String operation, String packageName, String fileName, long timeWindowMs) {
        long currentTime = System.currentTimeMillis();
        
        return operationHistory.stream()
            .anyMatch(record -> 
                record.operation.equals(operation) &&
                record.packageName.equals(packageName) &&
                (fileName == null || fileName.equals(record.fileName)) &&
                (currentTime - record.timestamp) < timeWindowMs
            );
    }
    
    /**
     * Record for a file operation
     */
    public static class OperationRecord {
        public final String operation;
        public final String packageName;
        public final String fileName;
        public final long bytesProcessed;
        public final boolean success;
        public final long timestamp;
        public final String timestampStr;
        
        public OperationRecord(String operation, String packageName, String fileName, 
                             long bytesProcessed, boolean success, long timestamp, String timestampStr) {
            this.operation = operation;
            this.packageName = packageName;
            this.fileName = fileName;
            this.bytesProcessed = bytesProcessed;
            this.success = success;
            this.timestamp = timestamp;
            this.timestampStr = timestampStr;
        }
        
        @Override
        public String toString() {
            return String.format(
                "OperationRecord{operation='%s', packageName='%s', fileName='%s', " +
                "bytesProcessed=%d, success=%s, timestamp=%d, timestampStr='%s'}",
                operation, packageName, fileName, bytesProcessed, success, timestamp, timestampStr
            );
        }
    }
    
    /**
     * Performance statistics
     */
    public static class PerformanceStats {
        public final long totalOperations;
        public final long successfulOperations;
        public final long failedOperations;
        public final long totalBytesProcessed;
        public final double successRate;
        
        public PerformanceStats(long totalOperations, long successfulOperations, long failedOperations, 
                              long totalBytesProcessed, double successRate) {
            this.totalOperations = totalOperations;
            this.successfulOperations = successfulOperations;
            this.failedOperations = failedOperations;
            this.totalBytesProcessed = totalBytesProcessed;
            this.successRate = successRate;
        }
        
        @Override
        public String toString() {
            return String.format(
                "PerformanceStats{totalOperations=%d, successfulOperations=%d, " +
                "failedOperations=%d, totalBytesProcessed=%d, successRate=%.2f%%}",
                totalOperations, successfulOperations, failedOperations, totalBytesProcessed, successRate
            );
        }
    }
} 