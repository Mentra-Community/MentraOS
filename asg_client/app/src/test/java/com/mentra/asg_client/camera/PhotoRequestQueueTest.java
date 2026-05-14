package com.mentra.asg_client.camera;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Phase 1 unit tests for the global photo request queue + callback registry.
 *
 * <p>{@link PhotoRequestQueue} is a process-wide singleton, so {@link #drain()} clears state
 * between tests to prevent leakage.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class PhotoRequestQueueTest {

    @Before
    public void drain() {
        PhotoRequestQueue.getInstance().failAllPending("test-isolation");
    }

    @After
    public void cleanup() {
        PhotoRequestQueue.getInstance().failAllPending("test-isolation");
    }

    @Test
    public void offerAndPoll_returnsFifoOrder() {
        PhotoRequestQueue q = PhotoRequestQueue.getInstance();
        PhotoRequest r1 = new PhotoRequest("/1", "s", false, true, null, null);
        PhotoRequest r2 = new PhotoRequest("/2", "s", false, true, null, null);
        PhotoRequest r3 = new PhotoRequest("/3", "s", false, true, null, null);
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
        assertThat(PhotoRequestQueue.getInstance().poll()).isNull();
    }

    @Test
    public void isEmpty_reflectsQueueState() {
        PhotoRequestQueue q = PhotoRequestQueue.getInstance();
        assertThat(q.isEmpty()).isTrue();
        q.offer(new PhotoRequest("/a", "s", false, true, null, null));
        assertThat(q.isEmpty()).isFalse();
        q.poll();
        assertThat(q.isEmpty()).isTrue();
    }

    @Test
    public void peek_doesNotRemove() {
        PhotoRequestQueue q = PhotoRequestQueue.getInstance();
        PhotoRequest r = new PhotoRequest("/peek", "s", false, true, null, null);
        q.offer(r);
        assertThat(q.peek()).isSameAs(r);
        assertThat(q.size()).isEqualTo(1);
    }

    @Test
    public void callbackRegistry_attachedOnPoll_whenRequestHadCallback() {
        PhotoRequestQueue q = PhotoRequestQueue.getInstance();
        CameraNeo.PhotoCaptureCallback cb = mock(CameraNeo.PhotoCaptureCallback.class);
        PhotoRequest r = new PhotoRequest("/cb", "s", false, true, null, cb);

        q.offer(r);

        // After polling the same instance, callback is still the same.
        PhotoRequest polled = q.poll();
        assertThat(polled.callback).isSameAs(cb);
    }

    @Test
    public void attachRegistryCallback_restoresCallbackOnPeekedRequest() {
        PhotoRequestQueue q = PhotoRequestQueue.getInstance();
        CameraNeo.PhotoCaptureCallback cb = mock(CameraNeo.PhotoCaptureCallback.class);
        PhotoRequest r = new PhotoRequest("/attach", "s", false, true, null, cb);

        q.offer(r);
        // Simulate the dispatcher peeking and then losing the callback reference.
        PhotoRequest peeked = q.peek();
        peeked.callback = null;

        q.attachRegistryCallback(peeked);
        assertThat(peeked.callback).isSameAs(cb);
    }

    @Test
    public void rapidBurst_fiveOffersAllPollableInOrder() {
        PhotoRequestQueue q = PhotoRequestQueue.getInstance();
        for (int i = 1; i <= 5; i++) {
            q.offer(new PhotoRequest("/burst-" + i, "s", false, true, null, null));
        }
        assertThat(q.size()).isEqualTo(5);
        for (int i = 1; i <= 5; i++) {
            assertThat(q.poll().filePath).isEqualTo("/burst-" + i);
        }
        assertThat(q.isEmpty()).isTrue();
    }

    @Test
    public void failAllPending_invokesEveryRegisteredCallback_andDrainsQueue() {
        PhotoRequestQueue q = PhotoRequestQueue.getInstance();
        CameraNeo.PhotoCaptureCallback cb1 = mock(CameraNeo.PhotoCaptureCallback.class);
        CameraNeo.PhotoCaptureCallback cb2 = mock(CameraNeo.PhotoCaptureCallback.class);
        q.offer(new PhotoRequest("/x", "s", false, true, null, cb1));
        q.offer(new PhotoRequest("/y", "s", false, true, null, cb2));

        q.failAllPending("service destroyed");

        verify(cb1, times(1)).onPhotoError("service destroyed");
        verify(cb2, times(1)).onPhotoError("service destroyed");
        assertThat(q.isEmpty()).isTrue();
    }

    @Test
    public void failAllPending_withNoPending_doesNotThrow() {
        // Drain again on an already-empty queue.
        PhotoRequestQueue.getInstance().failAllPending("noop");
        assertThat(PhotoRequestQueue.getInstance().isEmpty()).isTrue();
    }

    @Test
    public void offer_withNullCallback_doesNotPollute_registry() {
        PhotoRequestQueue q = PhotoRequestQueue.getInstance();
        PhotoRequest r = new PhotoRequest("/no-cb", "s", false, true, null, null);
        q.offer(r);
        PhotoRequest polled = q.poll();
        assertThat(polled.callback).isNull();

        // failAllPending on empty queue must not invoke anything.
        CameraNeo.PhotoCaptureCallback cb = mock(CameraNeo.PhotoCaptureCallback.class);
        q.failAllPending("ignored");
        verify(cb, never()).onPhotoError("ignored");
    }
}
