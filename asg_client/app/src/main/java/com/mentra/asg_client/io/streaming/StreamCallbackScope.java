package com.mentra.asg_client.io.streaming;

import java.util.function.Consumer;

/** Serializes publisher callbacks and invalidates work belonging to a released publisher. */
public final class StreamCallbackScope {
    /** Kotlin continuations encode suspended failures as Result.Failure, not Throwable. */
    public static Throwable failure(Object result) {
        try {
            kotlin.ResultKt.throwOnFailure(result);
            return null;
        } catch (Throwable failure) {
            return failure;
        }
    }

    private final Consumer<Runnable> mDispatcher;
    private long mGeneration;

    /** The dispatcher and all lifecycle callers must share one owner thread. */
    public StreamCallbackScope(Consumer<Runnable> dispatcher) {
        mDispatcher = dispatcher;
    }

    /** Invalidates old callbacks even when the replacement uses the same public stream id. */
    public long advance() {
        return ++mGeneration;
    }

    /** Captures the current publisher generation on the owner thread. */
    public long current() {
        return mGeneration;
    }

    /** Tests a delayed lifecycle task on the owner thread. */
    public boolean isCurrent(long generation) {
        return generation == mGeneration;
    }

    /** Checks ownership at execution, never on the originating publisher callback thread. */
    public void dispatch(long generation, Runnable callback) {
        mDispatcher.accept(() -> {
            if (isCurrent(generation)) callback.run();
        });
    }
}
