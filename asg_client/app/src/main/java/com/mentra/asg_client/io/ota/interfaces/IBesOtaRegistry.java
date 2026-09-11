package com.mentra.asg_client.io.ota.interfaces;

import androidx.annotation.Nullable;

/**
 * Late-binding registry for the BES OTA controller. The controller is created by the vendor wiring
 * layer only after the companion transport is ready, so consumers must look it up at call time and
 * tolerate a null result (non-K900 devices never set one).
 */
public interface IBesOtaRegistry {

    /**
     * @return the active controller, or null if BES OTA has not been initialized
     */
    @Nullable
    IBesOtaController getInstance();

    /** Publish the active controller after the vendor transport initializes it. */
    void setInstance(IBesOtaController controller);

    /** Remove the active controller (e.g. during service shutdown). */
    void clear();
}
