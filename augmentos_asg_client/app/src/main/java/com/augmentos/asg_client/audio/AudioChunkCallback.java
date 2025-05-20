package com.augmentos.asg_client.audio;

import java.nio.ByteBuffer;

/**
 * Callback interface for audio chunks
 */
public interface AudioChunkCallback {
    /**
     * Called when a new audio chunk is available
     * @param chunk The audio chunk as a ByteBuffer
     */
    void onSuccess(ByteBuffer chunk);
}