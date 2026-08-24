package com.mentra.asg_client.service.core.handlers.subscribers;

import android.content.Context;
import android.util.Log;
import com.mentra.asg_client.audio.PairingCodeSpeaker;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.io.peripheral.events.SpeakPairingCodeEvent;

/** Plays the stitched pairing-code phrase when BES sends {@code hm_spkcode}. */
public final class PairingAudioEventSubscriber implements IPeripheralBus.McuEventListener {

    private static final String TAG = "PairingAudioEventSubscriber";

    private final Context context;
    private final IHardwareManager hardwareManager;

    public PairingAudioEventSubscriber(Context context, IHardwareManager hardwareManager) {
        this.context = context.getApplicationContext();
        this.hardwareManager = hardwareManager;
    }

    @Override
    public void onMcuEvent(McuEvent event) {
        if (!(event instanceof SpeakPairingCodeEvent)) {
            return;
        }
        SpeakPairingCodeEvent speakEvent = (SpeakPairingCodeEvent) event;
        Log.i(TAG, "hm_spkcode received code=" + speakEvent.getCode());
        PairingCodeSpeaker.speak(context, hardwareManager, speakEvent.getCode());
    }
}
