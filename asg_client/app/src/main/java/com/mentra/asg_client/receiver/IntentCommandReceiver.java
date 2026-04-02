package com.mentra.asg_client.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.mentra.asg_client.service.core.AsgClientService;
import com.mentra.asg_client.service.core.processors.CommandProcessor;

import org.json.JSONObject;

/**
 * BroadcastReceiver that exposes the existing JSON command system to third-party
 * APKs running on the same device via Android Intents.
 *
 * Handles three actions:
 * - ACTION_SEND_COMMAND:        Accept a JSON command string and route it through CommandProcessor.
 * - ACTION_REGISTER_LISTENER:   Register a package to receive command responses.
 * - ACTION_UNREGISTER_LISTENER: Unregister a package from receiving command responses.
 *
 * Usage (adb example):
 *   adb shell am broadcast -a com.mentra.asg_client.ACTION_SEND_COMMAND \
 *     --es json '{"type":"ping","mId":12345}'
 */
public class IntentCommandReceiver extends BroadcastReceiver {
    private static final String TAG = "IntentCommandReceiver";

    public static final String ACTION_SEND_COMMAND = "com.mentra.asg_client.ACTION_SEND_COMMAND";
    public static final String ACTION_REGISTER_LISTENER = "com.mentra.asg_client.ACTION_REGISTER_LISTENER";
    public static final String ACTION_UNREGISTER_LISTENER = "com.mentra.asg_client.ACTION_UNREGISTER_LISTENER";
    public static final String ACTION_COMMAND_RESPONSE = "com.mentra.asg_client.ACTION_COMMAND_RESPONSE";

    public static final String EXTRA_JSON = "json";
    public static final String EXTRA_PACKAGE_NAME = "packageName";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) {
            return;
        }

        String action = intent.getAction();
        Log.d(TAG, "📥 Received intent: " + action);

        switch (action) {
            case ACTION_SEND_COMMAND:
                handleSendCommand(intent);
                break;
            case ACTION_REGISTER_LISTENER:
                handleRegisterListener(intent);
                break;
            case ACTION_UNREGISTER_LISTENER:
                handleUnregisterListener(intent);
                break;
            default:
                Log.w(TAG, "⚠️ Unknown action: " + action);
                break;
        }
    }

    private void handleSendCommand(Intent intent) {
        String jsonString = intent.getStringExtra(EXTRA_JSON);
        if (jsonString == null || jsonString.isEmpty()) {
            Log.w(TAG, "⚠️ ACTION_SEND_COMMAND missing 'json' extra");
            return;
        }

        AsgClientService service = AsgClientService.getInstance();
        if (service == null) {
            Log.e(TAG, "❌ AsgClientService not running - cannot process command");
            return;
        }

        CommandProcessor processor = service.getCommandProcessor();
        if (processor == null) {
            Log.e(TAG, "❌ CommandProcessor not available");
            return;
        }

        try {
            JSONObject json = new JSONObject(jsonString);
            Log.i(TAG, "📋 Processing intent command: " + json.optString("type", "unknown"));
            processor.processJsonCommand(json);
        } catch (Exception e) {
            Log.e(TAG, "💥 Failed to parse/process JSON command", e);
        }
    }

    private void handleRegisterListener(Intent intent) {
        String packageName = intent.getStringExtra(EXTRA_PACKAGE_NAME);
        if (packageName == null || packageName.isEmpty()) {
            Log.w(TAG, "⚠️ ACTION_REGISTER_LISTENER missing 'packageName' extra");
            return;
        }
        IntentResponseBroadcaster.getInstance().registerListener(packageName);
    }

    private void handleUnregisterListener(Intent intent) {
        String packageName = intent.getStringExtra(EXTRA_PACKAGE_NAME);
        if (packageName == null || packageName.isEmpty()) {
            Log.w(TAG, "⚠️ ACTION_UNREGISTER_LISTENER missing 'packageName' extra");
            return;
        }
        IntentResponseBroadcaster.getInstance().unregisterListener(packageName);
    }
}
