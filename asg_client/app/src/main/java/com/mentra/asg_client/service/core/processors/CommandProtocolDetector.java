package com.mentra.asg_client.service.core.processors;

import android.util.Log;
import androidx.annotation.NonNull;
import com.mentra.asg_client.io.bluetooth.utils.BleJsonCompact;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Detects and classifies command protocols following SOLID principles.
 *
 * <p>Single Responsibility: Only handles protocol detection and classification Open/Closed:
 * Extensible through protocol strategy pattern Liskov Substitution: All protocol detectors
 * implement the same interface Interface Segregation: Focused interfaces for detection and
 * extraction Dependency Inversion: Depends on abstractions, not concretions
 */
public class CommandProtocolDetector {
    private static final String TAG = "CommandProtocolDetector";

    /** Protocol types that can be detected */
    public enum ProtocolType {
        JSON_COMMAND("JSON Command"),
        K900_PROTOCOL("K900 Protocol"),
        UNKNOWN("Unknown Protocol");

        private final String displayName;

        ProtocolType(String displayName) {
            this.displayName = displayName;
        }

        public String getDisplayName() {
            return displayName;
        }
    }

    /** Protocol detection strategy interface following Interface Segregation Principle */
    public interface ProtocolDetectionStrategy {
        /** Check if this strategy can handle the given JSON */
        boolean canHandle(JSONObject json);

        /** Detect protocol and extract relevant data */
        ProtocolDetectionResult detect(JSONObject json);

        /** Get the protocol type this strategy handles */
        ProtocolType getProtocolType();
    }

    /** Result of protocol detection following Single Responsibility Principle */
    public record ProtocolDetectionResult(
            ProtocolType protocolType,
            JSONObject extractedData,
            String commandType,
            long messageId,
            boolean isValid) {
        public boolean hasMessageId() {
            return messageId != -1;
        }

        @NonNull
        @Override
        public String toString() {
            return String.format(
                    Locale.getDefault(),
                    "ProtocolDetectionResult{type=%s, commandType='%s', messageId=%d, valid=%s}",
                    protocolType.getDisplayName(),
                    commandType,
                    messageId,
                    isValid);
        }
    }

    // Protocol detection strategies following Strategy Pattern
    private final List<ProtocolDetectionStrategy> detectionStrategies;

    public CommandProtocolDetector() {
        this.detectionStrategies = new ArrayList<>();
        initializeDetectionStrategies();
    }

    /** Initialize detection strategies following Open/Closed Principle */
    private void initializeDetectionStrategies() {
        // Order matters - more specific strategies should come first.
        // ChunkedMessageProtocolStrategy needs to be created with a ChunkReassembler
        // (added via addChunkedMessageSupport from CommandProcessor).
        // Vendor-specific strategies (e.g. the Mentra Live MCU wire format) are registered at
        // runtime via addDetectionStrategy by the vendor wiring layer.
        detectionStrategies.add(new JsonCommandProtocolStrategy());
        detectionStrategies.add(new UnknownProtocolStrategy());

        Log.d(
                TAG,
                "✅ Initialized "
                        + detectionStrategies.size()
                        + " base protocol detection strategies");
    }

    /**
     * Add chunked message support with the provided ChunkReassembler This must be called from
     * CommandProcessor after initialization
     */
    public void addChunkedMessageSupport(ChunkReassembler chunkReassembler) {
        // Add at the beginning for priority
        detectionStrategies.add(0, new ChunkedMessageProtocolStrategy(chunkReassembler));
        Log.d(TAG, "✅ Added chunked message protocol support");
    }

    /**
     * Detect the protocol type and extract relevant data
     *
     * @param json The JSON command to analyze
     * @return ProtocolDetectionResult containing protocol type and extracted data
     */
    public ProtocolDetectionResult detectProtocol(JSONObject json) {
        if (json == null) {
            Log.w(TAG, "Received null JSON for protocol detection");
            return new ProtocolDetectionResult(ProtocolType.UNKNOWN, null, "", -1, false);
        }

        try {
            // Find the first strategy that can handle this JSON
            for (ProtocolDetectionStrategy strategy : detectionStrategies) {
                if (strategy.canHandle(json)) {
                    ProtocolDetectionResult result = strategy.detect(json);
                    Log.d(TAG, "🔍 Protocol detected: " + result);
                    return result;
                }
            }

            // Fallback to unknown protocol
            Log.w(TAG, "No strategy could handle the JSON, treating as unknown protocol");
            return new ProtocolDetectionResult(ProtocolType.UNKNOWN, json, "", -1, false);

        } catch (Exception e) {
            Log.e(TAG, "Error during protocol detection", e);
            return new ProtocolDetectionResult(ProtocolType.UNKNOWN, json, "", -1, false);
        }
    }

    /** Add a new detection strategy following Open/Closed Principle */
    public void addDetectionStrategy(ProtocolDetectionStrategy strategy) {
        if (strategy != null) {
            detectionStrategies.add(0, strategy); // Add at beginning for priority`
            Log.d(
                    TAG,
                    "➕ Added new protocol detection strategy: "
                            + strategy.getProtocolType().getDisplayName());
        }
    }

    // ========================================
    // Protocol Detection Strategies
    // ========================================

    /** Strategy for detecting JSON command protocol */
    private static class JsonCommandProtocolStrategy implements ProtocolDetectionStrategy {
        @Override
        public boolean canHandle(JSONObject json) {
            // Can handle if it has a "C" field with valid JSON or is standard JSON format
            if (json.has("C")) {
                String dataPayload = json.optString("C", "");
                try {
                    JSONObject innerJson = new JSONObject(dataPayload);
                    // Reject chunked messages — ChunkedMessageProtocolStrategy handles these.
                    // Without this check, chunks get routed as commands with empty type.
                    String t = innerJson.optString("type", innerJson.optString("t", ""));
                    if ("chunked_msg".equals(t) || "ck".equals(t)) {
                        return false;
                    }
                    return true;
                } catch (JSONException e) {
                    return false; // Invalid JSON in C field, let K900 strategy handle it
                }
            }
            // Standard JSON format (no C field)
            if (json.has("type") || json.has("t") || json.has("mId")) {
                // Also reject direct-format chunks
                String t = json.optString("type", json.optString("t", ""));
                if ("chunked_msg".equals(t) || "ck".equals(t)) {
                    return false;
                }
                return true;
            }
            return false;
        }

        @Override
        public ProtocolDetectionResult detect(JSONObject json) {
            try {
                JSONObject dataToProcess;
                String commandType;
                long messageId;

                if (json.has("C")) {
                    // Extract data from C field
                    String dataPayload = json.optString("C", "");
                    dataToProcess = new JSONObject(dataPayload);
                    Log.d(TAG, "📦 Detected JSON command with C field format");
                } else {
                    // Standard JSON format
                    dataToProcess = json;
                    Log.d(TAG, "📦 Detected standard JSON command format");
                }

                dataToProcess = BleJsonCompact.decodeIfSupported(dataToProcess);
                if (dataToProcess == null) {
                    Log.w(TAG, "Rejected unsupported compact wire form");
                    return new ProtocolDetectionResult(
                            ProtocolType.JSON_COMMAND, json, "", -1, false);
                }
                commandType = dataToProcess.optString("type", "");
                messageId = dataToProcess.optLong("mId", -1);

                return new ProtocolDetectionResult(
                        ProtocolType.JSON_COMMAND, dataToProcess, commandType, messageId, true);

            } catch (JSONException e) {
                Log.e(TAG, "Error parsing JSON command protocol", e);
                return new ProtocolDetectionResult(ProtocolType.JSON_COMMAND, json, "", -1, false);
            }
        }

        @Override
        public ProtocolType getProtocolType() {
            return ProtocolType.JSON_COMMAND;
        }
    }

    /** Strategy for handling unknown protocols */
    private static class UnknownProtocolStrategy implements ProtocolDetectionStrategy {
        @Override
        public boolean canHandle(JSONObject json) {
            // This strategy handles everything that other strategies can't
            return true;
        }

        @Override
        public ProtocolDetectionResult detect(JSONObject json) {
            Log.w(TAG, "📦 Unknown protocol format detected");
            return new ProtocolDetectionResult(ProtocolType.UNKNOWN, json, "", -1, false);
        }

        @Override
        public ProtocolType getProtocolType() {
            return ProtocolType.UNKNOWN;
        }
    }
}
