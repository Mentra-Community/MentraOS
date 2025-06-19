package com.augmentos.augmentos_core.smarterglassesmanager.hci;

/**
 * Callback interface for components that process audio data.
 * This replaces EventBus events (AudioChunkNewEvent, LC3AudioChunkNewEvent)
 * with a more direct callback approach for better performance and battery efficiency.
 */
public interface AudioProcessingCallback {
    /**
     * Called when new PCM audio data is available
     * @param audioData Raw PCM audio bytes
     */
    void onAudioDataAvailable(byte[] audioData);
    
    /**
     * Called when new LC3-encoded audio data is available
     * @param lc3Data LC3-encoded audio bytes
     */
    void onLC3AudioDataAvailable(byte[] lc3Data);
}
