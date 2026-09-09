package com.mentra.asg_client.service.core;

import android.util.Log;
import androidx.annotation.NonNull;
import com.mentra.asg_client.io.bluetooth.interfaces.ICompanionTransport;
import com.mentra.asg_client.io.file.core.FileManager;
import com.mentra.asg_client.io.hardware.interfaces.IHardwareManager;
import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.io.peripheral.SimplePeripheralBus;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.communication.interfaces.IResponseBuilder;
import com.mentra.asg_client.service.communication.managers.CommunicationManager;
import com.mentra.asg_client.service.communication.managers.ResponseBuilder;
import com.mentra.asg_client.service.core.handlers.OtaCommandHandler;
import com.mentra.asg_client.service.core.handlers.RgbLedCommandHandler;
import com.mentra.asg_client.service.core.handlers.subscribers.BatteryEventSubscriber;
import com.mentra.asg_client.service.core.handlers.subscribers.BesOtaAuthEventSubscriber;
import com.mentra.asg_client.service.core.handlers.subscribers.BesVersionEventSubscriber;
import com.mentra.asg_client.service.core.handlers.subscribers.BtMacEventSubscriber;
import com.mentra.asg_client.service.core.handlers.subscribers.ButtonEventSubscriber;
import com.mentra.asg_client.service.core.handlers.subscribers.FactoryResetEventSubscriber;
import com.mentra.asg_client.service.core.handlers.subscribers.FileTransferAckEventSubscriber;
import com.mentra.asg_client.service.core.handlers.subscribers.HotspotEventSubscriber;
import com.mentra.asg_client.service.core.handlers.subscribers.PairingAudioEventSubscriber;
import com.mentra.asg_client.service.core.handlers.subscribers.ShutdownEventSubscriber;
import com.mentra.asg_client.service.core.handlers.subscribers.SwipeVolumeEventSubscriber;
import com.mentra.asg_client.service.core.handlers.subscribers.SwitchEventSubscriber;
import com.mentra.asg_client.service.core.handlers.subscribers.TouchEventSubscriber;
import com.mentra.asg_client.service.core.handlers.subscribers.VoiceActivityEventSubscriber;
import com.mentra.asg_client.service.core.processors.CommandProcessor;
import com.mentra.asg_client.service.core.processors.CommandProtocolDetector;
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
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** Wires core service components (replaces the former {@link ServiceContainer}). */
public final class ServiceInitializer {

    private static final String TAG = "ServiceInitializer";
    private static final long BATTERY_ANNOUNCEMENT_SHUTDOWN_TIMEOUT_MS = 1000;

    private final IServiceLifecycle lifecycleManager;
    private final ICommunicationManager communicationManager;
    private final IConfigurationManager configurationManager;
    private final IStateManager stateManager;
    private final IMediaManager streamingManager;
    private final AsgClientServiceManager serviceManager;
    private final CommandProcessor commandProcessor;
    private final AsgNotificationManager notificationManager;
    private final IResponseBuilder responseBuilder;
    private final ExecutorService batteryAnnouncementExecutor;

    public ServiceInitializer(
            @NonNull AsgClientService service,
            @NonNull ICompanionTransport transport,
            @NonNull INetworkManager network,
            @NonNull FileManager fileManager,
            @NonNull OtaHelper otaHelper,
            @NonNull IHardwareManager hardwareManager,
            @NonNull IBesOtaRegistry besOtaRegistry,
            @NonNull Set<CommandProtocolDetector.ProtocolDetectionStrategy> protocolStrategies) {
        android.content.Context context = service;

        // Transport and network are constructed by the vendor wiring layer and passed in — both
        // go to CommunicationManager and AsgClientServiceManager so neither holds a circular
        // reference to the other.
        this.communicationManager = new CommunicationManager(transport, network);

        this.serviceManager =
                new AsgClientServiceManager(
                        context, service, communicationManager, fileManager, besOtaRegistry,
                        transport, network);
        this.notificationManager = new AsgNotificationManager(context);
        this.configurationManager = new ConfigurationManager(context);
        this.stateManager = new StateManager(serviceManager);
        serviceManager.setStateManager(this.stateManager);

        this.streamingManager = new MediaManager(context, serviceManager);
        this.batteryAnnouncementExecutor =
                Executors.newSingleThreadExecutor(
                        runnable -> new Thread(runnable, "battery-announcement"));

        RgbLedCommandHandler rgbLedHandler =
                new RgbLedCommandHandler(serviceManager, hardwareManager);
        serviceManager.setRgbLedCommandHandler(rgbLedHandler);

        this.responseBuilder = new ResponseBuilder();
        OtaCommandHandler otaCommandHandler =
                new OtaCommandHandler(otaHelper, communicationManager);
        otaHelper.setPhoneConnectionProvider((CommunicationManager) communicationManager);

        // Create the peripheral event bus and register all MCU event subscribers. Inbound BES/MCU
        // commands are parsed into typed events by K900CommandHandler and dispatched here.
        IPeripheralBus peripheralBus = new SimplePeripheralBus();
        peripheralBus.subscribe(
                new BatteryEventSubscriber(hardwareManager, stateManager, serviceManager));
        peripheralBus.subscribe(new PairingAudioEventSubscriber(context, hardwareManager));
        peripheralBus.subscribe(
                new ButtonEventSubscriber(
                        serviceManager,
                        hardwareManager,
                        stateManager,
                        batteryAnnouncementExecutor));
        peripheralBus.subscribe(new ShutdownEventSubscriber(serviceManager, context));
        peripheralBus.subscribe(new FactoryResetEventSubscriber(serviceManager, context, otaHelper));
        peripheralBus.subscribe(new BesVersionEventSubscriber(serviceManager));
        peripheralBus.subscribe(new BtMacEventSubscriber(serviceManager));
        peripheralBus.subscribe(new BesOtaAuthEventSubscriber(serviceManager));
        peripheralBus.subscribe(new HotspotEventSubscriber(serviceManager));
        peripheralBus.subscribe(new FileTransferAckEventSubscriber(serviceManager));
        peripheralBus.subscribe(new TouchEventSubscriber(serviceManager));
        peripheralBus.subscribe(new SwitchEventSubscriber(serviceManager));
        peripheralBus.subscribe(new SwipeVolumeEventSubscriber(serviceManager));
        peripheralBus.subscribe(new VoiceActivityEventSubscriber());

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
                        otaCommandHandler,
                        peripheralBus,
                        protocolStrategies);

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
        batteryAnnouncementExecutor.shutdownNow();
        try {
            if (!batteryAnnouncementExecutor.awaitTermination(
                    BATTERY_ANNOUNCEMENT_SHUTDOWN_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                Log.w(TAG, "Battery announcement worker did not stop before service teardown");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            Log.w(TAG, "Interrupted while stopping battery announcement worker");
        }
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
