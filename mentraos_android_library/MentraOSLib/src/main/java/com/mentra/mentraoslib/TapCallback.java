package com.mentra.mentraoslib;

public interface TapCallback extends SubscriptionCallback {
    void call(int numTaps, boolean sideOfGlasses, long timestamp);
}
