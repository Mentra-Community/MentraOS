package com.mentra.mentraoslib;

public interface ButtonCallback extends SubscriptionCallback {
    void call(int buttonId, long timestamp, boolean isDown);
}
