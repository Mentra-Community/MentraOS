package com.mentra.asg_client.service.core.handlers.subscribers;

import android.util.Log;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaController;
import com.mentra.asg_client.io.peripheral.IPeripheralBus;
import com.mentra.asg_client.io.peripheral.events.BesOtaAuthEvent;
import com.mentra.asg_client.io.peripheral.events.McuEvent;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;

/**
 * Reacts to {@link BesOtaAuthEvent}s by forwarding the authorization result to the {@link
 * IBesOtaController}. Moved verbatim from {@code
 * K900CommandHandler.handleBesOtaAuthorizationResponse}.
 *
 * <p>The {@link IBesOtaController} is fetched lazily from {@link AsgClientServiceManager} at event
 * time because it is created later in the service lifecycle (during {@code
 * initializeBluetoothManager}), after subscribers are wired.
 */
public final class BesOtaAuthEventSubscriber implements IPeripheralBus.McuEventListener {

    private static final String TAG = "BesOtaAuthEventSubscriber";

    private final AsgClientServiceManager serviceManager;

    public BesOtaAuthEventSubscriber(AsgClientServiceManager serviceManager) {
        this.serviceManager = serviceManager;
    }

    @Override
    public void onMcuEvent(McuEvent event) {
        if (!(event instanceof BesOtaAuthEvent)) {
            return;
        }
        boolean authorized = ((BesOtaAuthEvent) event).isAuthorized();

        Log.i(TAG, "🔧 Received BES OTA authorization response");
        Log.d(TAG, "🔧 BES OTA authorization: " + (authorized ? "GRANTED" : "DENIED"));

        // Notify the BES OTA controller of the authorization result
        IBesOtaController controller =
                serviceManager != null ? serviceManager.getBesOtaManager() : null;
        if (controller != null) {
            if (authorized) {
                controller.onAuthorizationGranted();
            } else {
                controller.onAuthorizationDenied();
            }
        } else {
            Log.e(
                    TAG,
                    "❌ BES OTA controller not available - cannot process authorization response");
        }
    }
}
