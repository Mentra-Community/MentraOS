package com.mentra.asg_client.camera.testing;

import android.hardware.camera2.CaptureRequest;

import com.mentra.asg_client.camera.request.StillCaptureBuilder;

import java.util.HashMap;
import java.util.Map;

/**
 * Records {@link CaptureRequest.Builder#set}-equivalent calls for assertions in unit tests.
 *
 * <p>Implements {@link StillCaptureBuilder.Sink} so it can be passed straight into
 * {@link StillCaptureBuilder#configure(StillCaptureBuilder.Sink, boolean, long, int, long, int,
 * android.util.Range, boolean, android.util.Size, int, int)} without mocking the {@code final}
 * {@link CaptureRequest.Builder} (which Robolectric + Mockito's inline mock maker can't agree on).
 */
public final class CaptureRequestRecorder implements StillCaptureBuilder.Sink {

    private final Map<CaptureRequest.Key<?>, Object> values = new HashMap<>();

    /** {@link StillCaptureBuilder.Sink} entry point — also stores into {@link #values}. */
    @Override
    public <T> void set(CaptureRequest.Key<T> key, T value) {
        values.put(key, value);
    }

    /** Manual record (legacy helper); equivalent to {@link #set}. */
    public <T> void record(CaptureRequest.Key<T> key, T value) {
        values.put(key, value);
    }

    @SuppressWarnings("unchecked")
    public <T> T get(CaptureRequest.Key<T> key) {
        return (T) values.get(key);
    }

    public boolean containsKey(CaptureRequest.Key<?> key) {
        return values.containsKey(key);
    }

    public void clear() {
        values.clear();
    }
}
