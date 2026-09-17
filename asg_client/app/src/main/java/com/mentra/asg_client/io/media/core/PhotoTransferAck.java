package com.mentra.asg_client.io.media.core;

import java.io.IOException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/** A bounded phone-acknowledgement wait whose budget starts when transmission starts. */
final class PhotoTransferAck {
    final CompletableFuture<Boolean> result = new CompletableFuture<>();
    private final long deadlineNanos;

    PhotoTransferAck(long timeoutMillis) {
        deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMillis);
    }

    void await() throws Exception {
        if (!result.get(Math.max(0L, deadlineNanos - System.nanoTime()), TimeUnit.NANOSECONDS)) {
            throw new IOException("Thumbnail BLE transfer failed");
        }
    }
}
