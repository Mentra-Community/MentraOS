package com.mentra.asg_client.io.bes.log;

import android.content.Context;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.VisibleForTesting;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.utils.WakeLockManager;

import org.json.JSONObject;

import java.io.File;
import java.nio.charset.StandardCharsets;

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

    private final Object mLock = new Object();
    private Context mContext;
    private Handler mHandler;
    private HandlerThread mThread;
    private BesTraceStore mStore;
    private BesTraceSession mSession;
    private Sender mSender;
    private volatile boolean mSupported;
    private volatile boolean mEnabled = true;

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
            mSession = new BesTraceSession(mStore.loadCursor());
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
        mEnabled = true;
        mSender = null;
        mStore = null;
        mSession = null;
        mInFlight = false;
        mLastAckMs = 0;
        mWindowActive = false;
    }

    @VisibleForTesting
    boolean windowActive() {
        return mWindowActive;
    }

    @VisibleForTesting
    boolean leaseHeld() {
        return mLeaseHeld;
    }

    /** From sr_syvr {@code wire_caps.rlog_uart}; false on every UART link invalidation. */
    public void setSupported(boolean supported) {
        boolean wasSupported = mSupported;
        mSupported = supported;
        if (supported && !wasSupported) {
            post(mPoll);
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
        }
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
            return; // setSupported/setEnabled re-arm the loop.
        }
        if (mInFlight && now - mRequestedAtMs < AsgConstants.BES_TRACE_REPLY_TIMEOUT_MS) {
            schedule(AsgConstants.BES_TRACE_REPLY_TIMEOUT_MS - (now - mRequestedAtMs));
            return;
        }
        mInFlight = mSender.send(command("mh_rlog", mSession.requestBody()));
        mRequestedAtMs = now;
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
                handleData(body, receivedWallMs);
            } else if ("hm_rlog_ready".equals(name)) {
                handleReady(body, receivedWallMs);
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
                    "[ASG-BES-STATUS] " + body)));
        }
        mInFlight = false;
        schedule(0);
    }

    private void handleData(JSONObject body, long receivedWallMs) {
        mInFlight = false;
        BesTraceSession.Reply reply = mSession.parse(body, receivedWallMs);
        if (!reply.valid) {
            Log.w(TAG, "BES TRACE read rejected: " + reply.error);
            schedule(AsgConstants.BES_TRACE_POLL_IDLE_MS);
            return;
        }
        if (!mStore.append(reply.lines)) {
            Log.e(TAG, "BES TRACE store write failed; not acknowledging");
            schedule(AsgConstants.BES_TRACE_POLL_IDLE_MS);
            return;
        }
        boolean moved = !mSession.hasCursor() || reply.generation != mSession.generation()
                || reply.ackPosition != mSession.position();
        if (moved && !mStore.saveCursor(new BesTraceStore.Cursor(reply.generation, reply.ackPosition))) {
            Log.e(TAG, "BES TRACE cursor write failed; not acknowledging");
            schedule(AsgConstants.BES_TRACE_POLL_IDLE_MS);
            return;
        }
        mSession.commit(reply.generation, reply.ackPosition);
        long now = SystemClock.elapsedRealtime();
        if (moved || mWindowActive || now - mLastAckMs >= AsgConstants.BES_TRACE_IDLE_ACK_MS) {
            if (mSender != null && mSender.send(command("mh_rlog_ack",
                    BesTraceSession.cursorBody(reply.generation, reply.ackPosition)))) {
                mLastAckMs = now;
            }
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
