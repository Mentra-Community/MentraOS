package com.mentra.asg_client.service.core.processors;

import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * Protocol detection strategy for chunked messages.
 * Detects and handles reassembly of messages split across multiple chunks.
 */
public class ChunkedMessageProtocolStrategy implements CommandProtocolDetector.ProtocolDetectionStrategy {
    private static final String TAG = "ChunkedMessageStrategy";
    
    private final ChunkReassembler chunkReassembler;
    
    public ChunkedMessageProtocolStrategy(ChunkReassembler chunkReassembler) {
        this.chunkReassembler = chunkReassembler;
    }
    
    @Override
    public boolean canHandle(JSONObject json) {
        // Can handle if it has a "C" field containing chunked message
        if (json.has("C")) {
            String dataPayload = json.optString("C", "");
            try {
                JSONObject innerJson = new JSONObject(dataPayload);
                String type = innerJson.optString("type", "");
                return "chunked_msg".equals(type);
            } catch (JSONException e) {
                // Not valid JSON in C field or not chunked message
                return false;
            }
        }
        
        // Also check direct format (for testing or future use)
        String type = json.optString("type", "");
        return "chunked_msg".equals(type);
    }
    
    @Override
    public CommandProtocolDetector.ProtocolDetectionResult detect(JSONObject json) {
        try {
            JSONObject chunkMessage;
            
            // Extract chunk message from C field if present
            if (json.has("C")) {
                String dataPayload = json.optString("C", "");
                chunkMessage = new JSONObject(dataPayload);
                Log.d(TAG, "Detected chunked message in C field format");
            } else {
                // Direct format
                chunkMessage = json;
                Log.d(TAG, "Detected chunked message in direct format");
            }
            
            // Extract chunk information
            String chunkId = chunkMessage.getString("chunkId");
            int chunkIndex = chunkMessage.getInt("chunk");
            int totalChunks = chunkMessage.getInt("total");
            String data = chunkMessage.getString("data");
            long messageId = chunkMessage.optLong("mId", -1);
            
            Log.d(TAG, "Processing chunk " + chunkIndex + "/" + (totalChunks - 1) + 
                      " for session " + chunkId + 
                      (messageId != -1 ? " (mId: " + messageId + ")" : ""));
            
            // Add chunk to reassembler
            String reassembled = chunkReassembler.addChunk(chunkId, chunkIndex, totalChunks, data);
            
            if (reassembled != null) {
                // Message complete - parse and return the reassembled message
                Log.d(TAG, "Chunk session " + chunkId + " complete, processing reassembled message");
                
                try {
                    JSONObject reassembledJson = new JSONObject(reassembled);
                    
                    // Extract command type and message ID from reassembled message
                    String commandType = reassembledJson.optString("type", "");
                    long reassembledMessageId = reassembledJson.optLong("mId", messageId);
                    
                    Log.d(TAG, "Reassembled message type: " + commandType + 
                              ", messageId: " + reassembledMessageId);
                    
                    return new CommandProtocolDetector.ProtocolDetectionResult(
                        CommandProtocolDetector.ProtocolType.JSON_COMMAND,
                        reassembledJson,
                        commandType,
                        reassembledMessageId,
                        true
                    );
                    
                } catch (JSONException e) {
                    Log.e(TAG, "Failed to parse reassembled message as JSON: " + reassembled, e);
                    
                    // Return as unknown protocol if not valid JSON
                    return new CommandProtocolDetector.ProtocolDetectionResult(
                        CommandProtocolDetector.ProtocolType.UNKNOWN,
                        json,
                        "",
                        messageId,
                        false
                    );
                }
            } else {
                // Chunk added but message not complete yet
                Log.d(TAG, "Chunk added, waiting for more chunks");
                
                // Return a special result indicating chunk processing in progress
                // This should not trigger further processing
                return new CommandProtocolDetector.ProtocolDetectionResult(
                    CommandProtocolDetector.ProtocolType.JSON_COMMAND,
                    null,  // No data to process yet
                    "chunk_in_progress",
                    -1,    // No ACK needed for individual chunks
                    false  // Not valid for processing
                );
            }
            
        } catch (Exception e) {
            Log.e(TAG, "Error processing chunked message", e);
            return new CommandProtocolDetector.ProtocolDetectionResult(
                CommandProtocolDetector.ProtocolType.UNKNOWN,
                json,
                "",
                -1,
                false
            );
        }
    }
    
    @Override
    public CommandProtocolDetector.ProtocolType getProtocolType() {
        return CommandProtocolDetector.ProtocolType.JSON_COMMAND;
    }
}