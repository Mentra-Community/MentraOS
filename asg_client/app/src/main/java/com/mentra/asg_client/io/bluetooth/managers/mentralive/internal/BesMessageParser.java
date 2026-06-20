package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import android.util.Log;

import com.mentra.asg_client.io.bluetooth.utils.ByteUtil;
import com.mentra.asg_client.io.bluetooth.utils.CircleBuffer;

import java.util.ArrayList;
import java.util.List;

/**
 * Parser for K900 protocol messages. Uses a CircleBuffer to handle fragmented messages across
 * multiple UART reads.
 */
public class BesMessageParser {
    private static final String TAG = "BesMessageParser";

    // K900 Protocol markers
    private static final String PROTOCOL_START_MARKER = "##";
    private static final String PROTOCOL_END_MARKER = "$$";
    private static final byte[] START_MARKER_BYTES = {0x23, 0x23}; // ##
    private static final byte[] END_MARKER_BYTES = {0x24, 0x24}; // $$

    // Buffer size for parsing messages
    private static final int BUFFER_SIZE = 8192; // 8KB buffer
    private static final int STRING_FRAME_OVERHEAD = 7; // ## + type + length + payload + $$
    private static final int FILE_FRAME_OVERHEAD =
            BesWireFormat.LENGTH_FILE_START
                    + BesWireFormat.LENGTH_FILE_TYPE
                    + BesWireFormat.LENGTH_FILE_PACKSIZE
                    + BesWireFormat.LENGTH_FILE_PACKINDEX
                    + BesWireFormat.LENGTH_FILE_SIZE
                    + BesWireFormat.LENGTH_FILE_NAME
                    + BesWireFormat.LENGTH_FILE_FLAG
                    + BesWireFormat.LENGTH_FILE_VERIFY
                    + BesWireFormat.LENGTH_FILE_END;
    private static final int FRAME_INCOMPLETE = -1;
    private static final int FRAME_INVALID = -2;

    private final CircleBuffer mCircleBuffer;
    private final byte[] mTempBuffer;

    /** Create a new BesMessageParser */
    public BesMessageParser() {
        mCircleBuffer = new CircleBuffer(BUFFER_SIZE);
        mTempBuffer = new byte[BUFFER_SIZE];
        Log.d(TAG, "BesMessageParser initialized with " + BUFFER_SIZE + " byte buffer");
    }

    /**
     * Add data to the message buffer
     *
     * @param data Raw data received from UART
     * @param size Size of the data
     * @return true if data was added successfully
     */
    public boolean addData(byte[] data, int size) {
        if (data == null || size <= 0) {
            return false;
        }

        // Always append the full UART read. parseMessages() is responsible for
        // extracting all complete ##...$$ frames (including multiple frames per read).
        boolean added = mCircleBuffer.add(data, 0, size);
        if (!added) {
            Log.w(TAG, "Failed to append " + size + " bytes to parser buffer");
        }
        return added;
    }

    /**
     * Parse and extract complete messages from the buffer
     *
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
        int removeUntil = 0;

        // Continue until we can't find any more complete messages
        while (currentPos < fetchSize) {
            // Find start marker
            int startMarkerPos =
                    findMarker(mTempBuffer, currentPos, fetchSize - currentPos, START_MARKER_BYTES);
            if (startMarkerPos == -1) {
                // No complete marker pair. Drop junk but preserve a trailing single '#'
                // because it may be the first byte of a split start marker.
                if (completeMessages.isEmpty()) {
                    removeUntil = trailingPartialStartOffset(mTempBuffer, fetchSize);
                }
                break;
            }

            // If we found a start marker that's not at our current position, skip to it
            if (startMarkerPos > currentPos) {
                removeUntil = startMarkerPos;
                currentPos = startMarkerPos;
            }

            int messageLength = getExpectedFrameLength(mTempBuffer, currentPos, fetchSize);
            if (messageLength == FRAME_INCOMPLETE) {
                break;
            }

            if (messageLength == FRAME_INVALID) {
                int nextStart =
                        findMarker(
                                mTempBuffer,
                                currentPos + START_MARKER_BYTES.length,
                                fetchSize - currentPos - START_MARKER_BYTES.length,
                                START_MARKER_BYTES);
                if (nextStart == -1) {
                    removeUntil = currentPos + START_MARKER_BYTES.length;
                    currentPos = removeUntil;
                } else {
                    Log.w(
                            TAG,
                            "Dropping malformed K900 frame prefix and resyncing at offset "
                                    + nextStart);
                    removeUntil = nextStart;
                    currentPos = nextStart;
                }
                continue;
            }

            // Extract the complete message
            byte[] completeMessage = new byte[messageLength];
            ByteUtil.copyBytes(mTempBuffer, currentPos, messageLength, completeMessage, 0);

            // Verify this looks like a valid K900 message with proper structure
            if (isValidK900Message(completeMessage)) {
                completeMessages.add(completeMessage);
            }

            // Move past this message
            currentPos += messageLength;
            removeUntil = currentPos;
        }

        // Remove the processed data from the circle buffer
        if (removeUntil > 0) {
            mCircleBuffer.removeHead(removeUntil);
            // Keep this log as it's useful for monitoring circle buffer state
            Log.d(
                    TAG,
                    "Removed "
                            + removeUntil
                            + " bytes from buffer, "
                            + mCircleBuffer.getDataLen()
                            + " remaining");
        }

        return completeMessages.isEmpty() ? null : completeMessages;
    }

    private int getExpectedFrameLength(byte[] buffer, int start, int fetchSize) {
        int available = fetchSize - start;
        if (available < 5) {
            return FRAME_INCOMPLETE;
        }

        byte commandType = buffer[start + 2];
        if (commandType == BesWireFormat.CMD_TYPE_STRING) {
            return getExpectedStringFrameLength(buffer, start, available);
        }

        if (isFileCommandType(commandType)) {
            return getExpectedFileFrameLength(buffer, start, available);
        }

        Log.w(TAG, "Unknown K900 command type: 0x" + String.format("%02X", commandType));
        return FRAME_INVALID;
    }

    private int getExpectedStringFrameLength(byte[] buffer, int start, int available) {
        int beLength = ((buffer[start + 3] & 0xFF) << 8) | (buffer[start + 4] & 0xFF);
        int leLength = (buffer[start + 3] & 0xFF) | ((buffer[start + 4] & 0xFF) << 8);

        int beFrameLength = beLength + STRING_FRAME_OVERHEAD;
        int leFrameLength = leLength + STRING_FRAME_OVERHEAD;

        boolean waitingForMore = false;
        boolean sawCompleteButMalformed = false;

        int beStatus = getCandidateFrameStatus(buffer, start, available, beFrameLength);
        if (beStatus > 0) {
            return beStatus;
        } else if (beStatus == FRAME_INCOMPLETE) {
            waitingForMore = true;
        } else {
            sawCompleteButMalformed = true;
        }

        if (leFrameLength != beFrameLength) {
            int leStatus = getCandidateFrameStatus(buffer, start, available, leFrameLength);
            if (leStatus > 0) {
                return leStatus;
            } else if (leStatus == FRAME_INCOMPLETE) {
                waitingForMore = true;
            } else {
                sawCompleteButMalformed = true;
            }
        }

        if (waitingForMore && !sawCompleteButMalformed) {
            return FRAME_INCOMPLETE;
        }

        return waitingForMore ? FRAME_INCOMPLETE : FRAME_INVALID;
    }

    private int getCandidateFrameStatus(byte[] buffer, int start, int available, int frameLength) {
        if (frameLength < STRING_FRAME_OVERHEAD || frameLength > BUFFER_SIZE) {
            return FRAME_INVALID;
        }

        if (available < frameLength) {
            return FRAME_INCOMPLETE;
        }

        int endMarkerPos = start + frameLength - END_MARKER_BYTES.length;
        if (hasMarkerAt(buffer, endMarkerPos, END_MARKER_BYTES)) {
            return frameLength;
        }

        return FRAME_INVALID;
    }

    private int getExpectedFileFrameLength(byte[] buffer, int start, int available) {
        int packSize = ((buffer[start + 3] & 0xFF) << 8) | (buffer[start + 4] & 0xFF);
        int frameLength = FILE_FRAME_OVERHEAD + packSize;
        if (frameLength < FILE_FRAME_OVERHEAD || frameLength > BUFFER_SIZE) {
            return FRAME_INVALID;
        }

        if (available < frameLength) {
            return FRAME_INCOMPLETE;
        }

        int endMarkerPos = start + frameLength - END_MARKER_BYTES.length;
        return hasMarkerAt(buffer, endMarkerPos, END_MARKER_BYTES) ? frameLength : FRAME_INVALID;
    }

    private boolean isFileCommandType(byte commandType) {
        return commandType == BesWireFormat.CMD_TYPE_PHOTO
                || commandType == BesWireFormat.CMD_TYPE_VIDEO
                || commandType == BesWireFormat.CMD_TYPE_MUSIC
                || commandType == BesWireFormat.CMD_TYPE_AUDIO
                || commandType == BesWireFormat.CMD_TYPE_DATA;
    }

    private boolean hasMarkerAt(byte[] buffer, int offset, byte[] marker) {
        return offset >= 0
                && offset + marker.length <= buffer.length
                && buffer[offset] == marker[0]
                && buffer[offset + 1] == marker[1];
    }

    private int trailingPartialStartOffset(byte[] buffer, int length) {
        if (length > 0 && buffer[length - 1] == START_MARKER_BYTES[0]) {
            return length - 1;
        }
        return length;
    }

    /**
     * Validate that a message appears to follow the K900 protocol format
     *
     * @param message The message bytes to validate
     * @return true if the message appears valid
     */
    private boolean isValidK900Message(byte[] message) {
        if (message == null || message.length < 8) { // Minimum size for a valid message
            return false;
        }

        // Check start marker
        if (message[0] != START_MARKER_BYTES[0] || message[1] != START_MARKER_BYTES[1]) {
            return false;
        }

        // Check end marker
        int len = message.length;
        if (message[len - 2] != END_MARKER_BYTES[0] || message[len - 1] != END_MARKER_BYTES[1]) {
            return false;
        }

        // Message has proper markers
        return true;
    }

    /**
     * Find a marker (start or end) in the buffer
     *
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
            if (buffer[i] == marker[0] && buffer[i + 1] == marker[1]) {
                return i;
            }
        }

        return -1;
    }

    /** Clear the message buffer */
    public void clear() {
        mCircleBuffer.clear();
        Log.d(TAG, "Message buffer cleared");
    }

    /**
     * Get the current buffer size
     *
     * @return Number of bytes currently in the buffer
     */
    public int getBufferSize() {
        return mCircleBuffer.getDataLen();
    }
}
