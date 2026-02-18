package com.mentra.asg_client.io.server.services;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * InputStream wrapper that ensures data flows periodically to prevent timeout.
 * This is critical for large file downloads over slow connections where
 * reading might pause for extended periods due to network congestion.
 * 
 * The wrapper tracks time since last read and ensures at least some data
 * is returned within the keep-alive interval to prevent socket timeout.
 */
public class KeepAliveInputStream extends FilterInputStream {
    private static final String TAG = "KeepAliveInputStream";
    
    // Maximum time to wait before forcing a read (4 minutes)
    // This is less than our 5-minute socket timeout to provide a buffer
    private static final long KEEP_ALIVE_INTERVAL_MS = 240000; // 4 minutes
    
    // Minimum bytes to read when forcing keep-alive
    private static final int MIN_KEEP_ALIVE_BYTES = 1;
    
    private long lastReadTime;
    private long totalBytesRead = 0;
    private final long startTime;
    
    public KeepAliveInputStream(InputStream in) {
        super(in);
        this.startTime = System.currentTimeMillis();
        this.lastReadTime = startTime;
    }
    
    @Override
    public int read() throws IOException {
        checkKeepAlive();
        int result = super.read();
        if (result != -1) {
            totalBytesRead++;
            lastReadTime = System.currentTimeMillis();
        }
        return result;
    }
    
    @Override
    public int read(byte[] b) throws IOException {
        return read(b, 0, b.length);
    }
    
    @Override
    public int read(byte[] b, int off, int len) throws IOException {
        checkKeepAlive();
        
        // If it's been too long since last read, force reading at least 1 byte
        long timeSinceLastRead = System.currentTimeMillis() - lastReadTime;
        if (timeSinceLastRead > KEEP_ALIVE_INTERVAL_MS && len > 0) {
            // Force read at least 1 byte to keep connection alive
            len = Math.max(MIN_KEEP_ALIVE_BYTES, Math.min(len, available()));
            android.util.Log.d(TAG, "⏱️ Keep-alive: Forcing read of " + len + " bytes after " + 
                             (timeSinceLastRead / 1000) + " seconds of inactivity");
        }
        
        int bytesRead = super.read(b, off, len);
        
        if (bytesRead > 0) {
            totalBytesRead += bytesRead;
            lastReadTime = System.currentTimeMillis();
            
            // Log progress periodically (every 10MB)
            if (totalBytesRead % (10 * 1024 * 1024) == 0) {
                long elapsedMs = System.currentTimeMillis() - startTime;
                double speedMBps = (totalBytesRead / 1024.0 / 1024.0) / (elapsedMs / 1000.0);
                android.util.Log.d(TAG, String.format("📊 Progress: %d MB transferred at %.2f MB/s", 
                                                     totalBytesRead / (1024 * 1024), speedMBps));
            }
        }
        
        return bytesRead;
    }
    
    /**
     * Check if we need to keep the connection alive
     */
    private void checkKeepAlive() {
        long timeSinceLastRead = System.currentTimeMillis() - lastReadTime;
        if (timeSinceLastRead > KEEP_ALIVE_INTERVAL_MS) {
            android.util.Log.w(TAG, "⚠️ Keep-alive warning: No data read for " + 
                             (timeSinceLastRead / 1000) + " seconds");
        }
    }
    
    @Override
    public int available() throws IOException {
        // Always report at least 1 byte available to prevent blocking
        // This ensures the connection stays active
        int available = super.available();
        return available > 0 ? available : 1;
    }
    
    @Override
    public void close() throws IOException {
        long totalTimeMs = System.currentTimeMillis() - startTime;
        android.util.Log.d(TAG, String.format("📏 Stream closed: %d bytes transferred in %.1f seconds", 
                                             totalBytesRead, totalTimeMs / 1000.0));
        super.close();
    }
}