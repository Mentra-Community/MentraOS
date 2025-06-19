package com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition;

import android.content.Context;

import java.util.List;

public abstract class SpeechRecFramework {
    private ASR_FRAMEWORKS asrFramework;
    private Context mContext;
    public boolean pauseAsrFlag = false;

    public abstract void start();
    public abstract void destroy();
    public abstract void ingestAudioChunk(byte [] audioChunk);

    public abstract void ingestLC3AudioChunk(byte [] audioChunk);

    public void pauseAsr(boolean pauseAsrFlag){
        this.pauseAsrFlag = pauseAsrFlag;
    }

    public abstract void updateConfig(List<AsrStreamKey> languages);

    public abstract void microphoneStateChanged(boolean state);

    public void changeBypassVadForDebuggingState(boolean bypassVadForDebugging) {
    }
}
