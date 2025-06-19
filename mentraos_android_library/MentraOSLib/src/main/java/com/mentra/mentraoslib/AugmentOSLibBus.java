package com.mentra.mentraoslib;

import org.greenrobot.eventbus.EventBus;

public final class AugmentOSLibBus {
    // Build a brand-new EventBus instance; do *not* use AugmentOSLibBus.getInstance().
    private static final EventBus INSTANCE = EventBus.builder().build();

    private AugmentOSLibBus() {
        // private constructor to prevent instantiation
    }

    // Global accessor for the library bus
    public static EventBus getInstance() {
        return INSTANCE;
    }
}