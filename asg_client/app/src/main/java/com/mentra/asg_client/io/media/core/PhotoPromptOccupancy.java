package com.mentra.asg_client.io.media.core;

import com.mentra.asg_client.AsgConstants;
import java.util.Objects;
import java.util.function.BooleanSupplier;

/**
 * ASG-side occupancy lease for BES camera-button prompts. Pushes {@code mh_phobsy} only when the
 * suppression predicate changes, a send failed, or a renewal/resync forces a refresh.
 *
 * <p>{@link #publish} samples the predicate inside this monitor so the last frame on the wire
 * always reflects the last sample. {@code remoteStateKnown} is the dirty bit: a failed {@link
 * Sink#push} forces the next send even if the value matches the last confirmed one.
 */
final class PhotoPromptOccupancy {

    static final long LEASE_RENEW_MS = AsgConstants.PHOTO_PROMPT_LEASE_RENEW_MS;

    interface Sink {
        boolean push(boolean busy);
    }

    interface Scheduler {
        void postDelayed(Runnable task, long delayMs);

        void cancel(Runnable task);
    }

    private final Sink sink;
    private final Scheduler scheduler;
    private final Runnable renewTask =
            new Runnable() {
                @Override
                public void run() {
                    BooleanSupplier sample;
                    synchronized (PhotoPromptOccupancy.this) {
                        renewalArmed = false;
                        sample = lastSample;
                    }
                    if (sample != null) {
                        publish(sample, true);
                    }
                }
            };

    private BooleanSupplier lastSample;
    private boolean remoteBusy;
    private boolean remoteStateKnown;
    private boolean renewalArmed;

    PhotoPromptOccupancy(Sink sink, Scheduler scheduler) {
        this.sink = Objects.requireNonNull(sink, "sink");
        this.scheduler = Objects.requireNonNull(scheduler, "scheduler");
    }

    static boolean suppressed(
            boolean captureInFlight, boolean photoJobInFlight, boolean recordingVideo) {
        return captureInFlight || photoJobInFlight || recordingVideo;
    }

    /**
     * Sample the predicate under this monitor and push when the remote view is dirty, the value
     * changed, or {@code forceRefresh} is set. Renewal is armed on the false-to-true edge and
     * cancelled on the true-to-false edge.
     */
    void publish(BooleanSupplier sample, boolean forceRefresh) {
        Objects.requireNonNull(sample, "sample");
        synchronized (this) {
            lastSample = sample;
            boolean busy = sample.getAsBoolean();
            boolean shouldSend = !remoteStateKnown || busy != remoteBusy || forceRefresh;
            if (shouldSend) {
                boolean sent = sink.push(busy);
                if (sent) {
                    remoteBusy = busy;
                    remoteStateKnown = true;
                } else {
                    remoteStateKnown = false;
                }
            }
            updateRenewalLocked(busy);
        }
    }

    /**
     * Marks the remote view unknown and immediately republishes the last sample with {@code
     * forceRefresh}, re-arming renewal to match that sample. No-ops until the first {@link
     * #publish}.
     */
    void resync() {
        BooleanSupplier sample;
        synchronized (this) {
            remoteStateKnown = false;
            sample = lastSample;
        }
        if (sample != null) {
            publish(sample, true);
        }
    }

    /**
     * Bind {@code sample} then resync. Used on link-up so the first connect works before any local
     * mutation has published.
     */
    void resync(BooleanSupplier sample) {
        Objects.requireNonNull(sample, "sample");
        synchronized (this) {
            lastSample = sample;
            remoteStateKnown = false;
        }
        publish(sample, true);
    }

    private void updateRenewalLocked(boolean busy) {
        if (busy) {
            if (!renewalArmed) {
                renewalArmed = true;
                scheduler.postDelayed(renewTask, LEASE_RENEW_MS);
            }
            return;
        }
        if (renewalArmed) {
            renewalArmed = false;
            scheduler.cancel(renewTask);
        }
    }
}
