package com.mentra.asg_client.service.core.handlers.subscribers;

import android.content.Context;
import android.util.Log;
import com.mentra.asg_client.audio.PairingCodeSpeaker;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.io.peripheral.events.PairingModeExitEvent;
import com.mentra.asg_client.io.peripheral.events.SpeakPairingCodeEvent;

/** Plays pairing lifecycle speech when BES sends {@code hm_spkcode} or {@code hm_pairexit}. */
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
        if (event instanceof PairingModeExitEvent) {
            PairingModeExitEvent exitEvent = (PairingModeExitEvent) event;
            Log.i(TAG, "hm_pairexit received reason=" + exitEvent.getReason());
            PairingCodeSpeaker.speakPairingEnded(context, hardwareManager);
            return;
        }
        if (!(event instanceof SpeakPairingCodeEvent)) {
            return;
        }
        SpeakPairingCodeEvent speakEvent = (SpeakPairingCodeEvent) event;
        Log.i(TAG, "hm_spkcode received code=" + speakEvent.getCode());
        PairingCodeSpeaker.speak(context, hardwareManager, speakEvent.getCode());
    }
}
