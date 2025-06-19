package com.mentra.mentraoslib;

public interface TranscriptCallback extends SubscriptionCallback {
    void call(String transcript, String languageCode, long timestamp, boolean isFinal);
}
