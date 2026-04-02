package com.mentra.asg_client.receiver;

import android.content.Context;
import android.content.Intent;
import android.util.Log;

import org.json.JSONObject;

import java.util.concurrent.CopyOnWriteArraySet;

/**
 * Singleton that manages registered third-party listener packages and broadcasts
 * command responses to them via explicit intents.
 *
 * Third-party apps register by sending ACTION_REGISTER_LISTENER with their package name.
 * Responses are delivered as ACTION_COMMAND_RESPONSE with a "json" String extra.
 */
public class IntentResponseBroadcaster {
    private static final String TAG = "IntentResponseBroadcaster";

    private static volatile IntentResponseBroadcaster instance;

    private final CopyOnWriteArraySet<String> registeredPackages = new CopyOnWriteArraySet<>();

    private IntentResponseBroadcaster() {
    }

    public static IntentResponseBroadcaster getInstance() {
        if (instance == null) {
            synchronized (IntentResponseBroadcaster.class) {
                if (instance == null) {
                    instance = new IntentResponseBroadcaster();
                }
            }
        }
        return instance;
    }

    /**
     * Register a package to receive command responses.
     */
    public void registerListener(String packageName) {
        if (packageName == null || packageName.isEmpty()) {
            Log.w(TAG, "⚠️ Cannot register null/empty package name");
            return;
        }
        registeredPackages.add(packageName);
        Log.i(TAG, "✅ Registered listener: " + packageName + " (total: " + registeredPackages.size() + ")");
    }

    /**
     * Unregister a package from receiving command responses.
     */
    public void unregisterListener(String packageName) {
        if (packageName == null || packageName.isEmpty()) {
            Log.w(TAG, "⚠️ Cannot unregister null/empty package name");
            return;
        }
        boolean removed = registeredPackages.remove(packageName);
        if (removed) {
            Log.i(TAG, "✅ Unregistered listener: " + packageName + " (total: " + registeredPackages.size() + ")");
        } else {
            Log.w(TAG, "⚠️ Package was not registered: " + packageName);
        }
    }

    /**
     * Broadcast a JSON response to all registered listener packages.
     * Each listener receives an explicit intent with action ACTION_COMMAND_RESPONSE
     * and a "json" String extra containing the serialized response.
     */
    public void broadcastResponse(Context context, JSONObject response) {
        if (registeredPackages.isEmpty()) {
            return;
        }

        if (context == null || response == null) {
            Log.w(TAG, "⚠️ Cannot broadcast - null context or response");
            return;
        }

        String jsonString = response.toString();
        Log.d(TAG, "📤 Broadcasting response to " + registeredPackages.size() + " listener(s)");

        for (String packageName : registeredPackages) {
            try {
                Intent intent = new Intent(IntentCommandReceiver.ACTION_COMMAND_RESPONSE);
                intent.setPackage(packageName);
                intent.putExtra(IntentCommandReceiver.EXTRA_JSON, jsonString);
                context.sendBroadcast(intent);
                Log.d(TAG, "📤 Sent response to: " + packageName);
            } catch (Exception e) {
                Log.e(TAG, "💥 Failed to broadcast to " + packageName, e);
            }
        }
    }

    /**
     * Get the number of registered listeners (for diagnostics).
     */
    public int getListenerCount() {
        return registeredPackages.size();
    }
}
