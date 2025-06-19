package com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition;

import android.content.Context;
import android.util.Log;

import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.AudioChunkNewEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.BypassVadForDebuggingEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.LC3AudioChunkNewEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.hci.AudioProcessingCallback;
import com.augmentos.augmentos_core.smarterglassesmanager.eventbusmessages.PauseAsrEvent;
import com.augmentos.augmentos_core.smarterglassesmanager.speechrecognition.augmentos.SpeechRecAugmentos;

import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.Subscribe;

import java.util.List;

//send audio to one of the built in ASR frameworks.
public class SpeechRecSwitchSystem implements AudioProcessingCallback {
    private final String TAG = "WearableAi_SpeechRecSwitchSystem";
    private ASR_FRAMEWORKS asrFramework;
    private SpeechRecFramework speechRecFramework;
    private Context mContext;
    public String currentLanguage;
    public boolean microphoneState;

    public SpeechRecSwitchSystem(Context mContext) {
        this.mContext = mContext;
        this.microphoneState = true;
    }

    public void microphoneStateChanged(boolean state){
        microphoneState = state;
        if (speechRecFramework != null){
            speechRecFramework.microphoneStateChanged(state);
        }
    }

    public void startAsrFramework(ASR_FRAMEWORKS asrFramework) {
        //kill old asr
        EventBus.getDefault().unregister(this);
        if (speechRecFramework != null){
            speechRecFramework.destroy();
        }

        //set new asr
        this.asrFramework = asrFramework;

        //create new asr
        speechRecFramework = SpeechRecAugmentos.getInstance(mContext);

        //start asr
        speechRecFramework.start();
        EventBus.getDefault().register(this);
    }

    // Removed EventBus subscribers for AudioChunkNewEvent and LC3AudioChunkNewEvent
    // Now using direct callbacks for better performance and battery efficiency

    // BATTERY OPTIMIZATION: Added direct method call to avoid EventBus overhead
    public void setBypassVad(boolean bypass) {
        if (speechRecFramework != null) {
            speechRecFramework.changeBypassVadForDebuggingState(bypass);
        }
    }
    
    @Subscribe
    public void onBypassVadForDebuggingEvent(BypassVadForDebuggingEvent receivedEvent){
        //redirect audio to the currently in use ASR framework
        setBypassVad(receivedEvent.bypassVadForDebugging);
    }

    // BATTERY OPTIMIZATION: Added direct method call to avoid EventBus overhead
    public void pauseAsr(boolean pause) {
        if (speechRecFramework != null) {
            speechRecFramework.pauseAsr(pause);
        }
    }
    
    @Subscribe
    public void onPauseAsrEvent(PauseAsrEvent receivedEvent){
        //redirect audio to the currently in use ASR framework
        pauseAsr(receivedEvent.pauseAsr);
    }

    public void destroy(){
        if (speechRecFramework != null){
            speechRecFramework.destroy();
            speechRecFramework = null; // BATTERY OPTIMIZATION: Prevent memory leaks
        }
        
        // BATTERY OPTIMIZATION: Safe EventBus unregistration
        try {
            if (EventBus.getDefault().isRegistered(this)) {
                EventBus.getDefault().unregister(this);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error unregistering from EventBus", e);
        }
        
        // BATTERY OPTIMIZATION: Clear context reference
        mContext = null;
    }

    public void updateConfig(List<AsrStreamKey> languages){
        speechRecFramework.updateConfig(languages);
    }
    
    // Direct callback implementations - much more efficient than EventBus
    @Override
    public void onAudioDataAvailable(byte[] audioData) {
        if (speechRecFramework != null && !speechRecFramework.pauseAsrFlag) {
            speechRecFramework.ingestAudioChunk(audioData);
        }
    }
    
    @Override
    public void onLC3AudioDataAvailable(byte[] lc3Data) {
        if (speechRecFramework != null && !speechRecFramework.pauseAsrFlag) {
            speechRecFramework.ingestLC3AudioChunk(lc3Data);
        }
    }
}

