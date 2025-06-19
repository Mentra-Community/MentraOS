package com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages;

public class LC3AudioChunkNewEvent {
    public byte [] thisChunk;

    public LC3AudioChunkNewEvent(byte [] thisChunk){
        this.thisChunk = thisChunk;
    }
}
