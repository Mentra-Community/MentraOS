package com.mentra.mentraoslib;

public interface TranslateCallback extends SubscriptionCallback {
    void call(String transcript, String languageCode, long timestamp, boolean isFinal, boolean foo);
}
