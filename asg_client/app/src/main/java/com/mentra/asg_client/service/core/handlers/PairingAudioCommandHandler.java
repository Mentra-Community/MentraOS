package com.mentra.asg_client.service.core.handlers;

import android.content.Context;
import android.util.Log;
import com.mentra.asg_client.audio.PairingCodeSpeaker;
import com.mentra.asg_client.io.hardware.core.HardwareManagerFactory;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import java.util.Set;
import org.json.JSONObject;

/**
 * JSON command to speak a pairing code over I2S. Production traffic arrives as K900 {@code
 * hm_spkcode}; this handler exists for intent/BLE testing.
 */
public class PairingAudioCommandHandler implements ICommandHandler {

    private static final String TAG = "PairingAudioCommandHandler";
    public static final String COMMAND_SPEAK_PAIRING_CODE = "speak_pairing_code";

    private final Context context;

    public PairingAudioCommandHandler(Context context) {
        this.context = context.getApplicationContext();
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of(COMMAND_SPEAK_PAIRING_CODE);
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        if (!COMMAND_SPEAK_PAIRING_CODE.equals(commandType)) {
            Log.e(TAG, "Unsupported command: " + commandType);
            return false;
        }
        String code = data != null ? data.optString("code", "") : "";
        Log.i(TAG, "speak_pairing_code code=" + code);
        return PairingCodeSpeaker.speak(context, HardwareManagerFactory.getInstance(context), code);
    }
}
