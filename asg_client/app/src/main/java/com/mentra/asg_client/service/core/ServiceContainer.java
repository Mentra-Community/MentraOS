package com.mentra.asg_client.service.core;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.NonNull;
import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.file.core.FileManagerFactory;
import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.communication.interfaces.IResponseBuilder;
import com.mentra.asg_client.service.communication.managers.CommunicationManager;
import com.mentra.asg_client.service.communication.managers.ResponseBuilder;
import com.mentra.asg_client.service.core.handlers.OtaCommandHandler;
import com.mentra.asg_client.service.core.handlers.RgbLedCommandHandler;
import com.mentra.asg_client.service.core.processors.CommandProcessor;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.media.interfaces.IMediaManager;
import com.mentra.asg_client.service.media.managers.MediaManager;
import com.mentra.asg_client.service.system.interfaces.IConfigurationManager;
import com.mentra.asg_client.service.system.interfaces.IServiceLifecycle;
import com.mentra.asg_client.service.system.interfaces.IStateManager;
import com.mentra.asg_client.service.system.managers.AsgNotificationManager;
import com.mentra.asg_client.service.system.managers.ConfigurationManager;
import com.mentra.asg_client.service.system.managers.ServiceLifecycleManager;
import com.mentra.asg_client.service.system.managers.StateManager;

/**
 * Dependency injection container for service components. Follows Dependency Inversion Principle by
 * managing dependencies through interfaces.
 */
public class ServiceContainer {

    private static final String TAG = "ServiceContainer";
    private static final long OTA_WIRE_RETRY_INTERVAL_MS = 2000;
    private static final int OTA_WIRE_MAX_ATTEMPTS = 15;

    private final Context context;
    private final AsgClientServiceManager serviceManager;
    private final CommandProcessor commandProcessor;
    private final IResponseBuilder responseBuilder;
    private final AsgNotificationManager notificationManager;

    // Interface implementations
    private final IServiceLifecycle lifecycleManager;
    private final ICommunicationManager communicationManager;
    private final IConfigurationManager configurationManager;
    private final IStateManager stateManager;
    private final IMediaManager streamingManager;

    private final FileManager fileManager;

    private boolean phoneControlledOtaWired;
    private Handler otaWireHandler;
    private Runnable otaWireRetryRunnable;
    private int otaWireAttemptCount;

    private final OtaHelper.OnInitializedListener otaInitializedListener =
            helper -> wireUpPhoneControlledOta();

    public ServiceContainer(Context context, @NonNull AsgClientService service) {
        this.context = context;

        this.fileManager = FileManagerFactory.getInstance();

        // Initialize interface implementations first
        this.communicationManager =
                new CommunicationManager(null); // Will be updated after serviceManager creation

        // Initialize core components with service reference
        this.serviceManager =
                new AsgClientServiceManager(context, service, communicationManager, fileManager);
        this.notificationManager = new AsgNotificationManager(context);

        // Update communication manager with service manager reference
        ((CommunicationManager) this.communicationManager).setServiceManager(serviceManager);
        this.configurationManager = new ConfigurationManager(context);
        this.stateManager = new StateManager(serviceManager);

        // Set StateManager in service manager for battery monitoring
        serviceManager.setStateManager(this.stateManager);

        this.streamingManager = new MediaManager(context, serviceManager);

        // Create RGB LED command handler and set reference in service manager
        RgbLedCommandHandler rgbLedHandler = new RgbLedCommandHandler(serviceManager);
        Log.i(
                "ServiceContainer",
                "🚨 Created RGB LED command handler: "
                        + (rgbLedHandler != null ? "✅ SUCCESS" : "❌ FAILED"));
        serviceManager.setRgbLedCommandHandler(rgbLedHandler);
        Log.i(
                "ServiceContainer",
                "🚨 Set RGB LED handler in service manager: "
                        + (serviceManager.getRgbLedCommandHandler() != null
                                ? "✅ SUCCESS"
                                : "❌ FAILED"));

        // Initialize CommandProcessor with interface-based managers
        this.responseBuilder = new ResponseBuilder();
        this.commandProcessor =
                new CommandProcessor(
                        context,
                        communicationManager,
                        stateManager,
                        streamingManager,
                        responseBuilder,
                        configurationManager,
                        serviceManager,
                        fileManager,
                        rgbLedHandler);

        // Initialize lifecycle manager with all components
        this.lifecycleManager =
                new ServiceLifecycleManager(
                        context, serviceManager, commandProcessor, notificationManager);
    }

    /** Get service lifecycle manager */
    public IServiceLifecycle getLifecycleManager() {
        return lifecycleManager;
    }

    /** Get communication manager */
    public ICommunicationManager getCommunicationManager() {
        return communicationManager;
    }

    /** Get configuration manager */
    public IConfigurationManager getConfigurationManager() {
        return configurationManager;
    }

    public IResponseBuilder getResponseBuilder() {
        return responseBuilder;
    }

    /** Get state manager */
    public IStateManager getStateManager() {
        return stateManager;
    }

    /** Get streaming manager */
    public IMediaManager getStreamingManager() {
        return streamingManager;
    }

    /** Get service manager */
    public AsgClientServiceManager getServiceManager() {
        return serviceManager;
    }

    /** Get command processor */
    public CommandProcessor getCommandProcessor() {
        return commandProcessor;
    }

    /** Get notification manager */
    public AsgNotificationManager getNotificationManager() {
        return notificationManager;
    }

    /** Initialize all components */
    public void initialize() {
        Log.d(TAG, "Initializing service container");

        // Initialize lifecycle manager first
        lifecycleManager.initialize();

        phoneControlledOtaWired = false;
        otaWireHandler = new Handler(Looper.getMainLooper());
        OtaHelper.addOnInitializedListener(otaInitializedListener);
        wireUpPhoneControlledOta();
        scheduleOtaWireRetryIfNeeded();

        Log.d(TAG, "Service container initialized successfully");
    }

    /**
     * Wire up phone-controlled OTA connections. Called when OtaHelper becomes available
     * (OtaService) or on bounded retry until wired.
     */
    private void wireUpPhoneControlledOta() {
        Log.d(TAG, "Wiring up phone-controlled OTA...");

        // Always set CommunicationManager on OtaCommandHandler for error reporting
        OtaCommandHandler.setCommunicationManager(communicationManager);
        Log.i(TAG, "✅ CommunicationManager set on OtaCommandHandler");

        OtaHelper otaHelper = OtaHelper.getInstance();
        if (otaHelper != null) {
            otaHelper.setPhoneConnectionProvider((CommunicationManager) communicationManager);
            Log.i(TAG, "✅ PhoneConnectionProvider set on OtaHelper");

            OtaCommandHandler.setOtaHelper(otaHelper);
            Log.i(TAG, "✅ OtaHelper set on OtaCommandHandler");

            phoneControlledOtaWired = true;
            cancelOtaWireRetry();
            OtaHelper.removeOnInitializedListener(otaInitializedListener);
        } else {
            Log.w(TAG, "⚠️ OtaHelper not yet initialized - will retry when OtaService starts");
        }
    }

    private void scheduleOtaWireRetryIfNeeded() {
        if (phoneControlledOtaWired || otaWireHandler == null) {
            return;
        }
        cancelOtaWireRetry();
        otaWireAttemptCount = 0;
        otaWireRetryRunnable =
                new Runnable() {
                    @Override
                    public void run() {
                        if (phoneControlledOtaWired) {
                            return;
                        }
                        wireUpPhoneControlledOta();
                        if (!phoneControlledOtaWired
                                && otaWireAttemptCount++ < OTA_WIRE_MAX_ATTEMPTS) {
                            otaWireHandler.postDelayed(this, OTA_WIRE_RETRY_INTERVAL_MS);
                        } else if (!phoneControlledOtaWired) {
                            Log.e(
                                    TAG,
                                    "Phone-controlled OTA wiring failed after "
                                            + OTA_WIRE_MAX_ATTEMPTS
                                            + " attempts — OtaHelper never became available");
                        }
                    }
                };
        otaWireHandler.postDelayed(otaWireRetryRunnable, OTA_WIRE_RETRY_INTERVAL_MS);
    }

    private void cancelOtaWireRetry() {
        if (otaWireHandler != null && otaWireRetryRunnable != null) {
            otaWireHandler.removeCallbacks(otaWireRetryRunnable);
            otaWireRetryRunnable = null;
        }
    }

    /** Clean up all components */
    public void cleanup() {
        Log.d(TAG, "Cleaning up service container");

        OtaHelper.removeOnInitializedListener(otaInitializedListener);
        cancelOtaWireRetry();
        otaWireHandler = null;

        // Clean up streaming manager first (unregisters callbacks)
        streamingManager.cleanup();

        // Clean up lifecycle manager
        lifecycleManager.cleanup();

        Log.d(TAG, "Service container cleanup completed");
    }
}
