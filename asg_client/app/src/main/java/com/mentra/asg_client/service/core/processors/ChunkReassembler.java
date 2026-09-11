package com.mentra.asg_client.service.core.processors;

import android.util.Log;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Manages accumulation and reassembly of chunked messages.
 * Handles timeout and cleanup of incomplete chunk sets.
 */
public class ChunkReassembler {
    private static final String TAG = "ChunkReassembler";
    
    // Timeout for incomplete chunk sets (30 seconds)
    private static final long CHUNK_TIMEOUT_MS = 30000;
    
    // Maximum concurrent chunk sessions to prevent memory issues
    private static final int MAX_CONCURRENT_SESSIONS = 10;
    private static final int MAX_BINARY_REASSEMBLY_BYTES = 4096;
    
    // Active chunk sessions
    private final Map<String, ChunkSession> activeSessions = new ConcurrentHashMap<>();
    private final Map<Integer, BinarySession> binarySessions = new ConcurrentHashMap<>();
    
    /**
     * Add a chunk to the reassembler
     * @param chunkId Unique identifier for this chunk set
     * @param chunkIndex Index of this chunk (0-based)
     * @param totalChunks Total number of chunks expected
     * @param data The chunk data
     * @return The reassembled message if complete, null otherwise
     */
    public String addChunk(String chunkId, int chunkIndex, int totalChunks, String data) {
        // Clean up old sessions first
        cleanupTimedOutSessions();

        if (chunkId == null || chunkId.isEmpty() || totalChunks <= 0 || chunkIndex < 0
                || chunkIndex >= totalChunks || data == null) {
            Log.w(TAG, "Dropping invalid chunk metadata: id=" + chunkId + ", index=" + chunkIndex
                    + ", total=" + totalChunks);
            return null;
        }

        // Check if we're at capacity
        if (activeSessions.size() >= MAX_CONCURRENT_SESSIONS && !activeSessions.containsKey(chunkId)) {
            Log.w(TAG, "Maximum concurrent chunk sessions reached, dropping oldest");
            removeOldestSession();
        }
        
        // Get or create session
        ChunkSession session = activeSessions.compute(chunkId, (ignored, existingSession) -> {
            if (existingSession == null) {
                return new ChunkSession(chunkId, totalChunks);
            }
            if (existingSession.totalChunks != totalChunks) {
                Log.w(TAG, "totalChunks mismatch for " + chunkId + " (expected "
                        + existingSession.totalChunks + ", got " + totalChunks + "), resetting session");
                return new ChunkSession(chunkId, totalChunks);
            }
            return existingSession;
        });
        
        // Add the chunk
        boolean added = session.addChunk(chunkIndex, data);
        if (!added) {
            Log.w(TAG, "Failed to add chunk " + chunkIndex + " to session " + chunkId);
            return null;
        }
        
        Log.d(TAG, "Added chunk " + chunkIndex + "/" + (totalChunks - 1) + " for session " + chunkId);
        
        // Check if complete
        if (session.isComplete()) {
            Log.d(TAG, "Chunk session " + chunkId + " complete, reassembling");
            String reassembled = session.reassemble();
            
            // Remove completed session
            activeSessions.remove(chunkId);
            
            return reassembled;
        }
        
        return null;
    }

    /**
     * Add a BLE Wire v2 binary fragment.
     *
     * @return Reassembled payload when complete, null while waiting for more fragments
     */
    public byte[] addBinaryFragment(
            byte flags, int msgId, int fragIdx, int fragCount, byte[] payload) {
        cleanupTimedOutSessions();
        cleanupTimedOutBinarySessions();

        if (fragCount <= 0 || fragIdx < 0 || fragIdx >= fragCount) {
            Log.w(
                    TAG,
                    "Dropping invalid binary fragment: msgId="
                            + msgId
                            + ", idx="
                            + fragIdx
                            + ", count="
                            + fragCount);
            return null;
        }

        if (binarySessions.size() >= MAX_CONCURRENT_SESSIONS
                && !binarySessions.containsKey(msgId)) {
            removeOldestBinarySession();
        }

        BinarySession session =
                binarySessions.compute(
                        msgId,
                        (ignored, existing) -> {
                            if (existing == null) {
                                return new BinarySession(msgId, fragCount);
                            }
                            if (existing.fragCount != fragCount) {
                                Log.w(
                                        TAG,
                                        "fragCount mismatch for msgId "
                                                + msgId
                                                + ", resetting session");
                                return new BinarySession(msgId, fragCount);
                            }
                            return existing;
                        });

        if (!session.addFragment(fragIdx, fragCount, payload)) {
            binarySessions.remove(msgId);
            return null;
        }

        if (session.isComplete(flags)) {
            byte[] reassembled = session.reassemble();
            binarySessions.remove(msgId);
            return reassembled;
        }

        return null;
    }
    
    /**
     * Check if a chunk session is complete
     */
    public boolean isComplete(String chunkId) {
        ChunkSession session = activeSessions.get(chunkId);
        return session != null && session.isComplete();
    }
    
    /**
     * Manually reassemble a chunk session (if complete)
     */
    public String reassemble(String chunkId) {
        ChunkSession session = activeSessions.get(chunkId);
        if (session != null && session.isComplete()) {
            String reassembled = session.reassemble();
            activeSessions.remove(chunkId);
            return reassembled;
        }
        return null;
    }
    
    /**
     * Clean up sessions that have timed out
     */
    private void cleanupTimedOutSessions() {
        long now = System.currentTimeMillis();
        
        activeSessions.entrySet().removeIf(entry -> {
            ChunkSession session = entry.getValue();
            if (now - session.createdTime > CHUNK_TIMEOUT_MS) {
                Log.w(TAG, "Chunk session " + entry.getKey() + " timed out after " + 
                    CHUNK_TIMEOUT_MS + "ms, received " + session.getReceivedCount() + 
                    "/" + session.totalChunks + " chunks");
                return true;
            }
            return false;
        });
    }

    private void cleanupTimedOutBinarySessions() {
        long now = System.currentTimeMillis();
        binarySessions
                .entrySet()
                .removeIf(
                        entry -> {
                            if (now - entry.getValue().createdTime > CHUNK_TIMEOUT_MS) {
                                Log.w(
                                        TAG,
                                        "Binary session msgId="
                                                + entry.getKey()
                                                + " timed out");
                                return true;
                            }
                            return false;
                        });
    }

    private void removeOldestBinarySession() {
        Integer oldestId = null;
        long oldestTime = Long.MAX_VALUE;

        for (Map.Entry<Integer, BinarySession> entry : binarySessions.entrySet()) {
            if (entry.getValue().createdTime < oldestTime) {
                oldestTime = entry.getValue().createdTime;
                oldestId = entry.getKey();
            }
        }

        if (oldestId != null) {
            binarySessions.remove(oldestId);
        }
    }
    
    /**
     * Remove the oldest session to make room for new ones
     */
    private void removeOldestSession() {
        String oldestId = null;
        long oldestTime = Long.MAX_VALUE;
        
        for (Map.Entry<String, ChunkSession> entry : activeSessions.entrySet()) {
            if (entry.getValue().createdTime < oldestTime) {
                oldestTime = entry.getValue().createdTime;
                oldestId = entry.getKey();
            }
        }
        
        if (oldestId != null) {
            ChunkSession removed = activeSessions.remove(oldestId);
            if (removed != null) {
                Log.w(TAG, "Removed oldest chunk session " + oldestId + 
                    " (received " + removed.getReceivedCount() + "/" + removed.totalChunks + " chunks)");
            }
        }
    }
    
    /**
     * Get statistics about active chunk sessions
     */
    public String getStats() {
        StringBuilder stats = new StringBuilder();
        stats.append("Active chunk sessions: ").append(activeSessions.size()).append("\n");
        
        for (Map.Entry<String, ChunkSession> entry : activeSessions.entrySet()) {
            ChunkSession session = entry.getValue();
            long age = System.currentTimeMillis() - session.createdTime;
            stats.append("  - ").append(entry.getKey())
                .append(": ").append(session.getReceivedCount())
                .append("/").append(session.totalChunks)
                .append(" chunks, age: ").append(age).append("ms\n");
        }
        
        return stats.toString();
    }
    
    /**
     * Clear all active sessions
     */
    public void clear() {
        int count = activeSessions.size();
        activeSessions.clear();
        binarySessions.clear();
        Log.d(TAG, "Cleared " + count + " active chunk sessions");
    }
    
    /**
     * Inner class representing a chunk session
     */
    private static class ChunkSession {
        final String chunkId;
        final int totalChunks;
        final long createdTime;
        final Map<Integer, String> chunks;
        
        ChunkSession(String chunkId, int totalChunks) {
            this.chunkId = chunkId;
            this.totalChunks = totalChunks;
            this.createdTime = System.currentTimeMillis();
            this.chunks = new ConcurrentHashMap<>();
        }
        
        boolean addChunk(int index, String data) {
            if (index < 0 || index >= totalChunks) {
                Log.e(TAG, "Invalid chunk index " + index + " for session with " + totalChunks + " chunks");
                return false;
            }
            
            if (chunks.containsKey(index)) {
                Log.w(TAG, "Duplicate chunk " + index + " for session " + chunkId);
            }
            
            chunks.put(index, data);
            return true;
        }
        
        boolean isComplete() {
            return chunks.size() == totalChunks;
        }
        
        int getReceivedCount() {
            return chunks.size();
        }
        
        String reassemble() {
            if (!isComplete()) {
                Log.e(TAG, "Cannot reassemble incomplete session " + chunkId);
                return null;
            }
            
            StringBuilder reassembled = new StringBuilder();
            for (int i = 0; i < totalChunks; i++) {
                String chunk = chunks.get(i);
                if (chunk == null) {
                    Log.e(TAG, "Missing chunk " + i + " in session " + chunkId);
                    return null;
                }
                reassembled.append(chunk);
            }
            
            String result = reassembled.toString();
            Log.d(TAG, "Reassembled message of " + result.length() + " bytes from " + totalChunks + " chunks");
            return result;
        }
    }

    private static class BinarySession {
        final int msgId;
        final int fragCount;
        final long createdTime;
        int receivedCount;
        final byte[] buffer = new byte[MAX_BINARY_REASSEMBLY_BYTES];
        int writeOffset;

        BinarySession(int msgId, int fragCount) {
            this.msgId = msgId;
            this.fragCount = fragCount;
            this.createdTime = System.currentTimeMillis();
        }

        boolean addFragment(int fragIdx, int fragCount, byte[] payload) {
            int payloadLen = payload != null ? payload.length : 0;
            if (fragIdx == 0) {
                if (receivedCount > 0) {
                    Log.w(TAG, "Duplicate first binary fragment for msgId=" + msgId);
                    return true;
                }
                receivedCount = 0;
                writeOffset = 0;
            } else if (fragIdx != receivedCount) {
                Log.w(
                        TAG,
                        "Out-of-order binary fragment idx="
                                + fragIdx
                                + " expected="
                                + receivedCount
                                + " msgId="
                                + msgId);
                return false;
            }

            if (writeOffset + payloadLen > buffer.length) {
                Log.e(TAG, "Binary reassembly overflow for msgId=" + msgId);
                return false;
            }

            if (payloadLen > 0 && payload != null) {
                System.arraycopy(payload, 0, buffer, writeOffset, payloadLen);
            }
            writeOffset += payloadLen;
            receivedCount++;
            return true;
        }

        boolean isComplete(byte flags) {
            return (flags & 0x02) != 0 && receivedCount == fragCount;
        }

        byte[] reassemble() {
            byte[] result = new byte[writeOffset];
            System.arraycopy(buffer, 0, result, 0, writeOffset);
            Log.d(
                    TAG,
                    "Reassembled binary message of "
                            + writeOffset
                            + " bytes from "
                            + fragCount
                            + " fragments (msgId="
                            + msgId
                            + ")");
            return result;
        }
    }
}
