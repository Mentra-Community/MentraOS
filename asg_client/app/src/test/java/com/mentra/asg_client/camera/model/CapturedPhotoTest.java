package com.mentra.asg_client.camera.model;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.Test;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/** Persistence semantics for RAM-first photo captures. */
public class CapturedPhotoTest {

    private static CapturedPhoto photo(Future<Boolean> persistence) {
        return new CapturedPhoto(new byte[] {1, 2, 3}, null, persistence);
    }

    @Test
    public void awaitPersistenceReflectsWriteResult() {
        assertThat(photo(CompletableFuture.completedFuture(true)).awaitPersistence(1000)).isTrue();
        assertThat(photo(CompletableFuture.completedFuture(false)).awaitPersistence(1000))
                .isFalse();

        CompletableFuture<Boolean> failed = new CompletableFuture<>();
        failed.completeExceptionally(new RuntimeException("disk full"));
        assertThat(photo(failed).awaitPersistence(1000)).isFalse();
    }

    @Test
    public void cancelPersistencePreventsQueuedWrite() throws Exception {
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            CountDownLatch blockFirstTask = new CountDownLatch(1);
            executor.submit(
                    () -> {
                        blockFirstTask.await();
                        return null;
                    });
            Future<Boolean> queuedWrite = executor.submit(() -> true);
            CapturedPhoto photo = photo(queuedWrite);

            assertThat(photo.cancelPersistence()).isTrue();
            blockFirstTask.countDown();
            assertThat(photo.awaitPersistence(1000)).isFalse();
        } finally {
            executor.shutdownNow();
        }
    }

    @Test
    public void awaitPersistenceCompletionDoesNotFalseFailRunningWrite() throws Exception {
        ExecutorService writer = Executors.newSingleThreadExecutor();
        ExecutorService waiter = Executors.newSingleThreadExecutor();
        CountDownLatch writeStarted = new CountDownLatch(1);
        CountDownLatch finishWrite = new CountDownLatch(1);
        try {
            Future<Boolean> runningWrite =
                    writer.submit(
                            () -> {
                                writeStarted.countDown();
                                finishWrite.await();
                                return true;
                            });
            Future<Boolean> result =
                    waiter.submit(() -> photo(runningWrite).awaitPersistenceCompletion());
            assertThat(writeStarted.await(1, TimeUnit.SECONDS)).isTrue();

            assertThatThrownBy(() -> result.get(50, TimeUnit.MILLISECONDS))
                    .isInstanceOf(TimeoutException.class);

            finishWrite.countDown();
            assertThat(result.get(1, TimeUnit.SECONDS)).isTrue();
        } finally {
            finishWrite.countDown();
            writer.shutdownNow();
            waiter.shutdownNow();
        }
    }
}
