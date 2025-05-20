package com.augmentos.asg_client.bluetooth.utils;

import android.util.Log;

/**
 * CircleBuffer implementation for buffering UART data.
 * Adapted from K900_server_sdk CircleBuffer.
 */
public class CircleBuffer {
    private static final String TAG = "CircleBuffer";
    
    private int begin = 0;
    private int end = 0;
    private byte[] mBuf = null;
    private int mLen = 0;
    
    /**
     * Create a new CircleBuffer with the specified length
     * @param len Buffer size in bytes
     */
    public CircleBuffer(int len) {
        mLen = len;
        mBuf = new byte[len];
        Log.d(TAG, "Created CircleBuffer with size " + len + " bytes");
    }
    
    /**
     * Add data to the buffer
     * @param buf Source buffer
     * @param offset Offset in source buffer
     * @param len Length to add
     * @return true if add was successful, false if buffer is full
     */
    public boolean add(byte[] buf, int offset, int len) {
        if (len > mLen) {
            Log.w(TAG, "Cannot add data larger than buffer size: " + len + " > " + mLen);
            return false;
        }
        
        if (canAdd(len)) {
            if (end >= begin) {
                int laterSize = mLen - end;
                if (laterSize >= len) {
                    ByteUtil.copyBytes(buf, offset, len, mBuf, end);
                    end += len;
                    end = end % mLen;
                } else {
                    int offset2 = offset;
                    if (laterSize > 0) {
                        ByteUtil.copyBytes(buf, offset2, laterSize, mBuf, end);
                        offset2 += laterSize;
                    }
                    int frontSize = begin - 1;
                    if (frontSize < len - laterSize) {
                        Log.w(TAG, "Not enough space in front portion of buffer");
                        return false;
                    }
                    int cpSize = len - laterSize;
                    ByteUtil.copyBytes(buf, offset2, cpSize, mBuf, 0);
                    end = cpSize;
                }
            } else {
                int remaindSize = begin - end - 1;
                if (remaindSize >= len) {
                    ByteUtil.copyBytes(buf, offset, len, mBuf, end);
                    end += len;
                } else {
                    Log.w(TAG, "Not enough space in buffer: need " + len + ", have " + remaindSize);
                    return false;
                }
            }
            
            // Keep this circle buffer log
            Log.d(TAG, "Added " + len + " bytes to buffer, now contains " + getDataLen() + " bytes");
            return true;
        } else {
            Log.w(TAG, "Cannot add " + len + " bytes to buffer");
            return false;
        }
    }
    
    /**
     * Fetch data from the buffer without removing it
     * @param buf Destination buffer
     * @param offset Offset in destination buffer
     * @param len Maximum length to fetch
     * @return Actual number of bytes fetched
     */
    public int fetch(byte[] buf, int offset, int len) {
        if (begin == end) {
            return 0;
        }
        
        int fetchSize = 0;
        if (end > begin) {
            fetchSize = (end - begin) >= len ? len : (end - begin);
            ByteUtil.copyBytes(mBuf, begin, fetchSize, buf, offset);
            return fetchSize;
        } else {
            int laterSize = mLen - begin;
            if (len <= laterSize) {
                ByteUtil.copyBytes(mBuf, begin, len, buf, offset);
                return len;
            } else {
                int offset2 = offset;
                if (laterSize > 0) {
                    ByteUtil.copyBytes(mBuf, begin, laterSize, buf, offset2);
                    offset2 += laterSize;
                }
                
                int frontSize = end;
                if (len - laterSize <= frontSize) {
                    fetchSize = len - laterSize;
                } else {
                    fetchSize = frontSize;
                }
                
                ByteUtil.copyBytes(mBuf, 0, fetchSize, buf, offset2);
                return (fetchSize + laterSize);
            }
        }
    }
    
    /**
     * Get the amount of data in the buffer
     * @return Number of bytes in the buffer
     */
    public int getDataLen() {
        if (begin == end) {
            return 0;
        }
        
        if (end > begin) {
            return (end - begin);
        } else {
            return (mLen + end - begin);
        }
    }
    
    /**
     * Remove data from the head of the buffer
     * @param size Number of bytes to remove
     */
    public void removeHead(int size) {
        if (end >= begin) {
            if (begin + size >= end) {
                begin = end;
            } else {
                begin += size;
            }
        } else {
            int remaindSize = mLen - begin + end;
            if (size >= remaindSize) {
                begin = end;
            } else {
                begin = (begin + size) % mLen;
            }
        }
        
        // Keep this circle buffer log
        Log.d(TAG, "Removed " + size + " bytes from buffer head, " + getDataLen() + " bytes remaining");
    }
    
    /**
     * Clear the buffer
     */
    public void clear() {
        begin = end = 0;
        for (int i = 0; i < mLen; i++) {
            mBuf[i] = 0;
        }
        // Keep this circle buffer log
        Log.d(TAG, "Buffer cleared");
    }
    
    /**
     * Check if the buffer can add the specified amount of data
     * @param size Size to check
     * @return true if the data can be added, false otherwise
     */
    private boolean canAdd(int size) {
        if (size >= mLen) {
            return false;
        }
        
        if (begin == end) {
            // empty list
            return true;
        }
        
        int remaind = 0;
        if (end > begin) {
            remaind = mLen - (end - begin) - 1;
        } else {
            remaind = begin - end - 1;
        }
        
        return size <= remaind;
    }
}