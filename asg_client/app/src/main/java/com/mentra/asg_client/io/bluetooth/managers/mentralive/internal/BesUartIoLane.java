package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.FutureTask;
import java.util.concurrent.RejectedExecutionException;

/** Single FIFO owner for physical BES UART writes and descriptor transitions. */
final class BesUartIoLane {
    private final ExecutorService executor =
            Executors.newSingleThreadExecutor(
                    runnable -> {
                        Thread thread = new Thread(runnable, "bes-uart-io");
                        thread.setDaemon(true);
                        return thread;
                    });

    <T> Future<T> submit(Callable<T> action) {
        try {
            return executor.submit(action);
        } catch (RejectedExecutionException e) {
            CompletableFuture<T> rejected = new CompletableFuture<>();
            rejected.completeExceptionally(e);
            return rejected;
        }
    }

    Future<?> submit(Runnable action) {
        try {
            return executor.submit(action);
        } catch (RejectedExecutionException e) {
            CompletableFuture<Void> rejected = new CompletableFuture<>();
            rejected.completeExceptionally(e);
            return rejected;
        }
    }

    void execute(FutureTask<?> task) {
        try {
            executor.execute(task);
        } catch (RejectedExecutionException e) {
            task.cancel(false);
        }
    }

    void shutdownNow() {
        for (Runnable queued : executor.shutdownNow()) {
            if (queued instanceof Future<?>) {
                ((Future<?>) queued).cancel(false);
            }
        }
    }
}
