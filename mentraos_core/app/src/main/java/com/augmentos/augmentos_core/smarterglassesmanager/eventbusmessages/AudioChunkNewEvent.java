package com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages;

public class AudioChunkNewEvent {
    public byte [] thisChunk;

    public AudioChunkNewEvent(byte [] thisChunk){
        this.thisChunk = thisChunk;
    }
}
