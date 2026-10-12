package com.mentra.asg_client.io.bes.log;

import android.content.Context;
import android.util.Log;

import androidx.annotation.VisibleForTesting;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bes.BesOtaManager;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.LongSupplier;
import java.util.zip.CRC32;

/**
 * Detects BES crashes and unexpected resets from {@code sr_syvr} and persists them as incident
 * bundles (OS-1988 contract sections 1, 3 and 7).
 *
 * <p>Nothing happens unless the BES advertises {@code wire_caps.crash_pull == 1}; an older BES
 * never sees {@code cs_log}. For each {@code sr_syvr} with a {@code crash} object the collector:
 *
 * <ol>
 *   <li>resumes every persisted COLLECTING incident whose dump the BES still holds, and drops the
 *       ones whose dump is gone or replaced;
 *   <li>opens a COLLECTING incident for a dump id not yet collected, freezing the TRACE window
 *       first, and pulls the dump with {@code cs_log {action:0, dump_id}};
 *   <li>opens a no-dump (reset) incident when the previous boot ended with a reset the
 *       {@link ResetClassifier} calls unexpected, and no dump explains that transition, at most
 *       once per boot_id;
 *   <li>persists the observed boot_id as {@code last_boot}.
 * </ol>
 *
 * <p>A dump is STORED only when the {@code [CRASH-DUMP]} header names the requested dump_id and
 * the received length and CRC match (or, for a truncated transfer, the trailer's prefix values).
 * Anything else leaves the incident COLLECTING with a persisted attempt counter and backoff.
 *
 * <p>All state lives on one worker thread; callers only post to it.
 */
public final class BesCrashDumpCollector {
    private static final String TAG = "BesCrashDumpCollector";
    private static final int END_CUR = 255;

    /** Called when an incident becomes STORED, after its incident.json is persisted. */
    public interface StoredListener {
        void onStored(String incidentKey);
    }

    /** Sends one K900 STRING command without per-frame logging. */
    public interface Sender {
        boolean send(String json);
    }

    /** Handle for a delayed task. */
    public interface Cancellable {
        void cancel();
    }

    /** Single-threaded executor the collector runs on (a manual fake in tests). */
    public interface Scheduler {
        void post(Runnable task);

        Cancellable postDelayed(Runnable task, long delayMs);
    }

    private static BesCrashDumpCollector sInstance;

    private final BesIncidentStore mStore;
    private final BesLogTransferLock mLock;
    private final TraceFreezer mFreezer;
    private final Scheduler mScheduler;
    private final LongSupplier mClockMs;
    private final BooleanSupplier mPullAllowed;
    private volatile ResetClassifier mClassifier = new DefaultResetClassifier();
    private volatile StoredListener mListener;

    // Worker-thread state.
    private Sender mSender;
    private boolean mCrashPull;
    private String mAdvertisedDumpId;
    private final Set<String> mWanted = new LinkedHashSet<>();
    private final java.util.Map<String, Long> mNotBeforeMs = new java.util.HashMap<>();
    private final java.util.Map<String, Integer> mDeferrals = new java.util.HashMap<>();
    private Cancellable mPumpTimer;
    private Transfer mTransfer;

    /** Production singleton; {@link #attach(Context)} must run before use. */
    public static synchronized BesCrashDumpCollector get() {
        if (sInstance == null) {
            sInstance = new BesCrashDumpCollector(null, BesLogTransferLock.get(),
                    new BesTraceStoreFreezer(), new ExecutorScheduler(), System::currentTimeMillis,
                    () -> !BesOtaManager.isBesOtaInProgress);
        }
        return sInstance;
    }

    @VisibleForTesting
    public static synchronized void setInstanceForTest(BesCrashDumpCollector instance) {
        sInstance = instance;
    }

    @VisibleForTesting
    public BesCrashDumpCollector(BesIncidentStore store, BesLogTransferLock lock,
            TraceFreezer freezer, Scheduler scheduler, LongSupplier clockMs,
            BooleanSupplier pullAllowed) {
        mStore = store;
        mLock = lock;
        mFreezer = freezer;
        mScheduler = scheduler;
        mClockMs = clockMs;
        mPullAllowed = pullAllowed;
    }

    private BesIncidentStore mAttachedStore;

    /** Opens the incident store under {@code files/bes_incident} and clears interrupted writes. */
    public synchronized void attach(Context context) {
        if (mAttachedStore != null || mStore != null || context == null) {
            return;
        }
        BesIncidentStore store = BesIncidentStore.create(context);
        store.recover();
        mAttachedStore = store;
    }

    /** The incident store (also the {@link BesIncidentUploadAccess} for the upload side). */
    public synchronized BesIncidentStore store() {
        return mStore != null ? mStore : mAttachedStore;
    }

    public void setStoredListener(StoredListener listener) {
        mListener = listener;
    }

    public void setResetClassifier(ResetClassifier classifier) {
        mClassifier = classifier != null ? classifier : new DefaultResetClassifier();
    }

    // ------------------------------------------------------------------ inputs

    /**
     * Called for every {@code sr_syvr} the BES sends, with the whole parsed message. Returns at
     * once; the work runs on the collector thread.
     */
    public void onSystemVersion(JSONObject srSyvr, Sender sender) {
        if (srSyvr == null) {
            return;
        }
        mScheduler.post(() -> guarded("sr_syvr", () -> handleSystemVersion(srSyvr, sender)));
    }

    /** Called for each {@code sr_log} packet while the crash pull owns the log channel. */
    public void onLogPacket(int cur, String body) {
        mScheduler.post(() -> guarded("sr_log", () -> handleLogPacket(cur, body)));
    }

    // ------------------------------------------------------------ sr_syvr logic

    private void handleSystemVersion(JSONObject json, Sender sender) {
        BesIncidentStore store = store();
        JSONObject caps = findObject(json, "wire_caps");
        if (store == null || caps == null || !flag(caps, "crash_pull")) {
            mCrashPull = false;
            return;
        }
        mCrashPull = true;
        mSender = sender;
        JSONObject crash = findObject(json, "crash");
        if (crash == null) {
            return;
        }
        String bootId = crash.optString("boot_id", "");
        if (!BesIncident.isBootId(bootId)) {
            Log.w(TAG, "sr_syvr crash.boot_id is not a valid boot id; ignoring the crash object");
            return;
        }
        long resetHw = crash.optLong("reset_hw", 0);
        long resetSw = crash.optLong("reset_sw", 0);
        String dumpId = BesIncident.isDumpId(crash.optString("dump_id", ""))
                ? crash.optString("dump_id") : null;
        long dumpLen = crash.optLong("dump_len", 0);
        String dumpBoot = BesIncident.isBootId(crash.optString("dump_boot_id", ""))
                ? crash.optString("dump_boot_id") : null;
        mAdvertisedDumpId = dumpId;

        String prev = store.lastBoot();
        boolean sameBoot = bootId.equals(prev);
        boolean ok = true;

        // 1. Incidents still collecting: pull again while the BES still holds the dump, else drop.
        for (JSONObject record : store.all()) {
            if (!BesIncident.STATE_COLLECTING.equals(record.optString("state"))) {
                continue;
            }
            String key = record.optString("incidentKey");
            String wantedDump = record.isNull("dumpId") ? null : record.optString("dumpId");
            if (wantedDump != null && wantedDump.equals(dumpId)) {
                want(key);
            } else {
                // The BES no longer holds that dump, so it can never be completed. It is not
                // marked collected: it was not.
                store.evict(key, dumpId == null ? "dump_gone" : "dump_replaced", false);
                mWanted.remove(key);
            }
        }

        // 2. A dump not collected yet.
        boolean newDump = dumpId != null && dumpLen > 0 && !store.isDumpCollected(dumpId)
                && !store.exists(store.dumpKey(dumpId));
        String attribution = attribute(prev, dumpBoot);
        if (newDump) {
            JSONObject record = newRecord(store.dumpKey(dumpId), BesIncident.KIND_DUMP,
                    BesIncident.REASON_CRASH, BesIncident.STATE_COLLECTING, attribution, dumpBoot,
                    bootId, dumpId, dumpLen, null, null, prev);
            if (createWithTrace(store, record)) {
                want(record.optString("incidentKey"));
            } else {
                ok = false;
            }
        }

        // 3. An unexpected reset of the previous boot that no dump explains.
        boolean coveredByDump = false;
        if (newDump) {
            coveredByDump = !BesIncident.ATTR_OLDER.equals(attribution);
        } else if (dumpId != null) {
            JSONObject existing = store.find(store.dumpKey(dumpId));
            if (existing != null && bootId.equals(existing.optString("observedBootId"))) {
                // Seen on an earlier sr_syvr of this very boot (last_boot was not saved yet).
                coveredByDump = !BesIncident.ATTR_OLDER.equals(existing.optString("attribution"));
            } else {
                coveredByDump = dumpBoot != null && dumpBoot.equals(prev);
            }
        }
        if (!sameBoot && prev != null && !coveredByDump && !store.isResetObserved(bootId)
                && mClassifier.isUnexpected(resetHw, resetSw)) {
            String key = store.resetKey(bootId);
            if (!store.exists(key)) {
                JSONObject record = newRecord(key, BesIncident.KIND_RESET,
                        BesIncident.REASON_RESET, BesIncident.STATE_STORED,
                        BesIncident.ATTR_MATCH, prev, bootId, null, 0, resetHw, resetSw, prev);
                if (createWithTrace(store, record)) {
                    store.markResetObserved(bootId);
                    store.enforceBudget(key);
                    notifyStored(key);
                } else {
                    ok = false;
                }
            } else {
                store.markResetObserved(bootId);
            }
        }

        // 4. Remember the boot, unless an incident could not be persisted (try again next time).
        if (ok && !sameBoot) {
            store.saveLastBoot(bootId);
        }
        pump();
    }

    /** match / older / unknown against the previous BES boot ASG actually observed. */
    static String attribute(String previousBoot, String dumpBoot) {
        if (previousBoot == null || dumpBoot == null) {
            return BesIncident.ATTR_UNKNOWN;
        }
        return previousBoot.equals(dumpBoot) ? BesIncident.ATTR_MATCH : BesIncident.ATTR_OLDER;
    }

    private JSONObject newRecord(String key, String kind, String reason, String state,
            String attribution, String bootId, String observedBootId, String dumpId, long dumpLen,
            Long resetHw, Long resetSw, String previousBoot) {
        JSONObject record = new JSONObject();
        JSONObject flags = new JSONObject();
        put(flags, "truncated", false);
        put(flags, "torn", false);
        put(flags, "tailCaptured", false);
        put(flags, "dumpGap", false);
        put(record, "v", 1);
        put(record, "incidentKey", key);
        put(record, "kind", kind);
        put(record, "reason", reason);
        put(record, "state", state);
        put(record, "attribution", attribution);
        put(record, "bootId", bootId == null ? JSONObject.NULL : bootId);
        put(record, "observedBootId", observedBootId);
        put(record, "dumpId", dumpId == null ? JSONObject.NULL : dumpId);
        put(record, "dumpLen", dumpLen);
        put(record, "resetHw", resetHw == null ? JSONObject.NULL : resetHw);
        put(record, "resetSw", resetSw == null ? JSONObject.NULL : resetSw);
        put(record, "crashUnixMs", 0);
        put(record, "flags", flags);
        put(record, "coveredFromMs", 0);
        put(record, "coveredToMs", 0);
        put(record, "traceGaps", 0);
        put(record, "createdMs", mClockMs.getAsLong());
        put(record, "collectAttempts", 0);
        put(record, "reportId", JSONObject.NULL);
        put(record, "artifacts", BesIncident.newArtifacts());
        put(record, "uploaded", false);
        // Not in the contract (additive): the boot ASG saw before this one, kept so attribution
        // can be recomputed from the validated dump text.
        put(record, "previousBootId", previousBoot == null ? JSONObject.NULL : previousBoot);
        return record;
    }

    /**
     * Freezes the TRACE window into the bundle first (before ordinary pruning can drop it), then
     * persists the record atomically. A crash in between leaves a directory without incident.json,
     * which {@link BesIncidentStore#recover()} removes; last_boot is not advanced, so the event is
     * detected again.
     */
    private boolean createWithTrace(BesIncidentStore store, JSONObject record) {
        String key = record.optString("incidentKey");
        if (store.exists(key) || !store.prepareBundleDir(key)) {
            return false;
        }
        freezeTrace(store, record, mClockMs.getAsLong());
        if (!store.create(record)) {
            store.discardBundleDir(key);
            return false;
        }
        return true;
    }

    private void freezeTrace(BesIncidentStore store, JSONObject record, long nowMs) {
        String key = record.optString("incidentKey");
        TraceFreezer.Result frozen = null;
        try {
            frozen = mFreezer.freeze(store.traceFile(key),
                    nowMs - AsgConstants.BES_TRACE_STORE_RETENTION_MS, nowMs,
                    AsgConstants.BES_INCIDENT_TRACE_MAX_BYTES);
        } catch (RuntimeException e) {
            Log.e(TAG, "TRACE freeze failed for " + key, e);
        }
        put(record, "coveredFromMs", frozen == null ? 0 : frozen.firstWallMs);
        put(record, "coveredToMs", frozen == null ? 0 : frozen.lastWallMs);
        put(record, "traceGaps", frozen == null ? 0 : frozen.gaps);
        if (frozen != null && frozen.truncated) {
            put(record, "traceTruncated", true);
        }
    }

    // ------------------------------------------------------------ pull scheduling

    private void want(String key) {
        mWanted.add(key);
        mNotBeforeMs.remove(key);
    }

    private void pump() {
        if (mTransfer != null || mWanted.isEmpty() || !mCrashPull || mSender == null) {
            return;
        }
        long now = mClockMs.getAsLong();
        long earliest = Long.MAX_VALUE;
        for (String key : new ArrayList<>(mWanted)) {
            Long notBefore = mNotBeforeMs.get(key);
            if (notBefore != null && notBefore > now) {
                earliest = Math.min(earliest, notBefore);
                continue;
            }
            if (startTransfer(key)) {
                return;
            }
            Long retryAt = mNotBeforeMs.get(key);
            if (retryAt != null) {
                earliest = Math.min(earliest, retryAt);
            }
        }
        if (earliest != Long.MAX_VALUE) {
            schedulePump(Math.max(1, earliest - now));
        }
    }

    private void schedulePump(long delayMs) {
        if (mPumpTimer != null) {
            mPumpTimer.cancel();
        }
        mPumpTimer = mScheduler.postDelayed(() -> guarded("pump", this::pump), delayMs);
    }

    /** @return true when a transfer is now running */
    private boolean startTransfer(String key) {
        BesIncidentStore store = store();
        JSONObject record = store.find(key);
        if (record == null || !BesIncident.STATE_COLLECTING.equals(record.optString("state"))) {
            mWanted.remove(key);
            return false;
        }
        long now = mClockMs.getAsLong();
        if (!mPullAllowed.getAsBoolean()) {
            mNotBeforeMs.put(key, now + AsgConstants.BES_INCIDENT_LOCK_RETRY_MS);
            return false;
        }
        boolean got;
        try {
            got = mLock.acquire(BesLogTransferLock.Owner.CRASH_CS_LOG, 0);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
        if (!got) {
            int deferrals = mDeferrals.merge(key, 1, Integer::sum);
            if (deferrals <= AsgConstants.BES_INCIDENT_LOCK_MAX_DEFERRALS) {
                mNotBeforeMs.put(key, now + AsgConstants.BES_INCIDENT_LOCK_RETRY_MS);
                return false;
            }
            mDeferrals.remove(key);
            // The channel stayed busy for the whole deferral budget: that counts as an attempt.
            countAttemptAndMaybeDrop(store, record, "channel_busy");
            return false;
        }
        mDeferrals.remove(key);

        int attempts = record.optInt("collectAttempts", 0) + 1;
        if (attempts > AsgConstants.BES_INCIDENT_COLLECT_MAX_ATTEMPTS) {
            // Earlier runs (persisted) already used the budget, e.g. the process kept dying mid-pull.
            mLock.release(BesLogTransferLock.Owner.CRASH_CS_LOG);
            mWanted.remove(key);
            store.evict(key, "collect_failed", true);
            return false;
        }
        put(record, "collectAttempts", attempts);
        if (!store.save(record)) {
            mLock.release(BesLogTransferLock.Owner.CRASH_CS_LOG);
            mNotBeforeMs.put(key, now + AsgConstants.BES_INCIDENT_LOCK_RETRY_MS);
            return false;
        }
        File partial = store.dumpPartialFile(key);
        FileOutputStream out;
        try {
            out = new FileOutputStream(partial, false);
        } catch (IOException e) {
            Log.e(TAG, "Cannot open " + partial, e);
            mLock.release(BesLogTransferLock.Owner.CRASH_CS_LOG);
            countAttemptAndMaybeDrop(store, record, "io_error");
            return false;
        }
        Transfer transfer = new Transfer(key, record.optString("dumpId"),
                record.optLong("dumpLen"), out);
        mTransfer = transfer;
        mWanted.remove(key);
        transfer.overallTimer = mScheduler.postDelayed(
                () -> guarded("overall timeout", () -> onTimeout(transfer, "overall_timeout")),
                AsgConstants.BES_INCIDENT_COLLECT_OVERALL_TIMEOUT_MS);
        armIdle(transfer, AsgConstants.BES_INCIDENT_COLLECT_FIRST_PACKET_TIMEOUT_MS);

        boolean sent;
        try {
            sent = mSender.send(csLogCommand(transfer.requestedDumpId));
        } catch (RuntimeException e) {
            Log.e(TAG, "cs_log send failed", e);
            sent = false;
        }
        Log.i(TAG, "cs_log requested for " + key + " attempt " + attempts + " sent=" + sent);
        if (!sent) {
            endTransfer(transfer, "send_failed");
        }
        return true;
    }

    static String csLogCommand(String dumpId) {
        try {
            JSONObject body = new JSONObject();
            body.put("action", 0);
            body.put("dump_id", dumpId);
            JSONObject command = new JSONObject();
            command.put("C", "cs_log");
            command.put("V", 1);
            // The BES command parser reads B as a string only.
            command.put("B", body.toString());
            return command.toString();
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    // -------------------------------------------------------------- transfer

    /** One cs_log request in flight. */
    private static final class Transfer {
        final String key;
        final String requestedDumpId;
        final long discoveredLen;
        final FileOutputStream out;
        final CRC32 crc = new CRC32();
        Cancellable idleTimer;
        Cancellable overallTimer;

        BesIncident.DumpHeader header;
        BesIncident.Trailer trailer;
        int expectedCur;
        long received;
        /** Set once the attempt can no longer succeed; packets are drained until the end packet. */
        String failure;
        /** Set when the header names a dump other than the requested one. */
        String replacedBy;
        long replacedByLen;

        Transfer(String key, String requestedDumpId, long discoveredLen, FileOutputStream out) {
            this.key = key;
            this.requestedDumpId = requestedDumpId;
            this.discoveredLen = discoveredLen;
            this.out = out;
        }
    }

    private void handleLogPacket(int cur, String body) {
        Transfer t = mTransfer;
        if (t == null) {
            return;
        }
        armIdle(t, AsgConstants.BES_INCIDENT_COLLECT_IDLE_TIMEOUT_MS);
        if (cur == END_CUR && "end".equals(body)) {
            finishTransfer(t);
            return;
        }
        if (t.failure != null || t.replacedBy != null) {
            return; // Drain: the BES keeps sending until its end packet.
        }
        if (cur != t.expectedCur) {
            t.failure = "continuity";
            return;
        }
        t.expectedCur++;
        if (body == null) {
            t.failure = "empty_packet";
            return;
        }
        if (cur == 0) {
            onHeader(t, body);
            return;
        }
        if (t.header == null || t.header.isNone()) {
            t.failure = "data_without_header";
            return;
        }
        if (t.trailer != null) {
            t.failure = "data_after_trailer";
            return;
        }
        BesIncident.Trailer trailer = BesIncident.parseTrailer(body);
        if (trailer != null) {
            t.trailer = trailer;
            return;
        }
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        if (t.received + bytes.length > AsgConstants.BES_INCIDENT_DUMP_MAX_BYTES) {
            t.failure = "too_large";
            return;
        }
        try {
            t.out.write(bytes);
        } catch (IOException e) {
            Log.e(TAG, "Writing dump.partial failed", e);
            t.failure = "io_error";
            return;
        }
        t.crc.update(bytes, 0, bytes.length);
        t.received += bytes.length;
    }

    private void onHeader(Transfer t, String body) {
        BesIncident.DumpHeader header = BesIncident.parseHeader(body);
        if (header == null) {
            t.failure = "bad_header";
            return;
        }
        t.header = header;
        if (header.isNone()) {
            return; // BES holds no dump; the end packet follows.
        }
        if (!BesIncident.isDumpId(header.dumpId)) {
            t.failure = "bad_header";
            return;
        }
        if (!header.dumpId.equals(t.requestedDumpId)) {
            // The BES names the dump it is actually sending. Discard this one, collect that one.
            t.replacedBy = header.dumpId;
            t.replacedByLen = header.len;
        }
    }

    private void onTimeout(Transfer t, String reason) {
        if (mTransfer != t) {
            return;
        }
        endTransfer(t, reason);
    }

    private void armIdle(Transfer t, long timeoutMs) {
        if (t.idleTimer != null) {
            t.idleTimer.cancel();
        }
        t.idleTimer = mScheduler.postDelayed(
                () -> guarded("idle timeout", () -> onTimeout(t, "idle_timeout")), timeoutMs);
    }

    /** The end packet arrived: validate, then STORE, replace or fail the attempt. */
    private void finishTransfer(Transfer t) {
        String failure = t.failure;
        if (failure == null && t.replacedBy == null) {
            failure = validate(t);
            if (failure == null) {
                failure = storeDump(t);
                if (failure == null) {
                    return;
                }
            }
        }
        endTransfer(t, failure);
    }

    /** Contract section 3 validation; null when the stream is exactly the discovered dump. */
    private String validate(Transfer t) {
        if (t.header == null) {
            return "no_header";
        }
        if (t.header.isNone()) {
            return "no_dump";
        }
        String crcHex = String.format("%08x", t.crc.getValue());
        String idCrc = BesIncident.dumpIdCrc(t.requestedDumpId);
        if (!t.header.crcHex.equals(idCrc) || t.header.len != t.discoveredLen) {
            return "header_mismatch";
        }
        if (t.trailer == null) {
            if (t.received != t.header.len) {
                return "length_mismatch";
            }
            return crcHex.equals(t.header.crcHex) ? null : "crc_mismatch";
        }
        if (t.trailer.total != t.discoveredLen) {
            return "trailer_total_mismatch";
        }
        if (t.received != t.trailer.sent || t.received >= t.discoveredLen) {
            return "length_mismatch";
        }
        return crcHex.equals(t.trailer.crcHex) ? null : "crc_mismatch";
    }

    /**
     * Promotes the validated partial to dump.txt and the incident to STORED.
     *
     * @return null on success (the transfer is then fully cleaned up), else why it failed
     */
    private String storeDump(Transfer t) {
        BesIncidentStore store = store();
        String key = t.key;
        File partial = store.dumpPartialFile(key);
        File dump = store.dumpFile(key);
        try {
            t.out.flush();
            t.out.getFD().sync();
            t.out.close();
        } catch (IOException e) {
            Log.e(TAG, "Syncing dump.partial failed", e);
            return "io_error";
        }
        if (dump.exists() && !dump.delete() || !partial.renameTo(dump)) {
            return "io_error";
        }
        JSONObject record = store.find(key);
        if (record == null) {
            return "record_missing";
        }
        byte[] bytes = BesIncidentStore.readBytes(dump);
        BesIncident.DumpContext ctx = BesIncident.parseDumpContext(
                bytes == null ? "" : new String(bytes, StandardCharsets.UTF_8));
        String dumpBoot = ctx.bootId != null ? ctx.bootId
                : record.isNull("bootId") ? null : record.optString("bootId");
        String previous = record.isNull("previousBootId") ? null : record.optString("previousBootId");
        JSONObject flags = record.optJSONObject("flags");
        if (flags == null) {
            flags = new JSONObject();
            put(record, "flags", flags);
        }
        put(flags, "truncated", t.trailer != null);
        // A truncated dump.txt holds only the validated prefix: keep its length and CRC so the
        // stored bytes can be checked later (dumpId covers the full stream, not this prefix).
        put(record, "dumpPrefixLen", t.trailer != null ? (Object) t.trailer.sent : JSONObject.NULL);
        put(record, "dumpPrefixCrc", t.trailer != null ? (Object) t.trailer.crcHex : JSONObject.NULL);
        put(flags, "torn", ctx.torn);
        put(flags, "tailCaptured", ctx.tailCaptured);
        put(flags, "dumpGap", ctx.tailTruncated || ctx.logLost);
        put(record, "attribution", attribute(previous, dumpBoot));
        put(record, "bootId", dumpBoot == null ? JSONObject.NULL : dumpBoot);
        put(record, "resetHw", ctx.resetHw == null ? JSONObject.NULL : ctx.resetHw);
        put(record, "resetSw", ctx.resetSw == null ? JSONObject.NULL : ctx.resetSw);
        put(record, "crashUnixMs", ctx.crashUnixMs);
        put(record, "state", BesIncident.STATE_STORED);
        if (!store.save(record)) {
            // The bundle stays COLLECTING on disk and is pulled again.
            Log.e(TAG, "Could not persist STORED record for " + key);
            return "record_write";
        }
        cancelTimers(t);
        release(t);
        mTransfer = null;
        store.markDumpCollected(record.optString("dumpId"));
        store.enforceBudget(key);
        notifyStored(key);
        pump();
        return null;
    }

    /** Ends the attempt without success; handles replaced dumps and retry bookkeeping. */
    private void endTransfer(Transfer t, String failure) {
        try {
            t.out.close();
        } catch (IOException ignored) {
            // The partial is discarded below anyway.
        }
        endTransferAlreadyClosed(t, failure);
    }

    private void endTransferAlreadyClosed(Transfer t, String failure) {
        cancelTimers(t);
        BesIncidentStore store = store();
        store.dumpPartialFile(t.key).delete();
        release(t);
        mTransfer = null;
        JSONObject record = store.find(t.key);
        if (t.replacedBy != null) {
            handleReplaced(store, record, t);
        } else if (record != null) {
            countAttemptAndMaybeDrop(store, record, failure == null ? "failed" : failure);
        }
        pump();
    }

    private void release(Transfer t) {
        mLock.release(BesLogTransferLock.Owner.CRASH_CS_LOG);
    }

    private void cancelTimers(Transfer t) {
        if (t.idleTimer != null) {
            t.idleTimer.cancel();
        }
        if (t.overallTimer != null) {
            t.overallTimer.cancel();
        }
    }

    /**
     * The BES sent a different dump than the one requested: the requested one is gone, never mark
     * it collected. Open an incident for the newly named dump and pull it.
     */
    private void handleReplaced(BesIncidentStore store, JSONObject original, Transfer t) {
        String newId = t.replacedBy;
        String observed = original == null || original.isNull("observedBootId") ? null
                : original.optString("observedBootId");
        String previous = original == null || original.isNull("previousBootId") ? null
                : original.optString("previousBootId");
        mAdvertisedDumpId = newId;
        if (original != null) {
            store.evict(t.key, "dump_replaced", false);
        }
        mWanted.remove(t.key);
        if (store.isDumpCollected(newId) || store.exists(store.dumpKey(newId))
                || t.replacedByLen <= 0) {
            return;
        }
        // Attribution is recomputed from the dump's own boot_id when it is STORED.
        JSONObject record = newRecord(store.dumpKey(newId), BesIncident.KIND_DUMP,
                BesIncident.REASON_CRASH, BesIncident.STATE_COLLECTING, BesIncident.ATTR_UNKNOWN,
                null, observed, newId, t.replacedByLen, null, null, previous);
        if (createWithTrace(store, record)) {
            want(record.optString("incidentKey"));
        }
    }

    /**
     * Counts a failed attempt that already happened (or a channel-busy budget) and either schedules
     * the retry with backoff or, when the persisted attempt limit is reached, drops the incident.
     */
    private void countAttemptAndMaybeDrop(BesIncidentStore store, JSONObject record, String why) {
        String key = record.optString("incidentKey");
        int attempts = record.optInt("collectAttempts", 0);
        if ("channel_busy".equals(why)) {
            attempts++;
            put(record, "collectAttempts", attempts);
            store.save(record);
        }
        Log.w(TAG, "Dump collection for " + key + " failed (" + why + ") after " + attempts
                + " attempt(s)");
        if (attempts >= AsgConstants.BES_INCIDENT_COLLECT_MAX_ATTEMPTS) {
            mWanted.remove(key);
            store.evict(key, "collect_failed", true);
            return;
        }
        long delay = Math.min(AsgConstants.BES_INCIDENT_COLLECT_BACKOFF_MAX_MS,
                AsgConstants.BES_INCIDENT_COLLECT_BACKOFF_BASE_MS << Math.max(0, attempts - 1));
        mWanted.add(key);
        mNotBeforeMs.put(key, mClockMs.getAsLong() + delay);
        schedulePump(delay);
    }

    private void notifyStored(String key) {
        StoredListener listener = mListener;
        if (listener == null) {
            return;
        }
        try {
            listener.onStored(key);
        } catch (RuntimeException e) {
            Log.e(TAG, "StoredListener failed for " + key, e);
        }
    }

    // ----------------------------------------------------------- diagnostics

    /** Debug snapshot (DebugBesIncidentReceiver): records, evictions and collector state. */
    public JSONObject debugSnapshot() {
        JSONObject out = new JSONObject();
        BesIncidentStore store = store();
        put(out, "crashPull", mCrashPull);
        put(out, "advertisedDumpId", mAdvertisedDumpId == null ? JSONObject.NULL : mAdvertisedDumpId);
        Transfer t = mTransfer;
        put(out, "transferring", t == null ? JSONObject.NULL : t.key);
        BesLogTransferLock.Owner owner = mLock.current();
        put(out, "lockOwner", owner == null ? JSONObject.NULL : owner.name());
        if (store != null) {
            String last = store.lastBoot();
            put(out, "lastBoot", last == null ? JSONObject.NULL : last);
            put(out, "totalBytes", store.totalBytes());
            JSONArray incidents = new JSONArray();
            for (JSONObject record : store.all()) {
                incidents.put(record);
            }
            put(out, "incidents", incidents);
            put(out, "evictions", store.evictionSummary());
        }
        return out;
    }

    // --------------------------------------------------------------- helpers

    private void guarded(String what, Runnable task) {
        try {
            task.run();
        } catch (RuntimeException e) {
            Log.e(TAG, "Collector task failed: " + what, e);
        }
    }

    private static JSONObject findObject(JSONObject json, String name) {
        JSONObject direct = json.optJSONObject(name);
        if (direct != null) {
            return direct;
        }
        Object b = json.opt("B");
        JSONObject body = null;
        if (b instanceof JSONObject) {
            body = (JSONObject) b;
        } else if (b instanceof String && !((String) b).isEmpty()) {
            try {
                body = new JSONObject((String) b);
            } catch (JSONException ignored) {
                body = null;
            }
        }
        return body == null ? null : body.optJSONObject(name);
    }

    private static boolean flag(JSONObject caps, String name) {
        return caps.optBoolean(name, false) || caps.optInt(name, 0) == 1;
    }

    private static void put(JSONObject object, String name, Object value) {
        try {
            object.put(name, value);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Collector thread for production. */
    private static final class ExecutorScheduler implements Scheduler {
        private final ScheduledThreadPoolExecutor mExecutor;

        ExecutorScheduler() {
            mExecutor = new ScheduledThreadPoolExecutor(1, runnable -> {
                Thread thread = new Thread(runnable, "bes-crash-collector");
                thread.setDaemon(true);
                return thread;
            });
            mExecutor.setRemoveOnCancelPolicy(true);
        }

        @Override
        public void post(Runnable task) {
            if (!mExecutor.isShutdown()) {
                mExecutor.execute(task);
            }
        }

        @Override
        public Cancellable postDelayed(Runnable task, long delayMs) {
            if (mExecutor.isShutdown()) {
                return () -> { };
            }
            ScheduledFuture<?> future = mExecutor.schedule(task, delayMs, TimeUnit.MILLISECONDS);
            return () -> future.cancel(false);
        }
    }
}
