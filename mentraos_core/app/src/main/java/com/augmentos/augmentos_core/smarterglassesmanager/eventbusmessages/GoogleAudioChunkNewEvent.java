package com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages;

public class GoogleAudioChunkNewEvent {
    public byte [] thisChunk;

    public GoogleAudioChunkNewEvent(byte [] thisChunk){
        this.thisChunk = thisChunk;
    }
}
