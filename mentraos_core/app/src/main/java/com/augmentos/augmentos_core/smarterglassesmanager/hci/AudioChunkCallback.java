package com.augmentos.augmentos_core.smarterglassesmanager.hci;

import java.nio.ByteBuffer;

public interface AudioChunkCallback{
    void onSuccess(ByteBuffer chunk);
}