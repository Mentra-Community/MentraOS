package com.mentra.asg_client.service.core;

import android.util.Log;

import androidx.annotation.NonNull;

import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.bes.BesOtaRegistry;
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
 * Wires core service components (replaces the former {@link ServiceContainer}).
 */
public final class ServiceInitializer {

    private static final String TAG = "ServiceInitializer";

    private final IServiceLifecycle lifecycleManager;
    private final ICommunicationManager communicationManager;
    private final IConfigurationManager configurationManager;
    private final IStateManager stateManager;
    private final IMediaManager streamingManager;
    private final AsgClientServiceManager serviceManager;
    private final CommandProcessor commandProcessor;
    private final AsgNotificationManager notificationManager;
    private final IResponseBuilder responseBuilder;

    public ServiceInitializer(
            @NonNull AsgClientService service,
            @NonNull FileManager fileManager,
            @NonNull OtaHelper otaHelper,
            @NonNull IHardwareManager hardwareManager,
            @NonNull BesOtaRegistry besOtaRegistry) {
        android.content.Context context = service;

        this.communicationManager = new CommunicationManager(null);

        this.serviceManager =
                new AsgClientServiceManager(
                        context, service, communicationManager, fileManager, besOtaRegistry);
        this.notificationManager = new AsgNotificationManager(context);

        ((CommunicationManager) this.communicationManager).setServiceManager(serviceManager);
        this.configurationManager = new ConfigurationManager(context);
        this.stateManager = new StateManager(serviceManager);
        serviceManager.setStateManager(this.stateManager);

        this.streamingManager = new MediaManager(context, serviceManager);

        RgbLedCommandHandler rgbLedHandler = new RgbLedCommandHandler(serviceManager, hardwareManager);
        serviceManager.setRgbLedCommandHandler(rgbLedHandler);

        this.responseBuilder = new ResponseBuilder();
        OtaCommandHandler otaCommandHandler =
                new OtaCommandHandler(otaHelper, communicationManager);
        otaHelper.setPhoneConnectionProvider((CommunicationManager) communicationManager);

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
                        rgbLedHandler,
                        otaCommandHandler);

        this.lifecycleManager =
                new ServiceLifecycleManager(
                        context, serviceManager, commandProcessor, notificationManager);
    }

    public void initialize() {
        Log.d(TAG, "Initializing service graph");
        lifecycleManager.initialize();
        Log.d(TAG, "Service graph initialized");
    }

    public void cleanup() {
        Log.d(TAG, "Cleaning up service graph");
        streamingManager.cleanup();
        lifecycleManager.cleanup();
        Log.d(TAG, "Service graph cleanup completed");
    }

    public IServiceLifecycle getLifecycleManager() {
        return lifecycleManager;
    }

    public ICommunicationManager getCommunicationManager() {
        return communicationManager;
    }

    public IConfigurationManager getConfigurationManager() {
        return configurationManager;
    }

    public IStateManager getStateManager() {
        return stateManager;
    }

    public IMediaManager getStreamingManager() {
        return streamingManager;
    }

    public AsgClientServiceManager getServiceManager() {
        return serviceManager;
    }

    public CommandProcessor getCommandProcessor() {
        return commandProcessor;
    }

    public AsgNotificationManager getNotificationManager() {
        return notificationManager;
    }

    public IResponseBuilder getResponseBuilder() {
        return responseBuilder;
    }
}
