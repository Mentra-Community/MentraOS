package com.mentra.asg_client.io.bes.log;

import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.Log;

import com.mentra.asg_client.AsgConstants;

import org.json.JSONObject;

/**
 * Watches the ASG↔BES UART for the silence that precedes a BES watchdog reboot, and records what
 * the chip was doing when it went quiet.
 *
 * <p>A wedged BES is invisible from Android: the MTK side keeps running, the camera keeps encoding,
 * and the only symptom is that nothing arrives from the co-processor until it reboots ~28s later.
 * Because BES keeps no crash record and its trace ring holds only ~20s, the sequence recorded here
 * — when the UART went quiet, how many writes were stranded, what the chip was carrying at the time
 * — is the only durable evidence of the fault. On a suspected reboot this also reads the trace ring
 * once, which is the single window in which BES's own boot output still exists.
 *
 * <p>{@link #onInboundFrame()} and {@link #onOutboundWrite()} run on the UART I/O threads for every
 * frame, so they only store timestamps; all reporting happens on this monitor's own thread.
 */
public final class BesLivenessMonitor {

    /**
     * Pokes BES with the cheap system-version request. Returns false when the write could not be
     * issued. Deliberately not a trace dump — see {@link AsgConstants#BES_STALL_PROBE_SILENCE_MS}.
     */
    public interface StallProbe {
        boolean probeBes();
    }

    private static final String TAG = "BesLivenessMonitor";
    private static final BesLivenessMonitor INSTANCE = new BesLivenessMonitor();

    private final Object monitor = new Object();
    private final BesSilenceLadder ladder =
            new BesSilenceLadder(AsgConstants.BES_LIVENESS_SILENCE_RUNGS_MS);

    private volatile long lastInboundMs;
    private volatile long lastOutboundMs;
    private volatile boolean streamActive;

    /**
     * Writes issued since the last inbound frame. A wedged BES still accepts bytes into its UART
     * FIFO, so a climbing count with no replies distinguishes "chip stopped answering" from "ASG
     * stopped asking".
     */
    private volatile int outboundWritesWhileSilent;

    private HandlerThread thread;
    private Handler handler;
    private StallProbe stallProbe;
    private boolean running;
    private long lastKnownUptimeMs = BesTraceUptime.UNKNOWN;
    private long lastProbeMs;

    private BesLivenessMonitor() {}

    public static BesLivenessMonitor get() {
        return INSTANCE;
    }

    /** Starts the watchdog. Safe to call repeatedly; the probe replaces any previous one. */
    public void start(StallProbe stallProbe) {
        synchronized (monitor) {
            this.stallProbe = stallProbe;
            if (running) {
                return;
            }
            thread = new HandlerThread("BesLiveness");
            thread.start();
            handler = new Handler(thread.getLooper());
            running = true;
            long now = SystemClock.elapsedRealtime();
            lastInboundMs = now;
            lastOutboundMs = now;
            outboundWritesWhileSilent = 0;
            ladder.reset();
            handler.postDelayed(this::tick, AsgConstants.BES_LIVENESS_TICK_MS);
        }
        Log.i(TAG, "BES liveness watchdog started");
    }

    public void stop() {
        HandlerThread doomed;
        synchronized (monitor) {
            if (!running) {
                return;
            }
            running = false;
            handler.removeCallbacksAndMessages(null);
            handler = null;
            doomed = thread;
            thread = null;
            stallProbe = null;
        }
        if (doomed != null) {
            doomed.quitSafely();
        }
    }

    /** Called from the UART reader for every frame BES sends. Must stay allocation-free. */
    public void onInboundFrame() {
        long now = SystemClock.elapsedRealtime();
        long previous = lastInboundMs;
        lastInboundMs = now;
        int stranded = outboundWritesWhileSilent;
        outboundWritesWhileSilent = 0;

        if (!ladder.reported()) {
            return;
        }
        // Rare path: BES had gone quiet long enough to report, so hand the gap to the monitor
        // thread rather than doing JSON work on the UART reader.
        long silentMs = now - previous;
        Handler target;
        synchronized (monitor) {
            target = handler;
        }
        if (target != null) {
            target.post(() -> onTrafficResumed(silentMs, stranded));
        }
    }

    /** Called from the UART writer for every frame ASG sends. Must stay allocation-free. */
    public void onOutboundWrite() {
        lastOutboundMs = SystemClock.elapsedRealtime();
        outboundWritesWhileSilent++;
    }

    /** Streaming holds BES's BLE, A2DP and LC3 paths busy at once; record it as crash context. */
    public void setStreamActive(boolean active) {
        streamActive = active;
    }

    /**
     * Feeds a BES trace snapshot from any source (debug poller or post-reboot capture) so that a
     * reboot is confirmed from BES's own uptime counter rather than inferred from UART silence, and
     * so the boot wall time is on record instead of reconstructed by hand afterwards.
     */
    public void onTraceSnapshot(String trace) {
        long uptimeMs = BesTraceUptime.newestUptimeMs(trace);
        if (uptimeMs == BesTraceUptime.UNKNOWN) {
            return;
        }

        long previousUptimeMs;
        synchronized (monitor) {
            previousUptimeMs = lastKnownUptimeMs;
            lastKnownUptimeMs = uptimeMs;
        }

        try {
            JSONObject fields = new JSONObject();
            fields.put("uptimeMs", uptimeMs);
            fields.put("oldestUptimeMs", BesTraceUptime.oldestUptimeMs(trace));
            fields.put(
                    "impliedBootWallMs",
                    BesTraceUptime.impliedBootWallMs(uptimeMs, System.currentTimeMillis()));
            if (BesTraceUptime.rebooted(previousUptimeMs, uptimeMs)) {
                fields.put("previousUptimeMs", previousUptimeMs);
                BesLivenessLog.warn("bes_reboot_confirmed", fields);
            } else {
                BesLivenessLog.info("bes_uptime", fields);
            }
        } catch (Exception e) {
            Log.d(TAG, "Uptime record failed", e);
        }
    }

    private void tick() {
        long now = SystemClock.elapsedRealtime();
        long silentMs = now - lastInboundMs;
        int unanswered = outboundWritesWhileSilent;
        boolean streaming = streamActive;
        boolean fault =
                BesStallPolicy.isFault(
                        silentMs, unanswered, streaming, AsgConstants.BES_STREAM_SILENCE_FAULT_MS);

        if (!fault) {
            // An idle link is not a stall. Leaving the ladder armed here would also make the next
            // inbound frame report a recovery from a gap that was never a fault.
            ladder.reset();
        } else {
            long crossed = ladder.onSilence(silentMs);
            if (crossed != BesSilenceLadder.NO_RUNG) {
                try {
                    JSONObject fields = new JSONObject();
                    fields.put("silentMs", silentMs);
                    fields.put("rungMs", crossed);
                    fields.put("msSinceLastOutbound", now - lastOutboundMs);
                    fields.put("unansweredWrites", unanswered);
                    fields.put("streamActive", streaming);
                    fields.put(
                            "cause",
                            BesStallPolicy.describe(
                                    silentMs,
                                    unanswered,
                                    streaming,
                                    AsgConstants.BES_STREAM_SILENCE_FAULT_MS));
                    BesLivenessLog.warn("bes_uart_stalled", fields);
                } catch (Exception e) {
                    Log.d(TAG, "Stall record failed", e);
                }
                maybeProbe(silentMs);
            }
        }

        synchronized (monitor) {
            if (running && handler != null) {
                handler.postDelayed(this::tick, AsgConstants.BES_LIVENESS_TICK_MS);
            }
        }
    }

    private void onTrafficResumed(long silentMs, int strandedWrites) {
        ladder.reset();
        try {
            JSONObject fields = new JSONObject();
            fields.put("silentMs", silentMs);
            fields.put("unansweredWrites", strandedWrites);
            fields.put("streamActive", streamActive);
            BesLivenessLog.warn("bes_stall_recovered", fields);
        } catch (Exception e) {
            Log.d(TAG, "Resume record failed", e);
        }
    }

    /**
     * Pokes BES once per stall. If it answers, the next inbound frame ends the stall and proves the
     * chip is alive; if it stays quiet, the climbing silence rungs are the evidence.
     */
    private void maybeProbe(long silentMs) {
        if (silentMs < AsgConstants.BES_STALL_PROBE_SILENCE_MS) {
            return;
        }
        StallProbe probe;
        synchronized (monitor) {
            long now = SystemClock.elapsedRealtime();
            if (lastProbeMs != 0 && now - lastProbeMs < AsgConstants.BES_STALL_PROBE_MIN_SPACING_MS) {
                return;
            }
            if (!running) {
                return;
            }
            lastProbeMs = now;
            probe = stallProbe;
        }
        boolean sent = probe != null && probe.probeBes();
        try {
            JSONObject fields = new JSONObject();
            fields.put("sent", sent);
            fields.put("silentMs", silentMs);
            BesLivenessLog.info("bes_stall_probe", fields);
        } catch (Exception ignored) {
            // Keep probing non-fatal.
        }
    }
}
