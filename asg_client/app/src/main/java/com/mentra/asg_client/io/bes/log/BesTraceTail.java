package com.mentra.asg_client.io.bes.log;

import android.content.Context;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.VisibleForTesting;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bes.BesOtaManager;
import com.mentra.asg_client.io.bes.BesOtaStateStore;
import com.mentra.asg_client.utils.WakeLockManager;

import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.Objects;
import java.util.function.BooleanSupplier;

/**
 * Pulls the BES TRACE ring over UART ({@code mh_rlog}), persists it to {@link BesTraceStore},
 * and acknowledges what is on disk ({@code mh_rlog_ack}).
 *
 * <p>While Android is awake the tail polls by itself and acknowledges at least every
 * {@link AsgConstants#BES_TRACE_IDLE_ACK_MS}, so the BES never needs to wake the MTK. While
 * Android sleeps nothing here runs; the BES wakes the MTK before its ten-minute deadline or when
 * its ring fills and announces the window with {@code hm_rlog_ready}. The tail then holds a
 * bounded CPU lease until it has caught up, and releases it so the MTK can suspend again.
 *
 * <p>Transport frames are never written to logcat: at up to eight reads a second they would
 * crowd the logcat window a bug report captures.
 */
public final class BesTraceTail {
    private static final String TAG = "BesTraceTail";
    private static final BesTraceTail INSTANCE = new BesTraceTail();

    /** Sends one K900 STRING command without per-frame logging. */
    public interface Sender {
        boolean send(String json);
    }

    /**
     * Serializes one TRACE read window (request, persist, acknowledge) with other BES log
     * transfers on the UART; the integrator plugs BesLogTransferLock (Owner.TRACE_TAIL) in here.
     */
    public interface TransferGate {
        /** Waits up to {@code timeoutMs}; true when the window may run. */
        boolean acquire(long timeoutMs) throws InterruptedException;

        void release();
    }

    private static final TransferGate NO_GATE = new TransferGate() {
        @Override
        public boolean acquire(long timeoutMs) {
            return true;
        }

        @Override
        public void release() {}
    };

    private final Object mLock = new Object();
    private Context mContext;
    private Handler mHandler;
    private HandlerThread mThread;
    private BesTraceStore mStore;
    private BesTraceSession mSession;
    private Sender mSender;
    private volatile boolean mSupported;
    private volatile boolean mEnabled = true;
    private volatile boolean mSubSupported;
    private volatile TransferGate mGate = NO_GATE;
    private volatile BooleanSupplier mOtaStateCheck;
    private volatile int mGroupMaxBatches = AsgConstants.BES_TRACE_GROUP_COMMIT_MAX_BATCHES;
    private volatile long mGroupMaxMs = AsgConstants.BES_TRACE_GROUP_COMMIT_MAX_MS;

    private TransferGate mHeldGate;
    private boolean mGateHeld;
    private boolean mSubSent;
    private boolean mSubConfirmed;
    private long mSubAttemptAtMs = -1;
    private int mPendingBatches;
    private long mPendingSinceMs;

    private boolean mInFlight;
    private long mRequestedAtMs;
    private long mLastAckMs;
    private boolean mWindowActive;
    private long mWindowEndsMs;
    private boolean mLeaseHeld;
    private int mWindowBatches;
    private long mWindowBytes;

    private final Runnable mPoll = this::poll;

    public static BesTraceTail get() {
        return INSTANCE;
    }

    private BesTraceTail() {}

    /** Called once by the service; creates the store and the worker thread. */
    public void attach(Context context) {
        synchronized (mLock) {
            if (mHandler != null || context == null) {
                return;
            }
            Context app = context.getApplicationContext();
            mContext = app != null ? app : context;
            File files = mContext.getFilesDir();
            if (files == null) {
                return;
            }
            File dir = new File(files, "bes_trace");
            mStore = new BesTraceStore(dir, System::currentTimeMillis,
                    AsgConstants.BES_TRACE_STORE_RETENTION_MS, AsgConstants.BES_TRACE_STORE_MAX_BYTES,
                    AsgConstants.BES_TRACE_SEGMENT_MAX_BYTES, AsgConstants.BES_TRACE_SEGMENT_MAX_AGE_MS);
            mStore.setDuplicateGuard(true);
            mSession = new BesTraceSession(mStore.loadCursor());
            BesOtaStateStore otaStore = new BesOtaStateStore(mContext);
            mOtaStateCheck = () -> otaSnapshotInProgress(otaStore.read());
            mThread = new HandlerThread("bes-trace-tail");
            mThread.start();
            mHandler = new Handler(mThread.getLooper());
            mHandler.post(mPoll);
        }
    }

    public void detach() {
        synchronized (mLock) {
            if (mHandler == null) {
                return;
            }
            mHandler.removeCallbacksAndMessages(null);
            releaseLease();
            try {
                unsubscribe(mSupported);
                commitPending();
            } catch (RuntimeException e) {
                Log.w(TAG, "BES TRACE shutdown flush failed", e);
            }
            releaseGate();
            mThread.quitSafely();
            mHandler = null;
            mThread = null;
        }
    }

    public void setSender(Sender sender) {
        mSender = sender;
    }

    @VisibleForTesting
    public Looper looper() {
        Handler handler = mHandler;
        return handler != null ? handler.getLooper() : null;
    }

    @VisibleForTesting
    public void resetForTest() {
        detach();
        mSupported = false;
        mSubSupported = false;
        mEnabled = true;
        mSender = null;
        mStore = null;
        mSession = null;
        mInFlight = false;
        mLastAckMs = 0;
        mWindowActive = false;
        mGate = NO_GATE;
        mHeldGate = null;
        mGateHeld = false;
        mOtaStateCheck = null;
        mSubSent = false;
        mSubConfirmed = false;
        mSubAttemptAtMs = -1;
        mPendingBatches = 0;
        mGroupMaxBatches = AsgConstants.BES_TRACE_GROUP_COMMIT_MAX_BATCHES;
        mGroupMaxMs = AsgConstants.BES_TRACE_GROUP_COMMIT_MAX_MS;
    }

    @VisibleForTesting
    boolean windowActive() {
        return mWindowActive;
    }

    @VisibleForTesting
    boolean leaseHeld() {
        return mLeaseHeld;
    }

    /**
     * From sr_syvr {@code wire_caps}: {@code rlog_uart} enables the tail, {@code rlog_sub} adds the
     * delivery subscription (mh_rlog_sub). Call with null when the link is invalidated.
     */
    public void onWireCaps(JSONObject caps) {
        boolean uart = caps != null && caps.optInt("rlog_uart", 0) == 1;
        mSubSupported = uart && caps.optInt("rlog_sub", 0) == 1;
        // A fresh sr_syvr means the BES (re)announced itself: it may have cleared its consumer
        // state while the MTK was off, so a subscription held before this call is sent again.
        final boolean held = mSubSupported && (mSubSent || mSubConfirmed);
        setSupported(uart);
        post(() -> {
            if (held) {
                mSubSent = false;
                mSubConfirmed = false;
                mSubAttemptAtMs = -1;
            }
            syncSubscription(SystemClock.elapsedRealtime());
        });
    }

    /** From sr_syvr {@code wire_caps.rlog_uart}; false on every UART link invalidation. */
    public void setSupported(boolean supported) {
        boolean wasSupported = mSupported;
        mSupported = supported;
        if (supported && !wasSupported) {
            post(mPoll);
        } else if (!supported && wasSupported) {
            post(this::onLinkLost);
        }
    }

    public boolean isSupported() {
        return mSupported;
    }

    /** Debug override (DebugBesTraceReceiver). */
    public void setEnabled(boolean enabled) {
        mEnabled = enabled;
        if (enabled) {
            post(mPoll);
        } else {
            post(this::onDisabled);
        }
    }

    /** Pluggable serialization with other BES log transfers; null restores the no-op gate. */
    public void setTransferGate(TransferGate gate) {
        mGate = gate != null ? gate : NO_GATE;
    }

    /**
     * Advancing batches that may share one sync + cursor save (1 = a commit per batch). The
     * acknowledgement always follows the commit.
     */
    public void setGroupCommit(int maxBatches, long maxMs) {
        mGroupMaxBatches = Math.max(1, maxBatches);
        mGroupMaxMs = Math.max(1, maxMs);
    }

    /** Swaps the store (to inject sync failures) and restarts the session from its cursor. */
    @VisibleForTesting
    void replaceStoreForTest(BesTraceStore store) {
        mStore = store;
        store.setDuplicateGuard(true);
        mSession = new BesTraceSession(store.loadCursor());
        mPendingBatches = 0;
    }

    /** Replaces the check for a saved, non-final BES OTA state (tests). */
    @VisibleForTesting
    void setOtaStateCheck(BooleanSupplier check) {
        mOtaStateCheck = check;
    }

    /** One line with the persistence cost aggregates since the process started; also logged. */
    public String dumpStoreStats() {
        BesTraceStore store = mStore;
        String summary = store != null ? store.statsSummary() : "[ASG-BES-STORE] no store";
        Log.i(TAG, summary);
        return summary;
    }

    /** Same rule as BesOtaManager.isBesOtaInProgress(): corrupt or any non-final saved state. */
    static boolean otaSnapshotInProgress(BesOtaStateStore.Snapshot snapshot) {
        return snapshot.isCorrupt()
                || (snapshot.isValid() && snapshot.getState() != BesOtaStateStore.State.TERMINAL);
    }

    private boolean otaInProgress() {
        if (BesOtaManager.isBesOtaInProgress) {
            return true;
        }
        BooleanSupplier check = mOtaStateCheck;
        return check != null && check.getAsBoolean();
    }

    /** True when bug reports should use the store instead of an mh_logs dump. */
    public boolean canServeIncidents() {
        return mSupported && mStore != null;
    }

    public BesTraceStore store() {
        return mStore;
    }

    /** True when the payload is a TRACE transport frame; consumed without further routing. */
    public static boolean isTransportPayload(byte[] payload) {
        if (payload == null || payload.length < 16) {
            return false;
        }
        String head = new String(payload, 0, Math.min(payload.length, 40), StandardCharsets.UTF_8);
        return head.contains("\"C\":\"hm_rlog");
    }

    /** Called from the UART reader thread with a K900 STRING payload. */
    public boolean onUartPayload(byte[] payload) {
        if (!isTransportPayload(payload)) {
            return false;
        }
        final long receivedWallMs = System.currentTimeMillis();
        final String text = new String(payload, StandardCharsets.UTF_8);
        post(() -> handleFrame(text, receivedWallMs));
        return true;
    }

    private void post(Runnable runnable) {
        Handler handler = mHandler;
        if (handler != null) {
            handler.post(runnable);
        }
    }

    private void schedule(long delayMs) {
        Handler handler = mHandler;
        if (handler != null) {
            handler.removeCallbacks(mPoll);
            handler.postDelayed(mPoll, delayMs);
        }
    }

    private void poll() {
        long now = SystemClock.elapsedRealtime();
        if (mWindowActive && now >= mWindowEndsMs) {
            endWindow("timeout");
        }
        if (!mSupported || !mEnabled || mSender == null) {
            // setSupported/setEnabled re-arm the loop. Whatever is stored but not yet durable is
            // made durable now; nothing is acknowledged on a link that is gone.
            commitPending();
            releaseGate();
            return;
        }
        if (otaInProgress()) {
            // The UART belongs to the OTA transfer (running, or saved and waiting for the apply
            // or the verification boot); the BES ring keeps the lines meanwhile.
            commitPending();
            releaseGate();
            schedule(AsgConstants.BES_TRACE_POLL_IDLE_MS);
            return;
        }
        syncSubscription(now);
        if (mPendingBatches > 0 && now - mPendingSinceMs >= mGroupMaxMs && acquireGate()) {
            finishCommit(commitPending(), false);
            if (!mInFlight) {
                releaseGate();
            }
        }
        if (mInFlight && now - mRequestedAtMs < AsgConstants.BES_TRACE_REPLY_TIMEOUT_MS) {
            schedule(AsgConstants.BES_TRACE_REPLY_TIMEOUT_MS - (now - mRequestedAtMs));
            return;
        }
        if (!acquireGate()) {
            schedule(AsgConstants.BES_TRACE_POLL_IDLE_MS);
            return;
        }
        mInFlight = mSender.send(command("mh_rlog", mSession.requestBody()));
        mRequestedAtMs = now;
        if (!mInFlight) {
            releaseGate();
        }
        schedule(mInFlight ? AsgConstants.BES_TRACE_REPLY_TIMEOUT_MS : AsgConstants.BES_TRACE_POLL_IDLE_MS);
    }

    private void handleFrame(String text, long receivedWallMs) {
        try {
            JSONObject frame = new JSONObject(text);
            String name = frame.optString("C", "");
            Object rawBody = frame.opt("B");
            JSONObject body = rawBody instanceof JSONObject ? (JSONObject) rawBody
                    : rawBody != null ? new JSONObject(String.valueOf(rawBody)) : null;
            if ("hm_rlog".equals(name)) {
                try {
                    handleData(body, receivedWallMs);
                } finally {
                    releaseGate();
                }
            } else if ("hm_rlog_ready".equals(name)) {
                handleReady(body, receivedWallMs);
            } else if ("hm_rlog_ack".equals(name)) {
                handleAck(body);
            } else if ("hm_rlog_sub".equals(name)) {
                handleSub(body);
            }
        } catch (Exception e) {
            Log.w(TAG, "Unreadable BES TRACE frame", e);
        }
    }

    private void handleReady(JSONObject body, long receivedWallMs) {
        long now = SystemClock.elapsedRealtime();
        if (!mWindowActive) {
            mWindowBatches = 0;
            mWindowBytes = 0;
        }
        mWindowActive = true;
        mWindowEndsMs = now + AsgConstants.BES_TRACE_WINDOW_MS;
        if (!mLeaseHeld && mContext != null) {
            mLeaseHeld = WakeLockManager.acquireCpu(mContext, WakeLockManager.WakeOwner.BES_LOG,
                    AsgConstants.BES_TRACE_WAKE_LEASE_MS);
        }
        if (body != null && mStore != null) {
            // The BES counters make UART or ring clogging visible in every bug report.
            mStore.append(java.util.Collections.singletonList(new BesTraceStore.Line(
                    receivedWallMs, body.optLong("g", 0), mSession.position(),
                    "[ASG-BES-STATUS] " + body, BesTraceSession.parseBid(body))));
        }
        mInFlight = false;
        releaseGate();
        schedule(0);
    }

    /**
     * The BES answers every acknowledgement; a boot id that is not the one we acknowledged means
     * the BES rebooted, so the next read (which names our old bid) restarts from its oldest byte.
     */
    private void handleAck(JSONObject body) {
        String bid = BesTraceSession.parseBid(body);
        if (bid != null && mSession != null && mSession.hasCursor()
                && !bid.equals(mSession.bid())) {
            schedule(0);
        }
    }

    /** hm_rlog_sub {on, bid}: the BES's view of the subscription (a reboot clears it). */
    private void handleSub(JSONObject body) {
        if (body == null) {
            return;
        }
        boolean on = body.optInt("on", 0) == 1;
        mSubConfirmed = on;
        if (!on) {
            mSubSent = false; // The BES dropped it (new boot); subscribe again while wanted.
            schedule(0);
        }
    }

    private void handleData(JSONObject body, long receivedWallMs) {
        mInFlight = false;
        BesTraceSession.Reply reply = mSession.parse(body, receivedWallMs);
        if (!reply.valid) {
            Log.w(TAG, "BES TRACE read rejected: " + reply.error);
            schedule(AsgConstants.BES_TRACE_POLL_IDLE_MS);
            return;
        }
        if (mPendingBatches > 0 && (!Objects.equals(reply.bid, mSession.bid())
                || reply.generation != mSession.generation())) {
            // Another boot: what the old boot delivered becomes durable first. It is not
            // acknowledged; the BES no longer knows that cursor. Parsing already used the
            // read cursor, so the marker lines of this reply stay correct.
            if (commitPending() < 0) {
                schedule(AsgConstants.BES_TRACE_POLL_IDLE_MS);
                return;
            }
        }
        boolean group = mGroupMaxBatches > 1;
        boolean stored = group ? mStore.appendUnsynced(reply.lines) : mStore.append(reply.lines);
        if (!stored) {
            Log.e(TAG, "BES TRACE store write failed; not acknowledging");
            schedule(AsgConstants.BES_TRACE_POLL_IDLE_MS);
            return;
        }
        long now = SystemClock.elapsedRealtime();
        boolean moved = !mSession.hasCursor() || reply.generation != mSession.generation()
                || reply.ackPosition != mSession.position()
                || !Objects.equals(reply.bid, mSession.bid());
        mSession.advance(reply.bid, reply.generation, reply.ackPosition);
        if (moved) {
            if (mPendingBatches == 0) {
                mPendingSinceMs = now;
            }
            mPendingBatches++;
        }
        boolean commitNow = !group
                || mPendingBatches >= mGroupMaxBatches
                || (mPendingBatches > 0 && now - mPendingSinceMs >= mGroupMaxMs)
                || reply.backlog() <= 0
                || reply.ackPosition <= reply.start;
        if (commitNow) {
            int committed = commitPending();
            if (committed < 0) {
                schedule(AsgConstants.BES_TRACE_POLL_IDLE_MS);
                return;
            }
            finishCommit(committed, true);
        }
        if (!reply.lines.isEmpty()) {
            BesLivenessMonitor.get().onTraceSnapshot(joinText(reply));
        }
        if (mWindowActive) {
            mWindowBatches++;
            mWindowBytes += reply.ackPosition - reply.start;
            if (reply.backlog() <= AsgConstants.BES_TRACE_CAUGHT_UP_BYTES) {
                endWindow("caught_up");
            }
        }
        schedule(reply.backlog() > 0 && reply.ackPosition > reply.start
                ? AsgConstants.BES_TRACE_POLL_BACKLOG_MS : AsgConstants.BES_TRACE_POLL_IDLE_MS);
    }

    /**
     * Makes everything stored so far durable: log sync, then cursor save. Returns -1 when that
     * failed (the read cursor goes back to the last durable one and nothing is acknowledged),
     * 0 when nothing moved, 1 when the durable cursor advanced.
     */
    private int commitPending() {
        BesTraceStore store = mStore;
        BesTraceSession session = mSession;
        if (store == null || session == null) {
            return 0;
        }
        boolean advanced = session.hasUndurableAdvance();
        if (!advanced && mPendingBatches == 0) {
            return 0;
        }
        if (!store.sync()) {
            Log.e(TAG, "BES TRACE log sync failed; not acknowledging");
            session.rollbackToDurable();
            mPendingBatches = 0;
            return -1;
        }
        if (advanced && !store.saveCursor(session.readCursor())) {
            Log.e(TAG, "BES TRACE cursor write failed; not acknowledging");
            session.rollbackToDurable();
            mPendingBatches = 0;
            return -1;
        }
        session.markDurable();
        store.recordCommit(mPendingBatches);
        mPendingBatches = 0;
        return advanced ? 1 : 0;
    }

    /** The acknowledgement; only ever called after {@link #commitPending} succeeded. */
    private void finishCommit(int committed, boolean fromReply) {
        if (committed < 0 || mSender == null || mSession == null || !mSession.hasCursor()) {
            return;
        }
        long now = SystemClock.elapsedRealtime();
        if (committed > 0 || (fromReply && (mWindowActive
                || now - mLastAckMs >= AsgConstants.BES_TRACE_IDLE_ACK_MS))) {
            BesTraceStore.Cursor durable = mSession.durableCursor();
            if (mSender.send(command("mh_rlog_ack",
                    BesTraceSession.cursorBody(durable.bid, durable.generation, durable.position)))) {
                mLastAckMs = now;
            }
        }
    }

    // Subscription (wire_caps rlog_sub): the BES sends delivery wakes only to a subscriber.

    private void syncSubscription(long now) {
        if (mSender == null) {
            return;
        }
        boolean want = mSupported && mEnabled && mSubSupported;
        if (want) {
            boolean due = mSubAttemptAtMs < 0
                    || now - mSubAttemptAtMs >= (mSubSent
                    ? AsgConstants.BES_TRACE_SUB_RETRY_MS : AsgConstants.BES_TRACE_POLL_IDLE_MS);
            if (!mSubSent || (!mSubConfirmed && due)) {
                if (due) {
                    mSubAttemptAtMs = now;
                    mSubSent = mSender.send(command("mh_rlog_sub", "{\"on\":1}"));
                }
            }
        } else if (!mSubSupported) {
            mSubSent = false;
            mSubConfirmed = false;
        } else if (mSubSent) {
            unsubscribe(true);
        }
    }

    /** Sends mh_rlog_sub {on:0} (best effort) when subscribed, and forgets the subscription. */
    private void unsubscribe(boolean send) {
        boolean wasSubscribed = mSubSent || mSubConfirmed;
        mSubSent = false;
        mSubConfirmed = false;
        mSubAttemptAtMs = -1;
        Sender sender = mSender;
        if (send && wasSubscribed && mSubSupported && sender != null) {
            sender.send(command("mh_rlog_sub", "{\"on\":0}"));
        }
    }

    /** The UART link was invalidated: the BES cleared its consumer state on its side too. */
    private void onLinkLost() {
        unsubscribe(!mSupported);
        commitPending();
        releaseGate();
        mInFlight = false;
    }

    private void onDisabled() {
        if (mEnabled) {
            return;
        }
        unsubscribe(true);
        commitPending();
        releaseGate();
        mInFlight = false;
    }

    // Transfer gate: held for one read window (request until the reply is persisted and acked).

    private boolean acquireGate() {
        if (mGateHeld) {
            return true;
        }
        TransferGate gate = mGate;
        try {
            if (gate.acquire(AsgConstants.BES_TRACE_GATE_TIMEOUT_MS)) {
                mHeldGate = gate;
                mGateHeld = true;
                return true;
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return false;
    }

    private void releaseGate() {
        if (mGateHeld) {
            mGateHeld = false;
            TransferGate gate = mHeldGate;
            mHeldGate = null;
            if (gate != null) {
                gate.release();
            }
        }
    }

    private void endWindow(String reason) {
        Log.i(TAG, "BES TRACE window " + reason + ": " + mWindowBatches + " reads, "
                + mWindowBytes + " bytes");
        mWindowActive = false;
        releaseLease();
    }

    private void releaseLease() {
        if (mLeaseHeld) {
            WakeLockManager.release(WakeLockManager.WakeOwner.BES_LOG);
            mLeaseHeld = false;
        }
    }

    private static String joinText(BesTraceSession.Reply reply) {
        StringBuilder text = new StringBuilder();
        for (BesTraceStore.Line line : reply.lines) {
            text.append(line.text).append('\n');
        }
        return text.toString();
    }

    private static String command(String name, String body) {
        try {
            JSONObject command = new JSONObject();
            command.put("C", name);
            command.put("V", 1);
            // B must be a JSON string: BES reads it through cJSON's valuestring.
            command.put("B", body);
            return command.toString();
        } catch (Exception e) {
            return "{\"C\":\"" + name + "\",\"V\":1,\"B\":\"\"}";
        }
    }
}
