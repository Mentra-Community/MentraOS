package com.mentra.asg_client.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import com.mentra.asg_client.service.core.AsgClientService;
import java.util.Locale;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Injects a power-button gesture into BES as UART {@code mh_dbgkey}. Ships in release builds.
 *
 * <p>The receiver is exported but guarded by {@code android.permission.DUMP}, so only {@code adb
 * shell} or a privileged holder can deliver the broadcast. Every call is logged.
 *
 * <pre>
 *   adb shell am broadcast -a com.mentra.BES_BUTTON -p com.mentra.asg_client --es gesture triple
 * </pre>
 *
 * {@code gesture} is one of {@code single|double|triple|long}. Anything else is rejected. BES
 * additionally whitelists gestures, rate-limits to one per 2 s and ignores {@code mh_dbgkey} on the
 * phone BLE path.
 */
public class BesButtonInjectReceiver extends BroadcastReceiver {
    private static final String TAG = "BesButtonInjectReceiver";

    public static final String ACTION_BES_BUTTON = "com.mentra.BES_BUTTON";
    public static final String EXTRA_GESTURE = "gesture";

    public static final String GESTURE_SINGLE = "single";
    public static final String GESTURE_DOUBLE = "double";
    public static final String GESTURE_TRIPLE = "triple";
    public static final String GESTURE_LONG = "long";

    /** Sends one UART JSON line to BES. */
    interface Sender {
        boolean send(String json);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) {
            return;
        }
        handle(
                intent.getAction(),
                intent.getStringExtra(EXTRA_GESTURE),
                BesButtonInjectReceiver::sendViaService);
    }

    /**
     * Validates and forwards one injection request.
     *
     * @return true if a payload was handed to the sender and the sender accepted it
     */
    static boolean handle(String action, String gesture, Sender sender) {
        Log.i(TAG, "BES_BUTTON action=" + action + " gesture=" + gesture);
        if (!ACTION_BES_BUTTON.equals(action)) {
            Log.w(TAG, "rejected: unexpected action");
            return false;
        }
        String payload = buildPayload(gesture);
        if (payload == null) {
            Log.w(TAG, "rejected: unknown or missing gesture=" + gesture);
            return false;
        }
        if (sender == null) {
            Log.e(TAG, "rejected: no UART sender");
            return false;
        }
        boolean sent = sender.send(payload);
        Log.i(TAG, "mh_dbgkey sent=" + sent + " " + payload);
        return sent;
    }

    /**
     * Builds {@code {"C":"mh_dbgkey","V":1,"B":{"key":"pwr","gesture":"<g>"}}}.
     *
     * @return the JSON line, or {@code null} for a missing or unknown gesture
     */
    static String buildPayload(String gesture) {
        String normalized = normalizeGesture(gesture);
        if (normalized == null) {
            return null;
        }
        try {
            JSONObject body = new JSONObject();
            body.put("key", "pwr");
            body.put("gesture", normalized);
            JSONObject command = new JSONObject();
            command.put("C", "mh_dbgkey");
            command.put("V", 1);
            command.put("B", body);
            return command.toString();
        } catch (JSONException e) {
            Log.e(TAG, "failed to build mh_dbgkey", e);
            return null;
        }
    }

    /** @return the canonical gesture name, or {@code null} if it is not whitelisted */
    static String normalizeGesture(String gesture) {
        if (gesture == null) {
            return null;
        }
        String g = gesture.toLowerCase(Locale.ROOT);
        switch (g) {
            case GESTURE_SINGLE:
            case GESTURE_DOUBLE:
            case GESTURE_TRIPLE:
            case GESTURE_LONG:
                return g;
            default:
                return null;
        }
    }

    private static boolean sendViaService(String json) {
        AsgClientService service = AsgClientService.getInstance();
        if (service == null) {
            Log.e(TAG, "AsgClientService not running; cannot reach BES UART");
            return false;
        }
        return service.sendBesUartCommand(json);
    }
}
