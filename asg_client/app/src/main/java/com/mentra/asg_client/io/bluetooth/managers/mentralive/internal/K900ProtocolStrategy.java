package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import android.util.Log;
import com.mentra.asg_client.service.core.processors.CommandProtocolDetector;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Mentra Live MCU wire-format detection (invalid JSON in {@code C} field). Used by {@link
 * CommandProtocolDetector} for phone traffic; generic JSON stays in core.
 */
public class K900ProtocolStrategy implements CommandProtocolDetector.ProtocolDetectionStrategy {

    private static final String TAG = "K900ProtocolStrategy";

    @Override
    public boolean canHandle(JSONObject json) {
        if (json.has("C")) {
            String dataPayload = json.optString("C", "");
            try {
                new JSONObject(dataPayload);
                return false;
            } catch (JSONException e) {
                return true;
            }
        }
        return false;
    }

    @Override
    public CommandProtocolDetector.ProtocolDetectionResult detect(JSONObject json) {
        try {
            String command = json.optString("C", "");
            JSONObject bData = json.optJSONObject("B");
            int version = json.optInt("V", 1);

            Log.d(TAG, "Detected K900 protocol format: " + command);

            JSONObject standardizedData = new JSONObject();
            standardizedData.put("type", "k900_" + command);
            standardizedData.put("command", command);
            standardizedData.put("version", version);
            if (bData != null) {
                standardizedData.put("data", bData);
            }

            return new CommandProtocolDetector.ProtocolDetectionResult(
                    CommandProtocolDetector.ProtocolType.K900_PROTOCOL,
                    standardizedData,
                    "k900_" + command,
                    -1,
                    true);
        } catch (JSONException e) {
            Log.e(TAG, "Error parsing K900 protocol", e);
            return new CommandProtocolDetector.ProtocolDetectionResult(
                    CommandProtocolDetector.ProtocolType.K900_PROTOCOL, json, "", -1, false);
        }
    }

    @Override
    public CommandProtocolDetector.ProtocolType getProtocolType() {
        return CommandProtocolDetector.ProtocolType.K900_PROTOCOL;
    }
}
