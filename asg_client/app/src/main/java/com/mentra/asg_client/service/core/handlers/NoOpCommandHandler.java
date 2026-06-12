package com.mentra.asg_client.service.core.handlers;

import android.util.Log;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import org.json.JSONObject;
import java.util.Set;

public class NoOpCommandHandler implements ICommandHandler {
    private static final String TAG = "NoOpCommandHandler";
    private final Set<String> types;

    public NoOpCommandHandler(Set<String> types) {
        this.types = types;
    }

    @Override
    public Set<String> getSupportedCommandTypes() { return types; }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        Log.d(TAG, "⏭️ No-op for: " + commandType);
        return true;
    }
}