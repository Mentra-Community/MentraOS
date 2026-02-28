package com.mentra.asg_client.io.bluetooth.utils;

import android.util.Log;

import java.util.ArrayList;
import java.util.List;

/**
 * Parser for K900 protocol messages.
 * Uses a CircleBuffer to handle fragmented messages across multiple UART reads.
 */
public class K900MessageParser {
    private static final String TAG = "K900MessageParser";
    
    // K900 Protocol markers
    private static final String PROTOCOL_START_MARKER = "##";
    private static final String PROTOCOL_END_MARKER = "$$";
    private static final byte[] START_MARKER_BYTES = {0x23, 0x23}; // ##
    private static final byte[] END_MARKER_BYTES = {0x24, 0x24};   // $$
    
    // Buffer size for parsing messages
    private static final int BUFFER_SIZE = 8192; // 8KB buffer
    
    private final CircleBuffer mCircleBuffer;
    private final byte[] mTempBuffer;
    
    /**
     * Create a new K900MessageParser
     */
    public K900MessageParser() {
        mCircleBuffer = new CircleBuffer(BUFFER_SIZE);
        mTempBuffer = new byte[BUFFER_SIZE];
        Log.d(TAG, "K900MessageParser initialized with " + BUFFER_SIZE + " byte buffer");
    }
    
    /**
     * Add data to the message buffer
     * @param data Raw data received from UART
     * @param size Size of the data
     * @return true if data was added successfully
     */
    public boolean addData(byte[] data, int size) {
        if (data == null || size <= 0) {
            return false;
        }
        
        // Check for message markers in this chunk
        boolean hasStart = false;
        int startPos = -1;
        boolean hasEnd = false;
        int endPos = -1;
        
        for (int i = 0; i < size - 1; i++) {
            if (data[i] == START_MARKER_BYTES[0] && data[i+1] == START_MARKER_BYTES[1]) {
                hasStart = true;
                startPos = i;
            }
            if (data[i] == END_MARKER_BYTES[0] && data[i+1] == END_MARKER_BYTES[1]) {
                hasEnd = true;
                endPos = i;
            }
        }
        
        // Keep core circle buffer handling logs but make them less verbose
        if (hasStart && hasEnd && startPos < endPos) {
            // Complete message in a single chunk - just add the exact portion
            if (mCircleBuffer.getDataLen() > 0) {
                Log.d(TAG, "Buffer has incomplete message - clearing");
                mCircleBuffer.clear();
            }
            // Only add the relevant portion (from ## to $$ inclusive)
            return mCircleBuffer.add(data, startPos, (endPos + 2) - startPos);
        } else if (hasStart) {
            // Found start of a new message
            if (mCircleBuffer.getDataLen() > 0) {
                Log.d(TAG, "New message start detected, clearing buffer");
                mCircleBuffer.clear();
            }
            return mCircleBuffer.add(data, startPos, size - startPos);
        } else if (hasEnd && mCircleBuffer.getDataLen() > 0) {
            // Found end of a message and buffer already has content
            return mCircleBuffer.add(data, 0, endPos + 2);
        } else if (!hasStart && !hasEnd && mCircleBuffer.getDataLen() > 0) {
            // Middle portion of a fragmented message
            return mCircleBuffer.add(data, 0, size);
        } else if (!hasStart && !hasEnd && mCircleBuffer.getDataLen() == 0) {
            // Unexpected data with no markers and empty buffer
            return true; // pretend we succeeded but don't store anything
        } else {
            return mCircleBuffer.add(data, 0, size);
        }
    }
    
    /**
     * Parse and extract complete messages from the buffer
     * @return List of complete messages, or null if none were found
     */
    public List<byte[]> parseMessages() {
        int dataLen = mCircleBuffer.getDataLen();
        if (dataLen == 0) {
            return null;
        }
        
        // Fetch all available data into our temp buffer
        int fetchSize = mCircleBuffer.fetch(mTempBuffer, 0, dataLen);
        if (fetchSize == 0) {
            return null;
        }
        
        List<byte[]> completeMessages = new ArrayList<>();
        int currentPos = 0;
        boolean foundValidMessage = false;
        
        // Continue until we can't find any more complete messages
        while (currentPos < fetchSize) {
            // Find start marker
            int startMarkerPos = findMarker(mTempBuffer, currentPos, fetchSize - currentPos, START_MARKER_BYTES);
            if (startMarkerPos == -1) {
                // No start marker found
                if (!foundValidMessage) {
                    // If we haven't found any valid messages, clear the whole buffer
                    mCircleBuffer.clear();
                    return null;
                }
                break;
            }
            
            // If we found a start marker that's not at our current position, skip to it
            if (startMarkerPos > currentPos) {
                currentPos = startMarkerPos;
            }
            
            // Find end marker
            int endMarkerPos = findMarker(mTempBuffer, currentPos + 2, fetchSize - currentPos - 2, END_MARKER_BYTES);
            if (endMarkerPos == -1) {
                // No end marker found
                // If we've already found at least one valid message, process that and keep the rest
                if (foundValidMessage) {
                    break;
                }
                
                // Check if buffer has been waiting too long
                // For now, if the buffer size exceeds a reasonable message size, clear it
                if (fetchSize > 512) {  // 512 bytes should be more than enough for any valid message
                    Log.d(TAG, "Buffer size too large without valid message - clearing");
                    mCircleBuffer.clear();
                }
                return null;
            }
            
            // Validate the message format (check ## is followed by at least 4 bytes of command header)
            if (endMarkerPos - currentPos < 6) {
                currentPos = endMarkerPos + 2;
                continue;
            }
            
            // Calculate message length including markers
            int messageLength = (endMarkerPos + 2) - currentPos;
            
            // Extract the complete message
            byte[] completeMessage = new byte[messageLength];
            ByteUtil.copyBytes(mTempBuffer, currentPos, messageLength, completeMessage, 0);
            
            // Verify this looks like a valid K900 message with proper structure
            if (isValidK900Message(completeMessage)) {
                completeMessages.add(completeMessage);
                foundValidMessage = true;
            }
            
            // Move past this message
            currentPos = endMarkerPos + 2;
        }
        
        // Remove the processed data from the circle buffer
        if (currentPos > 0) {
            mCircleBuffer.removeHead(currentPos);
            // Keep this log as it's useful for monitoring circle buffer state
            Log.d(TAG, "Removed " + currentPos + " bytes from buffer, " + 
                 mCircleBuffer.getDataLen() + " remaining");
        }
        
        return completeMessages.isEmpty() ? null : completeMessages;
    }
    
    /**
     * Validate that a message appears to follow the K900 protocol format
     * @param message The message bytes to validate
     * @return true if the message appears valid
     */
    private boolean isValidK900Message(byte[] message) {
        if (message == null || message.length < 8) {  // Minimum size for a valid message
            return false;
        }
        
        // Check start marker
        if (message[0] != START_MARKER_BYTES[0] || message[1] != START_MARKER_BYTES[1]) {
            return false;
        }
        
        // Check end marker
        int len = message.length;
        if (message[len-2] != END_MARKER_BYTES[0] || message[len-1] != END_MARKER_BYTES[1]) {
            return false;
        }
        
        // Message has proper markers
        return true;
    }
    
    /**
     * Find a marker (start or end) in the buffer
     * @param buffer The buffer to search
     * @param offset Starting position
     * @param length Length to search
     * @param marker The marker bytes to find
     * @return Position of the marker, or -1 if not found
     */
    private int findMarker(byte[] buffer, int offset, int length, byte[] marker) {
        if (buffer == null || marker == null || marker.length != 2) {
            return -1;
        }
        
        int maxPos = Math.min(offset + length, buffer.length - 1);
        for (int i = offset; i < maxPos; i++) {
            if (buffer[i] == marker[0] && buffer[i+1] == marker[1]) {
                return i;
            }
        }
        
        return -1;
    }
    
    /**
     * Clear the message buffer
     */
    public void clear() {
        mCircleBuffer.clear();
        Log.d(TAG, "Message buffer cleared");
    }
    
    /**
     * Get the current buffer size
     * @return Number of bytes currently in the buffer
     */
    public int getBufferSize() {
        return mCircleBuffer.getDataLen();
    }
}