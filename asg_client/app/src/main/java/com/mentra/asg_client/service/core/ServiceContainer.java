package com.mentra.asg_client.service.core;

import android.content.Context;
import android.util.Log;


import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.file.core.FileManagerFactory;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.communication.interfaces.IResponseBuilder;
import com.mentra.asg_client.service.communication.managers.CommunicationManager;
import com.mentra.asg_client.service.communication.managers.ResponseBuilder;
import com.mentra.asg_client.service.core.processors.CommandProcessor;
import com.mentra.asg_client.service.core.handlers.RgbLedCommandHandler;
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
import com.mentra.asg_client.service.gallery.BackgroundGallerySyncManager;
import com.mentra.asg_client.service.gallery.CloudGalleryUploader;
import com.mentra.asg_client.service.gallery.GalleryUploadQueue;


/**
 * Dependency injection container for service components.
 * Follows Dependency Inversion Principle by managing dependencies through interfaces.
 */
public class ServiceContainer {

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
    
    // Gallery cloud sync components
    private BackgroundGallerySyncManager backgroundSyncManager;
    private CloudGalleryUploader cloudGalleryUploader;
    private GalleryUploadQueue galleryUploadQueue;

    public ServiceContainer(Context context, AsgClientService service) {
        this.context = context;

        this.fileManager = FileManagerFactory.getInstance();

        // Initialize interface implementations first
        this.communicationManager = new CommunicationManager(null); // Will be updated after serviceManager creation

        // Initialize core components with service reference
        this.serviceManager = new AsgClientServiceManager(context, service, communicationManager, fileManager);
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
        Log.i("ServiceContainer", "🚨 Created RGB LED command handler: " + (rgbLedHandler != null ? "✅ SUCCESS" : "❌ FAILED"));
        serviceManager.setRgbLedCommandHandler(rgbLedHandler);
        Log.i("ServiceContainer", "🚨 Set RGB LED handler in service manager: " + (serviceManager.getRgbLedCommandHandler() != null ? "✅ SUCCESS" : "❌ FAILED"));

        // Initialize CommandProcessor with interface-based managers
        this.responseBuilder = new ResponseBuilder();
        this.commandProcessor = new CommandProcessor(context,
                communicationManager,
                stateManager,
                streamingManager,
                responseBuilder,
                configurationManager,
                serviceManager,
                fileManager,
                rgbLedHandler);

        // Initialize lifecycle manager with all components
        this.lifecycleManager = new ServiceLifecycleManager(context, serviceManager, commandProcessor, notificationManager);
        
        // Initialize gallery cloud sync components
        Log.i("ServiceContainer", "☁️ Initializing gallery cloud sync components");
        this.galleryUploadQueue = new GalleryUploadQueue(context, fileManager);
        this.cloudGalleryUploader = new CloudGalleryUploader(context, fileManager, galleryUploadQueue);
        this.backgroundSyncManager = new BackgroundGallerySyncManager(context, stateManager, cloudGalleryUploader);
        Log.i("ServiceContainer", "✅ Gallery cloud sync components initialized");
    }

    /**
     * Get service lifecycle manager
     */
    public IServiceLifecycle getLifecycleManager() {
        return lifecycleManager;
    }

    /**
     * Get communication manager
     */
    public ICommunicationManager getCommunicationManager() {
        return communicationManager;
    }

    /**
     * Get configuration manager
     */
    public IConfigurationManager getConfigurationManager() {
        return configurationManager;
    }

    public IResponseBuilder getResponseBuilder() {
        return responseBuilder;
    }

    /**
     * Get state manager
     */
    public IStateManager getStateManager() {
        return stateManager;
    }

    /**
     * Get streaming manager
     */
    public IMediaManager getStreamingManager() {
        return streamingManager;
    }

    /**
     * Get service manager
     */
    public AsgClientServiceManager getServiceManager() {
        return serviceManager;
    }

    /**
     * Get command processor
     */
    public CommandProcessor getCommandProcessor() {
        return commandProcessor;
    }

    /**
     * Get notification manager
     */
    public AsgNotificationManager getNotificationManager() {
        return notificationManager;
    }

    /**
     * Get background sync manager
     */
    public BackgroundGallerySyncManager getBackgroundSyncManager() {
        return backgroundSyncManager;
    }
    
    /**
     * Get cloud gallery uploader
     */
    public CloudGalleryUploader getCloudGalleryUploader() {
        return cloudGalleryUploader;
    }
    
    /**
     * Get gallery upload queue
     */
    public GalleryUploadQueue getGalleryUploadQueue() {
        return galleryUploadQueue;
    }

    /**
     * Initialize all components
     */
    public void initialize() {
        Log.d("ServiceContainer", "Initializing service container");

        // Initialize lifecycle manager first
        lifecycleManager.initialize();

        Log.d("ServiceContainer", "Service container initialized successfully");
    }

    /**
     * Clean up all components
     */
    public void cleanup() {
        Log.d("ServiceContainer", "Cleaning up service container");
        
        // Clean up gallery sync manager
        if (backgroundSyncManager != null) {
            backgroundSyncManager.stopMonitoring();
        }

        // Clean up streaming manager first (unregisters callbacks)
        streamingManager.cleanup();

        // Clean up lifecycle manager
        lifecycleManager.cleanup();

        Log.d("ServiceContainer", "Service container cleanup completed");
    }
}