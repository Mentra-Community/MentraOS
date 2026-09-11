package com.mentra.asg_client.io.bes;

import androidx.annotation.Nullable;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaController;
import com.mentra.asg_client.io.ota.interfaces.IBesOtaRegistry;
import javax.inject.Inject;
import javax.inject.Singleton;

/** Holds the live {@link IBesOtaController} after K900 UART transport is ready. */
@Singleton
public class BesOtaRegistry implements IBesOtaRegistry {

    private volatile IBesOtaController instance;

    @Inject
    public BesOtaRegistry() {}

    @Override
    public void setInstance(IBesOtaController controller) {
        this.instance = controller;
    }

    @Override
    public void clear() {
        this.instance = null;
    }

    @Override
    @Nullable
    public IBesOtaController getInstance() {
        return instance;
    }
}
