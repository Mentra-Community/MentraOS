package com.mentra.bluetoothsdk.utils;

import android.util.Log;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Reassembles compact JSON chunks from the glasses before normal event dispatch.
 */
public class MessageChunkReassembler {
    private static final String TAG = "MessageChunkReassembler";
    private static final long CHUNK_TIMEOUT_MS = 30000;
    private static final int MAX_CONCURRENT_SESSIONS = 10;

    private final Map<String, ChunkSession> activeSessions = new ConcurrentHashMap<>();

    private final Map<Integer, BinarySession> activeBinarySessions = new ConcurrentHashMap<>();

    public byte[] addBinaryFragment(int msgId, int fragIdx, int fragCount, byte[] data) {
        cleanupTimedOutSessions();

        if (msgId < 0 || fragCount <= 0 || fragIdx < 0 || fragIdx >= fragCount || data == null) {
            Log.w(TAG, "Dropping invalid binary fragment: msgId=" + msgId + ", index=" + fragIdx
                    + ", total=" + fragCount);
            return null;
        }

        if (activeBinarySessions.size() >= MAX_CONCURRENT_SESSIONS
                && !activeBinarySessions.containsKey(msgId)) {
            removeOldestBinarySession();
        }

        BinarySession session = activeBinarySessions.compute(msgId, (ignored, existingSession) -> {
            if (existingSession == null) {
                return new BinarySession(msgId, fragCount);
            }
            if (existingSession.fragCount != fragCount) {
                Log.w(TAG, "fragCount mismatch for msgId " + msgId + ", resetting session");
                return new BinarySession(msgId, fragCount);
            }
            return existingSession;
        });

        if (!session.addFragment(fragIdx, data)) {
            return null;
        }

        if (!session.isComplete()) {
            return null;
        }

        byte[] reassembled = session.reassemble();
        activeBinarySessions.remove(msgId);
        Log.d(TAG, "Reassembled binary message of " + reassembled.length + " bytes from "
                + fragCount + " fragments");
        return reassembled;
    }

    public String addChunk(String chunkId, int chunkIndex, int totalChunks, String data) {
        cleanupTimedOutSessions();

        if (chunkId == null || chunkId.isEmpty() || totalChunks <= 0 || chunkIndex < 0
                || chunkIndex >= totalChunks || data == null) {
            Log.w(TAG, "Dropping invalid chunk metadata: id=" + chunkId + ", index=" + chunkIndex
                    + ", total=" + totalChunks);
            return null;
        }

        if (activeSessions.size() >= MAX_CONCURRENT_SESSIONS && !activeSessions.containsKey(chunkId)) {
            Log.w(TAG, "Maximum concurrent chunk sessions reached, dropping oldest");
            removeOldestSession();
        }

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
        boolean added = session.addChunk(chunkIndex, data);
        if (!added) {
            Log.w(TAG, "Failed to add chunk " + chunkIndex + " to session " + chunkId);
            return null;
        }

        Log.d(TAG, "Added chunk " + chunkIndex + "/" + (totalChunks - 1) + " for session " + chunkId);

        if (!session.isComplete()) {
            return null;
        }

        String reassembled = session.reassemble();
        activeSessions.remove(chunkId);
        Log.d(TAG, "Reassembled message of " + reassembled.length() + " bytes from " + totalChunks + " chunks");
        return reassembled;
    }

    public void clear() {
        activeSessions.clear();
        activeBinarySessions.clear();
    }

    private void cleanupTimedOutSessions() {
        long now = System.currentTimeMillis();
        activeSessions.entrySet().removeIf(entry -> now - entry.getValue().createdAt > CHUNK_TIMEOUT_MS);
        activeBinarySessions.entrySet()
                .removeIf(entry -> now - entry.getValue().createdAt > CHUNK_TIMEOUT_MS);
    }

    private void removeOldestBinarySession() {
        Integer oldestId = null;
        long oldestTime = Long.MAX_VALUE;
        for (Map.Entry<Integer, BinarySession> entry : activeBinarySessions.entrySet()) {
            if (entry.getValue().createdAt < oldestTime) {
                oldestTime = entry.getValue().createdAt;
                oldestId = entry.getKey();
            }
        }
        if (oldestId != null) {
            activeBinarySessions.remove(oldestId);
        }
    }

    private void removeOldestSession() {
        String oldestId = null;
        long oldestTime = Long.MAX_VALUE;
        for (Map.Entry<String, ChunkSession> entry : activeSessions.entrySet()) {
            if (entry.getValue().createdAt < oldestTime) {
                oldestTime = entry.getValue().createdAt;
                oldestId = entry.getKey();
            }
        }
        if (oldestId != null) {
            activeSessions.remove(oldestId);
        }
    }

    private static class ChunkSession {
        final String chunkId;
        final int totalChunks;
        final long createdAt;
        final Map<Integer, String> chunks;

        ChunkSession(String chunkId, int totalChunks) {
            this.chunkId = chunkId;
            this.totalChunks = totalChunks;
            this.createdAt = System.currentTimeMillis();
            this.chunks = new ConcurrentHashMap<>();
        }

        boolean addChunk(int index, String data) {
            if (index < 0 || index >= totalChunks) {
                return false;
            }
            chunks.put(index, data);
            return true;
        }

        boolean isComplete() {
            return chunks.size() == totalChunks;
        }

        String reassemble() {
            StringBuilder reassembled = new StringBuilder();
            for (int i = 0; i < totalChunks; i++) {
                String chunk = chunks.get(i);
                if (chunk == null) {
                    throw new IllegalStateException("Missing chunk " + i + " for session " + chunkId);
                }
                reassembled.append(chunk);
            }
            return reassembled.toString();
        }
    }

    private static class BinarySession {
        final int msgId;
        final int fragCount;
        final long createdAt;
        final Map<Integer, byte[]> fragments;

        BinarySession(int msgId, int fragCount) {
            this.msgId = msgId;
            this.fragCount = fragCount;
            this.createdAt = System.currentTimeMillis();
            this.fragments = new ConcurrentHashMap<>();
        }

        boolean addFragment(int index, byte[] data) {
            if (index < 0 || index >= fragCount) {
                return false;
            }
            fragments.put(index, data);
            return true;
        }

        boolean isComplete() {
            return fragments.size() == fragCount;
        }

        byte[] reassemble() {
            int totalLen = 0;
            for (int i = 0; i < fragCount; i++) {
                byte[] fragment = fragments.get(i);
                if (fragment == null) {
                    throw new IllegalStateException("Missing binary fragment " + i + " for msgId "
                            + msgId);
                }
                totalLen += fragment.length;
            }

            byte[] result = new byte[totalLen];
            int offset = 0;
            for (int i = 0; i < fragCount; i++) {
                byte[] fragment = fragments.get(i);
                System.arraycopy(fragment, 0, result, offset, fragment.length);
                offset += fragment.length;
            }
            return result;
        }
    }
}
