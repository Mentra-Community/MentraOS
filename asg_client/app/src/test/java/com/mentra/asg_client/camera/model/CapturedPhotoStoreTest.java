package com.mentra.asg_client.camera.model;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/** Handoff semantics of the RAM-first capture path: store take-once, eviction, persistence gate. */
@RunWith(RobolectricTestRunner.class)
public class CapturedPhotoStoreTest {

    private static CapturedPhoto photo(Future<Boolean> persistence) {
        return new CapturedPhoto(new byte[] {1, 2, 3}, null, persistence);
    }

    @Test
    public void takeReturnsEntryExactlyOnce() {
        CapturedPhoto photo = photo(CompletableFuture.completedFuture(true));
        CapturedPhotoStore.put("/tmp/a.jpg", photo);

        assertThat(CapturedPhotoStore.take("/tmp/a.jpg")).isSameAs(photo);
        assertThat(CapturedPhotoStore.take("/tmp/a.jpg")).isNull();
    }

    @Test
    public void takeUnknownPathReturnsNull() {
        assertThat(CapturedPhotoStore.take("/tmp/never-registered.jpg")).isNull();
    }

    @Test
    public void oldestEntryIsEvictedBeyondCapacity() {
        for (int i = 0; i < 5; i++) {
            CapturedPhotoStore.put(
                    "/tmp/evict-" + i + ".jpg", photo(CompletableFuture.completedFuture(true)));
        }

        // Capacity is 4: the first entry is gone, the last four remain.
        assertThat(CapturedPhotoStore.take("/tmp/evict-0.jpg")).isNull();
        for (int i = 1; i < 5; i++) {
            assertThat(CapturedPhotoStore.take("/tmp/evict-" + i + ".jpg")).isNotNull();
        }
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

            // The write is still queued behind the blocked task, so cancel wins.
            assertThat(photo.cancelPersistence()).isTrue();
            blockFirstTask.countDown();
            assertThat(photo.awaitPersistence(1000)).isFalse();
        } finally {
            executor.shutdownNow();
        }
    }
}
