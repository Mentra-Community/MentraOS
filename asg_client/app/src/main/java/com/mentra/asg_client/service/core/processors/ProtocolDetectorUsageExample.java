package com.mentra.asg_client.service.core.processors;

import android.util.Log;
import org.json.JSONObject;

/**
 * Example demonstrating how to use the improved CommandProtocolDetector
 * and how to extend it with new protocol strategies.
 * 
 * This file serves as documentation and example code.
 */
public class ProtocolDetectorUsageExample {
    private static final String TAG = "ProtocolDetectorExample";

    /**
     * Example of basic usage of the CommandProtocolDetector
     */
    public void basicUsageExample() {
        CommandProtocolDetector detector = new CommandProtocolDetector();
        
        try {
            // Example JSON command
            JSONObject jsonCommand = new JSONObject();
            jsonCommand.put("type", "photo_capture");
            jsonCommand.put("mId", 12345);
            jsonCommand.put("quality", "high");
            
            // Detect protocol
            CommandProtocolDetector.ProtocolDetectionResult result = detector.detectProtocol(jsonCommand);
            
            Log.d(TAG, "Protocol detected: " + result.protocolType().getDisplayName());
            Log.d(TAG, "Command type: " + result.commandType());
            Log.d(TAG, "Message ID: " + result.messageId());
            Log.d(TAG, "Is valid: " + result.isValid());
            
        } catch (Exception e) {
            Log.e(TAG, "Error in basic usage example", e);
        }
    }

    /**
     * Example of extending the protocol detector with a custom protocol
     */
    public void customProtocolExample() {
        CommandProtocolDetector detector = new CommandProtocolDetector();
        
        // Add custom protocol strategy
        detector.addDetectionStrategy(new CustomProtocolStrategy());
        
        try {
            // Example custom protocol command
            JSONObject customCommand = new JSONObject();
            customCommand.put("protocol", "custom_v1");
            customCommand.put("action", "custom_action");
            customCommand.put("data", "custom_data");
            
            // Detect protocol
            CommandProtocolDetector.ProtocolDetectionResult result = detector.detectProtocol(customCommand);
            
            Log.d(TAG, "Custom protocol detected: " + result.protocolType().getDisplayName());
            
        } catch (Exception e) {
            Log.e(TAG, "Error in custom protocol example", e);
        }
    }

    /**
     * Example custom protocol strategy implementation
     * This demonstrates how to extend the system with new protocols
     */
    private static class CustomProtocolStrategy implements CommandProtocolDetector.ProtocolDetectionStrategy {
        
        @Override
        public boolean canHandle(JSONObject json) {
            // Check if this is a custom protocol by looking for specific fields
            return json.has("protocol") && "custom_v1".equals(json.optString("protocol"));
        }
        
        @Override
        public CommandProtocolDetector.ProtocolDetectionResult detect(JSONObject json) {
            try {
                String action = json.optString("action", "");
                String data = json.optString("data", "");
                
                Log.d(TAG, "📦 Detected custom protocol: " + action);
                
                // Create standardized data structure
                JSONObject standardizedData = new JSONObject();
                standardizedData.put("type", "custom_" + action);
                standardizedData.put("action", action);
                standardizedData.put("data", data);
                standardizedData.put("protocol_version", "v1");
                
                return new CommandProtocolDetector.ProtocolDetectionResult(
                    CommandProtocolDetector.ProtocolType.JSON_COMMAND, // Use existing type or create new one
                    standardizedData,
                    "custom_" + action,
                    -1, // Custom protocol doesn't use message IDs
                    true
                );
                
            } catch (Exception e) {
                Log.e(TAG, "Error parsing custom protocol", e);
                return new CommandProtocolDetector.ProtocolDetectionResult(
                    CommandProtocolDetector.ProtocolType.UNKNOWN,
                    json,
                    "",
                    -1,
                    false
                );
            }
        }
        
        @Override
        public CommandProtocolDetector.ProtocolType getProtocolType() {
            return CommandProtocolDetector.ProtocolType.JSON_COMMAND; // Or create new type
        }
    }

    /**
     * Example of how to add a new protocol type to the enum
     * (This would require modifying the CommandProtocolDetector class)
     */
    public void newProtocolTypeExample() {
        // To add a new protocol type, you would:
        // 1. Add it to the ProtocolType enum in CommandProtocolDetector
        // 2. Create a strategy for it
        // 3. Register it in the detector
        
        // Example of what the enum addition would look like:
        /*
        public enum ProtocolType {
            JSON_COMMAND("JSON Command"),
            K900_PROTOCOL("K900 Protocol"),
            CUSTOM_PROTOCOL("Custom Protocol"), // New type
            UNKNOWN("Unknown Protocol");
            
            // ... rest of enum implementation
        }
        */
    }
} 