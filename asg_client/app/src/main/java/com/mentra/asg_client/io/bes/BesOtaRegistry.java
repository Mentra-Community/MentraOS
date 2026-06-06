package com.mentra.asg_client.io.bes;

import javax.inject.Inject;
import javax.inject.Singleton;

/** Holds the live {@link BesOtaManager} after K900 UART transport is ready. */
@Singleton
public class BesOtaRegistry {

    private volatile BesOtaManager instance;

    @Inject
    public BesOtaRegistry() {}

    public void setInstance(BesOtaManager manager) {
        this.instance = manager;
    }

    public void clear() {
        this.instance = null;
    }

    public BesOtaManager getInstance() {
        return instance;
    }
}
