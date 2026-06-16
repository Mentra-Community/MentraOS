package com.mentra.asg_client.camera.model;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

import com.mentra.asg_client.camera.CameraNeoService;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Phase 1 unit tests for the global photo request queue + callback registry.
 *
 * <p>{@link QueuedPhotoRequestQueue} is a process-wide singleton, so {@link #drain()} clears state
 * between tests to prevent leakage.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class QueuedPhotoRequestQueueTest {

    @Before
    public void drain() {
        QueuedPhotoRequestQueue.getInstance().failAllPending("test-isolation");
    }

    @After
    public void cleanup() {
        QueuedPhotoRequestQueue.getInstance().failAllPending("test-isolation");
    }

    @Test
    public void offerAndPoll_returnsFifoOrder() {
        QueuedPhotoRequestQueue q = QueuedPhotoRequestQueue.getInstance();
        QueuedPhotoRequest r1 = new QueuedPhotoRequest("/1", "s", false, true, null, null);
        QueuedPhotoRequest r2 = new QueuedPhotoRequest("/2", "s", false, true, null, null);
        QueuedPhotoRequest r3 = new QueuedPhotoRequest("/3", "s", false, true, null, null);
        q.offer(r1);
        q.offer(r2);
        q.offer(r3);

        assertThat(q.size()).isEqualTo(3);
        assertThat(q.poll().filePath).isEqualTo("/1");
        assertThat(q.poll().filePath).isEqualTo("/2");
        assertThat(q.poll().filePath).isEqualTo("/3");
    }

    @Test
    public void poll_onEmptyQueue_returnsNull() {
        assertThat(QueuedPhotoRequestQueue.getInstance().poll()).isNull();
    }

    @Test
    public void isEmpty_reflectsQueueState() {
        QueuedPhotoRequestQueue q = QueuedPhotoRequestQueue.getInstance();
        assertThat(q.isEmpty()).isTrue();
        q.offer(new QueuedPhotoRequest("/a", "s", false, true, null, null));
        assertThat(q.isEmpty()).isFalse();
        q.poll();
        assertThat(q.isEmpty()).isTrue();
    }

    @Test
    public void peek_doesNotRemove() {
        QueuedPhotoRequestQueue q = QueuedPhotoRequestQueue.getInstance();
        QueuedPhotoRequest r = new QueuedPhotoRequest("/peek", "s", false, true, null, null);
        q.offer(r);
        assertThat(q.peek()).isSameAs(r);
        assertThat(q.size()).isEqualTo(1);
    }

    @Test
    public void callbackRegistry_attachedOnPoll_whenRequestHadCallback() {
        QueuedPhotoRequestQueue q = QueuedPhotoRequestQueue.getInstance();
        CameraNeoService.PhotoCaptureCallback cb = mock(CameraNeoService.PhotoCaptureCallback.class);
        QueuedPhotoRequest r = new QueuedPhotoRequest("/cb", "s", false, true, null, cb);

        q.offer(r);

        // After polling the same instance, callback is still the same.
        QueuedPhotoRequest polled = q.poll();
        assertThat(polled.callback).isSameAs(cb);
    }

    @Test
    public void attachRegistryCallback_restoresCallbackOnPeekedRequest() {
        QueuedPhotoRequestQueue q = QueuedPhotoRequestQueue.getInstance();
        CameraNeoService.PhotoCaptureCallback cb = mock(CameraNeoService.PhotoCaptureCallback.class);
        QueuedPhotoRequest r = new QueuedPhotoRequest("/attach", "s", false, true, null, cb);

        q.offer(r);
        // Simulate the dispatcher peeking and then losing the callback reference.
        QueuedPhotoRequest peeked = q.peek();
        peeked.callback = null;

        q.attachRegistryCallback(peeked);
        assertThat(peeked.callback).isSameAs(cb);
    }

    @Test
    public void rapidBurst_fiveOffersAllPollableInOrder() {
        QueuedPhotoRequestQueue q = QueuedPhotoRequestQueue.getInstance();
        for (int i = 1; i <= 5; i++) {
            q.offer(new QueuedPhotoRequest("/burst-" + i, "s", false, true, null, null));
        }
        assertThat(q.size()).isEqualTo(5);
        for (int i = 1; i <= 5; i++) {
            assertThat(q.poll().filePath).isEqualTo("/burst-" + i);
        }
        assertThat(q.isEmpty()).isTrue();
    }

    @Test
    public void failAllPending_invokesEveryRegisteredCallback_andDrainsQueue() {
        QueuedPhotoRequestQueue q = QueuedPhotoRequestQueue.getInstance();
        CameraNeoService.PhotoCaptureCallback cb1 = mock(CameraNeoService.PhotoCaptureCallback.class);
        CameraNeoService.PhotoCaptureCallback cb2 = mock(CameraNeoService.PhotoCaptureCallback.class);
        q.offer(new QueuedPhotoRequest("/x", "s", false, true, null, cb1));
        q.offer(new QueuedPhotoRequest("/y", "s", false, true, null, cb2));

        q.failAllPending("service destroyed");

        verify(cb1, times(1)).onPhotoError("service destroyed");
        verify(cb2, times(1)).onPhotoError("service destroyed");
        assertThat(q.isEmpty()).isTrue();
    }

    @Test
    public void failAllPending_withNoPending_doesNotThrow() {
        // Drain again on an already-empty queue.
        QueuedPhotoRequestQueue.getInstance().failAllPending("noop");
        assertThat(QueuedPhotoRequestQueue.getInstance().isEmpty()).isTrue();
    }

    @Test
    public void offer_withNullCallback_doesNotPollute_registry() {
        QueuedPhotoRequestQueue q = QueuedPhotoRequestQueue.getInstance();
        QueuedPhotoRequest r = new QueuedPhotoRequest("/no-cb", "s", false, true, null, null);
        q.offer(r);
        QueuedPhotoRequest polled = q.poll();
        assertThat(polled.callback).isNull();

        // failAllPending on empty queue must not invoke anything.
        CameraNeoService.PhotoCaptureCallback cb = mock(CameraNeoService.PhotoCaptureCallback.class);
        q.failAllPending("ignored");
        verify(cb, never()).onPhotoError("ignored");
    }
}
