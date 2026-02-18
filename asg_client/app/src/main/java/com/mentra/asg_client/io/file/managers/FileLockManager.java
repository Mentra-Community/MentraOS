package com.mentra.asg_client.io.file.managers;

import com.mentra.asg_client.logging.Logger;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReadWriteLock;
import java.util.concurrent.locks.ReentrantReadWriteLock;
import java.util.Map;

/**
 * Manages thread synchronization for file operations.
 * Follows Single Responsibility Principle by handling only lock management.
 */
public class FileLockManager {
    
    private static final String TAG = "FileLockManager";
    private static final long DEFAULT_LOCK_TIMEOUT_MS = 10000; // 10 seconds default timeout
    
    private final ConcurrentHashMap<String, ReadWriteLock> packageLocks;
    private final ConcurrentHashMap<String, LockInfo> lockHolders; // Track lock holders
    private final Logger logger;
    
    // Lock holder information
    private static class LockInfo {
        final Thread holder;
        final long acquisitionTime;
        final String operation;
        final StackTraceElement[] stackTrace;
        final long timeoutMs;
        
        LockInfo(Thread holder, String operation, long timeoutMs) {
            this.holder = holder;
            this.acquisitionTime = System.currentTimeMillis();
            this.operation = operation;
            this.stackTrace = Thread.currentThread().getStackTrace();
            this.timeoutMs = timeoutMs;
        }
        
        long getHoldTime() {
            return System.currentTimeMillis() - acquisitionTime;
        }
        
        boolean isExpired() {
            return timeoutMs > 0 && getHoldTime() > timeoutMs;
        }
    }
    
    public FileLockManager(Logger logger) {
        this.packageLocks = new ConcurrentHashMap<>();
        this.lockHolders = new ConcurrentHashMap<>();
        this.logger = logger;
    }
    
    /**
     * Get a read-write lock for a specific package
     * @param packageName The package name
     * @return ReadWriteLock for the package
     */
    public ReadWriteLock getPackageLock(String packageName) {
        return packageLocks.computeIfAbsent(packageName, k -> {
            logger.debug(TAG, "Created new lock for package: " + packageName);
            return new ReentrantReadWriteLock();
        });
    }
    
    /**
     * Acquire read lock for a package with timeout
     * @param packageName The package name
     * @param timeoutMs Timeout in milliseconds
     * @return The acquired lock, or null if timeout
     */
    public ReadWriteLock acquireReadLock(String packageName, long timeoutMs) {
        return acquireReadLock(packageName, timeoutMs, "READ_OPERATION");
    }
    
    /**
     * Acquire read lock with timeout and operation tracking
     * @param packageName The package name
     * @param timeoutMs Timeout in milliseconds
     * @param operation Operation name for tracking
     * @return The lock if acquired, null if timeout
     */
    public ReadWriteLock acquireReadLock(String packageName, long timeoutMs, String operation) {
        ReadWriteLock lock = getPackageLock(packageName);
        try {
            long startTime = System.currentTimeMillis();
            boolean acquired = lock.readLock().tryLock(timeoutMs, TimeUnit.MILLISECONDS);
            long acquisitionTime = System.currentTimeMillis() - startTime;
            if (acquired) {
                lockHolders.put(packageName + "_READ", new LockInfo(Thread.currentThread(), operation, timeoutMs));
                // Only log if acquisition takes longer than expected
                if (acquisitionTime > 100) {
                    logger.debug(TAG, "Slow read lock acquisition for package: " + packageName + " in " + acquisitionTime + "ms for operation: " + operation);
                }
                return lock;
            } else {
                logger.warn(TAG, "Failed to acquire read lock for package: " + packageName + " within " + timeoutMs + "ms for operation: " + operation);
                logDetailedLockInfo(packageName);
                return null;
            }
        } catch (InterruptedException e) {
            logger.error(TAG, "Interrupted while acquiring read lock for package: " + packageName + " for operation: " + operation, e);
            Thread.currentThread().interrupt();
            return null;
        }
    }
    
    /**
     * Acquire read lock for a package with default timeout
     * @param packageName The package name
     * @return The acquired lock, or null if timeout
     */
    public ReadWriteLock acquireReadLock(String packageName) {
        return acquireReadLock(packageName, DEFAULT_LOCK_TIMEOUT_MS);
    }
    
    /**
     * Acquire write lock for a package with timeout
     * @param packageName The package name
     * @param timeoutMs Timeout in milliseconds
     * @return The acquired lock, or null if timeout
     */
    public ReadWriteLock acquireWriteLock(String packageName, long timeoutMs) {
        return acquireWriteLock(packageName, timeoutMs, "WRITE_OPERATION");
    }
    
    /**
     * Acquire write lock with timeout and operation tracking
     * @param packageName The package name
     * @param timeoutMs Timeout in milliseconds
     * @param operation Operation name for tracking
     * @return The lock if acquired, null if timeout
     */
    public ReadWriteLock acquireWriteLock(String packageName, long timeoutMs, String operation) {
        ReadWriteLock lock = getPackageLock(packageName);
        try {
            long startTime = System.currentTimeMillis();
            boolean acquired = lock.writeLock().tryLock(timeoutMs, TimeUnit.MILLISECONDS);
            long acquisitionTime = System.currentTimeMillis() - startTime;
            if (acquired) {
                lockHolders.put(packageName + "_WRITE", new LockInfo(Thread.currentThread(), operation, timeoutMs));
                logger.debug(TAG, "Acquired write lock for package: " + packageName + " in " + acquisitionTime + "ms for operation: " + operation);
                return lock;
            } else {
                logger.warn(TAG, "Failed to acquire write lock for package: " + packageName + " within " + timeoutMs + "ms for operation: " + operation);
                logDetailedLockInfo(packageName);
                return null;
            }
        } catch (InterruptedException e) {
            logger.error(TAG, "Interrupted while acquiring write lock for package: " + packageName + " for operation: " + operation, e);
            Thread.currentThread().interrupt();
            return null;
        }
    }
    
    /**
     * Acquire write lock for a package with default timeout
     * @param packageName The package name
     * @return The acquired lock, or null if timeout
     */
    public ReadWriteLock acquireWriteLock(String packageName) {
        return acquireWriteLock(packageName, DEFAULT_LOCK_TIMEOUT_MS);
    }
    
    /**
     * Release read lock
     * @param lock The lock to release
     */
    public void releaseReadLock(ReadWriteLock lock) {
        releaseReadLock(lock, "UNKNOWN_PACKAGE");
    }
    
    /**
     * Release read lock with package name
     * @param lock The lock to release
     * @param packageName The package name for tracking
     */
    public void releaseReadLock(ReadWriteLock lock, String packageName) {
        if (lock != null) {
            try {
                // First, remove from tracking map
                LockInfo info = lockHolders.remove(packageName + "_READ");
                if (info != null && info.getHoldTime() > 5000) {
                    logger.warn(TAG, "Released read lock held for " + info.getHoldTime() + "ms for package: " + packageName);
                }
                
                // Then release the actual lock
                lock.readLock().unlock();
                
            } catch (Exception e) {
                logger.error(TAG, "Error releasing read lock for package: " + packageName, e);
            }
        }
    }
    
    /**
     * Release write lock
     * @param lock The lock to release
     */
    public void releaseWriteLock(ReadWriteLock lock) {
        releaseWriteLock(lock, "UNKNOWN_PACKAGE");
    }
    
    /**
     * Release write lock with package name
     * @param lock The lock to release
     * @param packageName The package name for tracking
     */
    public void releaseWriteLock(ReadWriteLock lock, String packageName) {
        if (lock != null) {
            try {
                // First, remove from tracking map
                LockInfo info = lockHolders.remove(packageName + "_WRITE");
                if (info != null && info.getHoldTime() > 5000) {
                    logger.warn(TAG, "Released write lock held for " + info.getHoldTime() + "ms for package: " + packageName);
                }
                
                // Then release the actual lock
                lock.writeLock().unlock();
                
            } catch (Exception e) {
                logger.error(TAG, "Error releasing write lock for package: " + packageName, e);
            }
        }
    }
    
    /**
     * Get the number of active locks
     * @return Number of package locks
     */
    public int getActiveLockCount() {
        return packageLocks.size();
    }
    
    /**
     * Get lock information for debugging
     * @param packageName The package name
     * @return Lock status information
     */
    public String getLockInfo(String packageName) {
        ReadWriteLock lock = packageLocks.get(packageName);
        if (lock == null) {
            return "No lock exists for package: " + packageName;
        }
        
        ReentrantReadWriteLock rwLock = (ReentrantReadWriteLock) lock;
        return String.format("Package: %s, ReadLocks: %d, WriteLocks: %d, QueueLength: %d",
                packageName,
                rwLock.getReadLockCount(),
                rwLock.getWriteHoldCount(),
                rwLock.getQueueLength());
    }
    
    /**
     * Log detailed lock information for debugging
     * @param packageName The package name
     */
    private void logDetailedLockInfo(String packageName) {
        ReadWriteLock lock = packageLocks.get(packageName);
        if (lock == null) {
            logger.warn(TAG, "No lock found for package: " + packageName);
            return;
        }

        ReentrantReadWriteLock rwLock = (ReentrantReadWriteLock) lock;
        LockInfo readHolder = lockHolders.get(packageName + "_READ");
        LockInfo writeHolder = lockHolders.get(packageName + "_WRITE");

        logger.warn(TAG, "=== DETAILED LOCK INFO FOR PACKAGE: " + packageName + " ===");
        logger.warn(TAG, "Current lock status: Package: " + packageName + 
                  ", ReadLocks: " + rwLock.getReadLockCount() + 
                  ", WriteLocks: " + rwLock.getWriteHoldCount() + 
                  ", QueueLength: " + rwLock.getQueueLength());

        if (readHolder != null) {
            logger.warn(TAG, "READ LOCK HOLDER: Thread=" + readHolder.holder.getName() + 
                      " (ID=" + readHolder.holder.getId() + "), Operation=" + readHolder.operation + 
                      ", HoldTime=" + readHolder.getHoldTime() + "ms");
            logger.warn(TAG, "READ LOCK ACQUISITION STACK:");
            for (StackTraceElement element : readHolder.stackTrace) {
                logger.warn(TAG, "  " + element.toString());
            }
        }

        if (writeHolder != null) {
            logger.warn(TAG, "WRITE LOCK HOLDER: Thread=" + writeHolder.holder.getName() + 
                      " (ID=" + writeHolder.holder.getId() + "), Operation=" + writeHolder.operation + 
                      ", HoldTime=" + writeHolder.getHoldTime() + "ms");
            logger.warn(TAG, "WRITE LOCK ACQUISITION STACK:");
            for (StackTraceElement element : writeHolder.stackTrace) {
                logger.warn(TAG, "  " + element.toString());
            }
        }

        logger.warn(TAG, "CURRENT THREAD: " + Thread.currentThread().getName() + " (ID=" + Thread.currentThread().getId() + ")");
        logger.warn(TAG, "=== END LOCK INFO ===");
    }
    
    /**
     * Get all active lock holders (for debugging)
     * @return Map of package names to lock holder information
     */
    public Map<String, LockInfo> getAllLockHolders() {
        return new ConcurrentHashMap<>(lockHolders);
    }
    
    /**
     * Clear all locks (useful for testing)
     */
    public void clearLocks() {
        packageLocks.clear();
        lockHolders.clear();
        logger.info(TAG, "All package locks and holders cleared");
    }
    
    /**
     * Check for and release expired locks
     * @param packageName The package name to check
     * @return Number of expired locks released
     */
    public int releaseExpiredLocks(String packageName) {
        int releasedCount = 0;
        
        // Check read lock
        LockInfo readHolder = lockHolders.get(packageName + "_READ");
        if (readHolder != null && readHolder.isExpired()) {
            logger.warn(TAG, "Releasing expired read lock for package: " + packageName + 
                      " (held for " + readHolder.getHoldTime() + "ms by " + readHolder.holder.getName() + ")");
            lockHolders.remove(packageName + "_READ");
            releasedCount++;
        }
        
        // Check write lock
        LockInfo writeHolder = lockHolders.get(packageName + "_WRITE");
        if (writeHolder != null && writeHolder.isExpired()) {
            logger.warn(TAG, "Releasing expired write lock for package: " + packageName + 
                      " (held for " + writeHolder.getHoldTime() + "ms by " + writeHolder.holder.getName() + ")");
            lockHolders.remove(packageName + "_WRITE");
            releasedCount++;
        }
        
        return releasedCount;
    }
    
    /**
     * Force release all locks for a package (emergency cleanup)
     * @param packageName The package name
     * @return Number of locks released
     */
    public int forceReleaseAllLocks(String packageName) {
        int releasedCount = 0;
        
        LockInfo readHolder = lockHolders.remove(packageName + "_READ");
        if (readHolder != null) {
            logger.warn(TAG, "Force releasing read lock for package: " + packageName + 
                      " (held for " + readHolder.getHoldTime() + "ms by " + readHolder.holder.getName() + ")");
            releasedCount++;
        }
        
        LockInfo writeHolder = lockHolders.remove(packageName + "_WRITE");
        if (writeHolder != null) {
            logger.warn(TAG, "Force releasing write lock for package: " + packageName + 
                      " (held for " + writeHolder.getHoldTime() + "ms by " + writeHolder.holder.getName() + ")");
            releasedCount++;
        }
        
        // Force reset the actual lock state
        ReadWriteLock lock = packageLocks.get(packageName);
        if (lock != null) {
            try {
                ReentrantReadWriteLock rwLock = (ReentrantReadWriteLock) lock;
                
                // Force release all read locks
                int readCount = rwLock.getReadLockCount();
                for (int i = 0; i < readCount; i++) {
                    try {
                        rwLock.readLock().unlock();
                    } catch (Exception e) {
                        logger.warn(TAG, "Error force unlocking read lock " + i + " for package: " + packageName);
                    }
                }
                
                // Force release write lock if held
                if (rwLock.isWriteLocked()) {
                    try {
                        rwLock.writeLock().unlock();
                    } catch (Exception e) {
                        logger.warn(TAG, "Error force unlocking write lock for package: " + packageName);
                    }
                }
                
                logger.warn(TAG, "Force reset lock state for package: " + packageName + 
                          " (released " + readCount + " read locks)");
                
            } catch (Exception e) {
                logger.error(TAG, "Error force resetting lock state for package: " + packageName, e);
            }
        }
        
        return releasedCount;
    }
    
    /**
     * Get current lock statistics for debugging
     * @param packageName The package name
     * @return Lock statistics string
     */
    public String getLockStatistics(String packageName) {
        ReadWriteLock lock = packageLocks.get(packageName);
        if (lock == null) {
            return "No lock exists for package: " + packageName;
        }
        
        ReentrantReadWriteLock rwLock = (ReentrantReadWriteLock) lock;
        LockInfo readHolder = lockHolders.get(packageName + "_READ");
        LockInfo writeHolder = lockHolders.get(packageName + "_WRITE");
        
        StringBuilder stats = new StringBuilder();
        stats.append("Package: ").append(packageName).append("\n");
        stats.append("  Actual ReadLocks: ").append(rwLock.getReadLockCount()).append("\n");
        stats.append("  Actual WriteLocks: ").append(rwLock.getWriteHoldCount()).append("\n");
        stats.append("  Queue Length: ").append(rwLock.getQueueLength()).append("\n");
        stats.append("  Tracked Read Holder: ").append(readHolder != null ? readHolder.holder.getName() + " (" + readHolder.getHoldTime() + "ms)" : "None").append("\n");
        stats.append("  Tracked Write Holder: ").append(writeHolder != null ? writeHolder.holder.getName() + " (" + writeHolder.getHoldTime() + "ms)" : "None").append("\n");
        
        return stats.toString();
    }
} 