package com.mentra.asg_client.io.streaming;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayDeque;
import java.util.Queue;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class StreamCallbackScopeTest {
    @Test
    public void decodesSuspendedKotlinFailureWithoutMisclassifyingSuccess() {
        Throwable failure = new IllegalStateException("publisher failed");
        org.junit.Assert.assertSame(failure,
                StreamCallbackScope.failure(kotlin.ResultKt.createFailure(failure)));
        org.junit.Assert.assertNull(StreamCallbackScope.failure(kotlin.Unit.INSTANCE));
    }

    @Test
    public void queuedCallbacksCannotMutateReplacementWithSamePublicId() {
        Queue<Runnable> queue = new ArrayDeque<>();
        StreamCallbackScope scope = new StreamCallbackScope(queue::add);
        AtomicInteger calls = new AtomicInteger();
        long oldPublisher = scope.advance();
        scope.dispatch(oldPublisher, calls::incrementAndGet);
        scope.advance();
        queue.remove().run();
        assertEquals(0, calls.get());
        scope.dispatch(scope.current(), calls::incrementAndGet);
        queue.remove().run();
        assertEquals(1, calls.get());
    }

    @Test
    public void stopInvalidatesPendingStartAndContinuationBeforeReplacementExists() {
        StreamCallbackScope scope = new StreamCallbackScope(Runnable::run);
        long start = scope.current();
        assertTrue(scope.isCurrent(start));
        scope.advance();
        assertFalse(scope.isCurrent(start));
        AtomicInteger calls = new AtomicInteger();
        scope.dispatch(start, calls::incrementAndGet);
        assertEquals(0, calls.get());
    }
}
