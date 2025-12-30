package com.mentra.asg_client.service.core.processors;

import android.content.Context;
import android.util.Log;

import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.service.core.handlers.K900CommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.core.handlers.OtaCommandHandler;
import com.mentra.asg_client.service.core.handlers.SettingsCommandHandler;
import com.mentra.asg_client.service.core.handlers.VersionCommandHandler;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.service.media.interfaces.IMediaManager;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.communication.interfaces.IResponseBuilder;
import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;
import com.mentra.asg_client.service.core.handlers.PhotoCommandHandler;
import com.mentra.asg_client.service.core.handlers.VideoCommandHandler;
import com.mentra.asg_client.service.core.handlers.PhoneReadyCommandHandler;
import com.mentra.asg_client.service.core.handlers.AuthTokenCommandHandler;
import com.mentra.asg_client.service.core.handlers.PingCommandHandler;
import com.mentra.asg_client.service.core.handlers.RtmpCommandHandler;
import com.mentra.asg_client.service.core.handlers.WifiCommandHandler;
import com.mentra.asg_client.service.core.handlers.BatteryCommandHandler;
import com.mentra.asg_client.service.core.handlers.ImuCommandHandler;
import com.mentra.asg_client.service.core.handlers.GalleryCommandHandler;
import com.mentra.asg_client.service.core.handlers.RgbLedCommandHandler;

import org.json.JSONObject;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * CommandProcessor - Orchestrates command processing following SOLID principles.
 * <p>
 * Single Responsibility: Coordinates command routing and delegation
 * Open/Closed: Extensible through handler registration and protocol parsers
 * Liskov Substitution: Uses interface-based handlers and parsers
 * Interface Segregation: Focused interfaces for each concern
 * Dependency Inversion: Depends on abstractions, not concretions
 */
public class CommandProcessor {
    private static final String TAG = "CommandProcessor";
    
    // Duplicate detection
    private static final long DUPLICATE_WINDOW_MS = TimeUnit.SECONDS.toMillis(10);
    private final ConcurrentHashMap<Long, Long> processedMessageIds = new ConcurrentHashMap<>();

    // Core dependencies (Dependency Inversion Principle)
    private final Context context;
    private final ICommunicationManager communicationManager;
    private final IStateManager stateManager;
    private final IMediaManager streamingManager;
    private final IResponseBuilder responseBuilder;
    private final IConfigurationManager configurationManager;
    private final AsgClientServiceManager serviceManager;
    private final FileManager fileManager;

    // Command processing components
    private final CommandHandlerRegistry commandHandlerRegistry;
    private final CommandParser commandParser;
    private final CommandProtocolDetector protocolDetector;
    private final K900CommandHandler k900CommandHandler;
    private final ResponseSender responseSender;
    private final ChunkReassembler chunkReassembler;
    private final RgbLedCommandHandler rgbLedCommandHandler;

    public CommandProcessor(Context context, ICommunicationManager communicationManager, IStateManager stateManager, IMediaManager streamingManager, IResponseBuilder responseBuilder, IConfigurationManager configurationManager, AsgClientServiceManager serviceManager, FileManager fileManager, RgbLedCommandHandler rgbLedCommandHandler) {
        Log.d(TAG, "🔧 Initializing CommandProcessor with dependencies");
        this.context = context;
        this.communicationManager = communicationManager;
        this.stateManager = stateManager;
        this.streamingManager = streamingManager;
        this.responseBuilder = responseBuilder;
        this.configurationManager = configurationManager;
        this.serviceManager = serviceManager;
        this.fileManager = fileManager;
        this.rgbLedCommandHandler = rgbLedCommandHandler;

        // Initialize components (Single Responsibility Principle)
        Log.d(TAG, "📦 Creating command processing components");
        this.commandHandlerRegistry = new CommandHandlerRegistry();
        this.commandParser = new CommandParser();
        this.protocolDetector = new CommandProtocolDetector();
        this.k900CommandHandler = new K900CommandHandler(serviceManager, stateManager, communicationManager);
        this.responseSender = new ResponseSender(serviceManager);
        this.chunkReassembler = new ChunkReassembler();
        
        // Add chunked message support to protocol detector
        this.protocolDetector.addChunkedMessageSupport(chunkReassembler);
        Log.d(TAG, "✅ Chunked message support initialized");
        
        // Wire K900CommandHandler to BesOtaManager for authorization requests
        com.mentra.asg_client.io.bes.BesOtaManager.setK900CommandHandler(this.k900CommandHandler);
        Log.d(TAG, "✅ K900CommandHandler wired to BesOtaManager");

        // Register command handlers
        initializeCommandHandlers();
        Log.i(TAG, "✅ CommandProcessor initialization completed successfully");
    }

    /**
     * Main entry point for processing commands from byte data.
     * Follows Single Responsibility Principle by delegating to specialized components.
     */
    public void processCommand(byte[] data) {
        // Suppress verbose logging to prevent logcat overflow

        if (data == null || data.length == 0) {
            Log.w(TAG, "⚠️ Received null or empty data - skipping processing");
            return;
        }

        try {
            // Parsing JSON from byte data
            // Parse JSON from byte data
            JSONObject jsonObject = commandParser.parseToJson(data);
            if (jsonObject == null) {
                Log.w(TAG, "❌ Failed to parse JSON from byte data");
                return;
            }

            // Successfully parsed JSON
            // Process the parsed JSON command
            processJsonCommand(jsonObject);
        } catch (Exception e) {
            Log.e(TAG, "💥 Error processing command from byte data", e);
        }

        // processCommand() completed
    }

    /**
     * Process JSON command by delegating to appropriate handlers.
     * Follows Open/Closed Principle by using registry pattern.
     */
    private void processJsonCommand(JSONObject json) {
        // processJsonCommand() started

        Log.d(TAG, "📊 processJsonCommand() started" + json.toString());
        try {
            // Check for ACK first (from phone acknowledging our sent messages)
            String type = json.optString("type", "");
            if ("msg_ack".equals(type)) {
                long messageId = json.optLong("mId", -1);
                if (messageId != -1) {
                    // Handle ACK for our sent message
                    responseSender.getReliableManager().handleAck(messageId);
                    Log.d(TAG, "✅ Received ACK for message: " + messageId);
                    return; // Don't process ACKs further
                }
            }

            // Extract command data
            // Extracting command data from JSON
            CommandData commandData = extractCommandData(json);
            if (commandData == null) {
                Log.w(TAG, "⚠️ No command data extracted - processing complete" + json.toString());
                return;
            }

            Log.d(TAG, "📊 Command data extracted - Type: " + commandData.type() + ", MessageID: " + commandData.messageId() + ", Data: " + commandData.data());

            // Check for duplicate message ID
            if (isDuplicateMessage(commandData.messageId())) {
                Log.i(TAG, "🔄 Duplicate message detected (ID: " + commandData.messageId() + "), sending ACK but skipping processing");
                // Still send ACK so phone stops retrying
                sendAcknowledgment(commandData);
                return;
            }

            // Send acknowledgment if required
            sendAcknowledgment(commandData);

            // Route to appropriate handler
            routeCommand(commandData);
        } catch (Exception e) {
            Log.e(TAG, "💥 Error processing JSON command", e);
        }

        // processJsonCommand() completed
    }

    /**
     * Extract and validate command data from JSON using improved protocol detector.
     */
    private CommandData extractCommandData(JSONObject json) {
        // extractCommandData() started

        try {
            // Use protocol detector to identify and extract command data
            // Detecting protocol type
            CommandProtocolDetector.ProtocolDetectionResult result = protocolDetector.detectProtocol(json);

            // Protocol detection result

            if (!result.isValid()) {
                Log.w(TAG, "❌ Invalid protocol detected: " + result.protocolType().getDisplayName());
                return null;
            }

            switch (result.protocolType()) {
                case K900_PROTOCOL:
                    Log.i(TAG, "🎯 Processing K900 protocol command");
                    // Handle K900 format using dedicated handler
                    k900CommandHandler.processK900Command(json);
                    // K900 command processed successfully
                    return null; // K900 commands are handled directly

                case JSON_COMMAND:
                    Log.i(TAG, "📋 Processing standard JSON command");
                    // Standard JSON command processing
                    CommandData commandData = new CommandData(result.commandType(), result.extractedData(), result.messageId());
                    // Command data created successfully
                    return commandData;

                case UNKNOWN:
                default:
                    Log.w(TAG, "❓ Unknown protocol type: " + result.protocolType().getDisplayName());
                    return null;
            }
        } catch (Exception e) {
            Log.e(TAG, "💥 Error extracting command data", e);
            return null;
        }
    }

    /**
     * Send acknowledgment for commands with message IDs.
     */
    private void sendAcknowledgment(CommandData commandData) {
        Log.d(TAG, "📤 sendAcknowledgment() called");

        if (commandData != null && commandData.messageId() != -1) {
            Log.d(TAG, "📨 Sending ACK for message ID: " + commandData.messageId());
            communicationManager.sendAckResponse(commandData.messageId());
            Log.d(TAG, "✅ ACK sent successfully for message ID: " + commandData.messageId());
        } else {
            Log.d(TAG, "⏭️ Skipping ACK - no message ID or null command data");
        }
    }

    /**
     * Route command to appropriate handler using registry pattern.
     * Follows Open/Closed Principle - new handlers can be added without modifying this method.
     */
    private void routeCommand(CommandData commandData) {
        Log.d(TAG, "🛣️ routeCommand() started");

        if (commandData == null) {
            Log.d(TAG, "⏭️ Skipping routing - null command data (likely K900 command)");
            return; // K900 commands are handled separately in extractCommandData
        }

        String type = commandData.type();
        Log.i(TAG, "🎯 Routing command type: " + type);

        // Try modern command handler first
        Log.d(TAG, "🔍 Looking up handler for command type: " + type);
        ICommandHandler handler = commandHandlerRegistry.getHandlerByCommandType(type);
        if (handler != null) {
            Log.d(TAG, "✅ Found modern handler: " + handler.getClass().getSimpleName());
            boolean success = handler.handleCommand(type, commandData.data());
            if (success) {
                Log.i(TAG, "✅ Command handled successfully by modern handler: " + type);
            } else {
                Log.w(TAG, "⚠️ Modern handler failed to process command: " + type);
            }
            return;
        }

        // Fall back to legacy processor
        String error = "❌ No handler found for command" + type + ", Implement the handler, or register command type for specific handler";
        Log.e(TAG, error);
        throw new IllegalStateException(error);

    }

    /**
     * Initialize command handlers following Open/Closed Principle.
     * New handlers can be added here without modifying existing code.
     */
    private void initializeCommandHandlers() {
        Log.d(TAG, "🔧 initializeCommandHandlers() started");

        try {
            Log.d(TAG, "📝 Registering command handlers...");

            commandHandlerRegistry.registerHandler(new PhoneReadyCommandHandler(communicationManager, stateManager, responseBuilder, serviceManager));
            Log.d(TAG, "✅ Registered PhoneReadyCommandHandler");

            commandHandlerRegistry.registerHandler(new AuthTokenCommandHandler(communicationManager, configurationManager));
            Log.d(TAG, "✅ Registered AuthTokenCommandHandler");

            commandHandlerRegistry.registerHandler(new PhotoCommandHandler(context, serviceManager, fileManager, stateManager));
            Log.d(TAG, "✅ Registered PhotoCommandHandler");

            commandHandlerRegistry.registerHandler(new VideoCommandHandler(context, serviceManager, streamingManager, fileManager, stateManager));
            Log.d(TAG, "✅ Registered VideoCommandHandler");

            commandHandlerRegistry.registerHandler(new PingCommandHandler(communicationManager, responseBuilder, serviceManager));
            Log.d(TAG, "✅ Registered PingCommandHandler");

            commandHandlerRegistry.registerHandler(new RtmpCommandHandler(context, stateManager, streamingManager));
            Log.d(TAG, "✅ Registered RtmpCommandHandler");

            commandHandlerRegistry.registerHandler(new WifiCommandHandler(serviceManager, communicationManager, stateManager));
            Log.d(TAG, "✅ Registered WifiCommandHandler");

            commandHandlerRegistry.registerHandler(new BatteryCommandHandler(stateManager));
            Log.d(TAG, "✅ Registered BatteryCommandHandler");

            commandHandlerRegistry.registerHandler(new VersionCommandHandler(serviceManager));
            Log.d(TAG, "✅ Registered VersionCommandHandler");

            commandHandlerRegistry.registerHandler(new SettingsCommandHandler(serviceManager, communicationManager, responseBuilder));
            Log.d(TAG, "✅ Registered SettingsCommandHandler");

            commandHandlerRegistry.registerHandler(new OtaCommandHandler());
            Log.d(TAG, "✅ Registered OtaCommandHandler");

            commandHandlerRegistry.registerHandler(new ImuCommandHandler(context, responseSender));
            Log.d(TAG, "✅ Registered ImuCommandHandler");
            
            commandHandlerRegistry.registerHandler(new GalleryCommandHandler(serviceManager, communicationManager));
            Log.d(TAG, "✅ Registered GalleryCommandHandler");

            commandHandlerRegistry.registerHandler(new com.mentra.asg_client.service.core.handlers.TransferCompleteCommandHandler(serviceManager));
            Log.d(TAG, "✅ Registered TransferCompleteCommandHandler");

            commandHandlerRegistry.registerHandler(rgbLedCommandHandler);
            Log.d(TAG, "✅ Registered RgbLedCommandHandler");

            commandHandlerRegistry.registerHandler(new com.mentra.asg_client.service.core.handlers.GalleryModeCommandHandler(serviceManager));
            Log.d(TAG, "✅ Registered GalleryModeCommandHandler");

            commandHandlerRegistry.registerHandler(new com.mentra.asg_client.service.core.handlers.ServiceHeartbeatCommandHandler(serviceManager));
            Log.d(TAG, "✅ Registered ServiceHeartbeatCommandHandler");

            Log.i(TAG, "✅ Successfully registered " + commandHandlerRegistry.getHandlerCount() + " command handlers");

        } catch (Exception e) {
            Log.e(TAG, "💥 Error during command handler initialization", e);
        }
    }


    // ========================================
    // Public API Methods (Interface Segregation)
    // ========================================

    /**
     * Send download progress notification.
     */
    public void sendDownloadProgressOverBle(String status, int progress, long bytesDownloaded, long totalBytes, String errorMessage, long timestamp) {
        Log.d(TAG, "📤 sendDownloadProgressOverBle() called - Status: " + status + ", Progress: " + progress + "%, Downloaded: " + bytesDownloaded + "/" + totalBytes + " bytes");

        try {
            responseSender.sendDownloadProgress(status, progress, bytesDownloaded, totalBytes, errorMessage, timestamp);
            Log.d(TAG, "✅ Download progress sent successfully");
        } catch (Exception e) {
            Log.e(TAG, "💥 Error sending download progress", e);
        }
    }

    /**
     * Send installation progress notification.
     */
    public void sendInstallationProgressOverBle(String status, String apkPath, String errorMessage, long timestamp) {
        Log.d(TAG, "📤 sendInstallationProgressOverBle() called - Status: " + status + ", APK Path: " + apkPath + ", Error: " + errorMessage);

        try {
            responseSender.sendInstallationProgress(status, apkPath, errorMessage, timestamp);
            Log.d(TAG, "✅ Installation progress sent successfully");
        } catch (Exception e) {
            Log.e(TAG, "💥 Error sending installation progress", e);
        }
    }

    /**
     * Send MTK firmware update complete notification over BLE
     */
    public void sendMtkUpdateComplete() {
        Log.d(TAG, "📤 sendMtkUpdateComplete() called");

        try {
            responseSender.sendMtkUpdateComplete();
            Log.d(TAG, "✅ MTK update complete sent successfully");
        } catch (Exception e) {
            Log.e(TAG, "💥 Error sending MTK update complete", e);
        }
    }

    /**
     * Send report swipe status.
     */
    public void sendReportSwipe(boolean report) {
        Log.d(TAG, "📤 sendReportSwipe() called - Report: " + report);

        try {
            responseSender.sendReportSwipe(report);
            Log.d(TAG, "✅ Report swipe status sent successfully");
        } catch (Exception e) {
            Log.e(TAG, "💥 Error sending report swipe status", e);
        }
    }

    /**
     * Request BT MAC address from BES chip.
     * This should be called after UART connection is established to retrieve the unique device identifier.
     */
    public void requestBtMacAddress() {
        Log.d(TAG, "📤 requestBtMacAddress() called");

        if (k900CommandHandler != null) {
            k900CommandHandler.requestBtMacAddress();
        } else {
            Log.w(TAG, "⚠️ K900CommandHandler not available - cannot request BT MAC address");
        }
    }

    /**
     * Check if a message ID has been recently processed (duplicate detection).
     * Also cleans up old entries to prevent memory growth.
     */
    private boolean isDuplicateMessage(long messageId) {
        if (messageId == -1) {
            // No message ID, can't track duplicates
            return false;
        }

        long now = System.currentTimeMillis();
        
        // Clean up old entries periodically (entries older than duplicate window)
        processedMessageIds.entrySet().removeIf(entry -> 
            now - entry.getValue() > DUPLICATE_WINDOW_MS
        );

        // Check if we've seen this message ID recently
        Long previousTime = processedMessageIds.put(messageId, now);
        
        if (previousTime != null && (now - previousTime) < DUPLICATE_WINDOW_MS) {
            // We've seen this message ID within the duplicate window
            return true;
        }
        
        return false;
    }
} 