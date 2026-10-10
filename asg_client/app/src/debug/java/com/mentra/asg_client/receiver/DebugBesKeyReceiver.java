package com.mentra.asg_client.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.service.core.AsgClientService;
import com.mentra.asg_client.service.core.handlers.K900CommandHandler;
import com.mentra.asg_client.service.core.processors.CommandProcessor;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;

import org.json.JSONObject;

import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;

/**
 * Debug-build-only receiver that forwards a key injection sequence to BES as {@code mh_dbgkey}.
 * BES only acts on it when built with MENTRA_DEBUG_KEY_INJECT=1.
 *
 * Usage:
 *   adb shell am broadcast -a com.mentra.DEBUG_BES_KEY -p com.mentra.asg_client \
 *     --es seq DU.DU.DU --ei gap_ms 150 [--es code pwr|fn2] [--ei delay_ms 0]
 *
 * seq: D down, U up, C click, 2 double, 3 triple, 4 ultra, 5 rampage, L longpress,
 * X longlongpress, '.' idle tick.
 */
public class DebugBesKeyReceiver extends BroadcastReceiver {
    private static final String TAG = "DebugBesKeyReceiver";
    public static final String ACTION_DEBUG_BES_KEY = "com.mentra.DEBUG_BES_KEY";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_DEBUG_BES_KEY.equals(intent.getAction())) {
            return;
        }
        String seq = intent.getStringExtra("seq");
        if (seq == null || seq.isEmpty()) {
            Log.e(TAG, "Missing seq extra");
            return;
        }
        String code = intent.getStringExtra("code");
        int gapMs = intent.getIntExtra("gap_ms", 150);
        int delayMs = intent.getIntExtra("delay_ms", 0);

        ICompanionTransport transport = findTransport();
        if (transport == null) {
            Log.e(TAG, "UART transport unavailable");
            return;
        }
        try {
            JSONObject body = new JSONObject();
            body.put("seq", seq);
            body.put("code", code != null ? code : "pwr");
            body.put("gap_ms", gapMs);
            body.put("delay_ms", delayMs);
            JSONObject command = new JSONObject();
            command.put("C", "mh_dbgkey");
            command.put("V", 1);
            command.put("B", body.toString());
            boolean sent = transport.sendMessage(command.toString().getBytes(StandardCharsets.UTF_8));
            Log.i(TAG, "mh_dbgkey sent=" + sent + " " + command);
        } catch (Exception e) {
            Log.e(TAG, "Failed to send mh_dbgkey", e);
        }
    }

    private ICompanionTransport findTransport() {
        AsgClientService service = AsgClientService.getInstance();
        CommandProcessor processor = service != null ? service.getCommandProcessor() : null;
        K900CommandHandler handler = processor != null ? processor.getK900CommandHandler() : null;
        if (handler == null) {
            return null;
        }
        try {
            Field field = K900CommandHandler.class.getDeclaredField("serviceManager");
            field.setAccessible(true);
            AsgClientServiceManager manager = (AsgClientServiceManager) field.get(handler);
            return manager != null ? manager.getBluetoothManager() : null;
        } catch (ReflectiveOperationException e) {
            Log.e(TAG, "Cannot reach service manager", e);
            return null;
        }
    }
}
