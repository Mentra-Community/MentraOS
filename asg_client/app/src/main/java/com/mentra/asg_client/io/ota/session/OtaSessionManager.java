package com.mentra.asg_client.io.ota.session;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.UUID;

public class OtaSessionManager {
    private static final String TAG = "OtaSessionManager";
    private static final String PREFS_NAME = "ota_session";
    private static final String KEY_SESSION_DATA = "ota_session_data";
    /**
     * SharedPrefs key for the APK-done signal that must be sent on the next phone reconnect.
     * Stored as a string: "step_complete" (more steps remain) or "complete" (APK-only session).
     * Set by OtaService.resumeFromSession() and consumed by OtaHelper.onPhoneConnected().
     */
    private static final String KEY_PENDING_APK_STATUS = "pending_apk_status";
    private static final long SESSION_EXPIRY_MS = 30 * 60 * 1000L;
    /**
     * Cooldown after APK install before auto-resuming the next OTA step (MTK/BES).
     * Spec: docs/ota-rearchitecture-spec.md §A / EC-5 — ~10s from process start so the old process can exit.
     * Must not reuse {@link #SESSION_EXPIRY_MS} (that is idle-session staleness, not restart pacing).
     */
    private static final long APK_RESTART_GUARD_MS = 10_000L;

    private final SharedPreferences mPrefs;

    private String mSessionId;
    private int mTotalSteps;
    private JSONArray mStepSequence;
    private int mCurrentStepIndex;
    private String mCurrentPhase;
    private int mStepPercent;
    private String mStatus;
    private String mErrorMessage;
    private String mVersionJsonUrl;
    private long mLastActivityAtElapsed;
    private long mRestartingSinceElapsed;

    private int mLastPersistedPercent;

    public OtaSessionManager(Context context) {
        mPrefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        load();
    }

    public synchronized boolean createSession(String[] stepSequence, String versionJsonUrl) {
        // Defensive: a session with no steps is meaningless (and would later divide-by-zero
        // in computeOverallPercent / computeStepWeights). Refuse to create one and let the
        // caller decide how to recover (typically by skipping OTA entirely).
        if (stepSequence == null || stepSequence.length == 0) {
            Log.w(TAG, "createSession refused: stepSequence is null or empty");
            return false;
        }
        for (String step : stepSequence) {
            if (step == null || step.isEmpty()) {
                Log.w(TAG, "createSession refused: stepSequence contains null/empty entry");
                return false;
            }
        }
        if ("in_progress".equals(mStatus) || "step_complete".equals(mStatus)) {
            if (hasActiveSession()) {
                return false;
            }
        }
        if ("failed".equals(mStatus) || "complete".equals(mStatus)) {
            clear();
        }

        mSessionId = UUID.randomUUID().toString().substring(0, 8);
        mTotalSteps = stepSequence.length;
        mStepSequence = new JSONArray();
        for (String step : stepSequence) {
            mStepSequence.put(step);
        }
        mCurrentStepIndex = 0;
        mCurrentPhase = "download";
        mStepPercent = 0;
        mStatus = "in_progress";
        mErrorMessage = null;
        mVersionJsonUrl = versionJsonUrl;
        mLastActivityAtElapsed = SystemClock.elapsedRealtime();
        mRestartingSinceElapsed = -1;
        mLastPersistedPercent = 0;
        persist();
        Log.i(TAG, "Created session " + mSessionId + " with " + mTotalSteps + " steps");
        return true;
    }

    public synchronized boolean hasActiveSession() {
        if (mSessionId == null || mStatus == null) {
            return false;
        }
        if ("failed".equals(mStatus) || "complete".equals(mStatus) || "idle".equals(mStatus)) {
            return false;
        }
        long now = SystemClock.elapsedRealtime();
        // Skip expiry check during APK restart path — but cap how long we trust it. Without
        // a cap, a stuck restart guard would keep the session "active" forever and prevent
        // any future OTA from even creating a session. SESSION_EXPIRY_MS (30 min) is safe:
        // APK_RESTART_GUARD_MS is only ~10s, so any restarting marker still set after this
        // is effectively a leak.
        if (mRestartingSinceElapsed >= 0) {
            if (now < mRestartingSinceElapsed
                    || (now - mRestartingSinceElapsed) <= SESSION_EXPIRY_MS) {
                return true;
            }
            Log.w(TAG, "Restart guard exceeded SESSION_EXPIRY_MS — treating as stale and clearing");
            clear();
            return false;
        }
        // elapsedRealtime resets on reboot — if now < last activity, device rebooted
        if (now < mLastActivityAtElapsed || (now - mLastActivityAtElapsed) > SESSION_EXPIRY_MS) {
            Log.w(TAG, "Session expired, clearing");
            clear();
            return false;
        }
        return true;
    }

    public synchronized String getStatus() {
        if (mStatus == null) return "idle";
        return mStatus;
    }

    /**
     * Builds the JSON payload sent to the phone via BLE as an {@code ota_status} message.
     *
     * Key names are intentionally abbreviated to keep the payload small — the K900 serial/BLE
     * path drops packets that exceed its buffer limit. The phone (MentraLive.java) reads both
     * the short and legacy verbose names so older firmware still works.
     *
     * Abbreviation map:
     *   sid = session_id       ts  = total_steps      cs  = current_step
     *   st  = step_type        sq  = step_sequence     sp  = step_percent
     *   op  = overall_percent  err = error_message
     *
     * {@code error_message} is omitted entirely when null — the phone defaults to null via
     * {@code optString("err", null)}, so an explicit null key is unnecessary overhead.
     */
    public synchronized JSONObject getSessionState() {
        if (mSessionId == null) return null;
        // Drop stale sessions (idle > SESSION_EXPIRY_MS). We deliberately do NOT short-circuit
        // on terminal status here — callers may still need to read the final "complete" or
        // "failed" snapshot to send it to the phone. We only suppress the snapshot when the
        // session is well past its idle deadline AND not in restart guard.
        if (mRestartingSinceElapsed < 0) {
            long now = SystemClock.elapsedRealtime();
            if (mLastActivityAtElapsed > 0
                    && (now < mLastActivityAtElapsed
                        || (now - mLastActivityAtElapsed) > SESSION_EXPIRY_MS)) {
                Log.w(TAG, "getSessionState: session expired, clearing");
                clear();
                return null;
            }
        }
        try {
            JSONObject state = new JSONObject();
            state.put("sid", mSessionId);
            state.put("ts", mTotalSteps);
            state.put("cs", mCurrentStepIndex + 1);
            state.put("st", getStepType(mCurrentStepIndex));
            state.put("sq", mStepSequence != null ? mStepSequence : new JSONArray());
            state.put("phase", mCurrentPhase);
            state.put("sp", mStepPercent);
            state.put("op", computeOverallPercent());
            state.put("status", mStatus);
            if (mErrorMessage != null) {
                state.put("err", mErrorMessage);
            }
            return state;
        } catch (JSONException e) {
            Log.e(TAG, "Failed to build session state JSON", e);
            return null;
        }
    }

    public synchronized void advanceStep(int stepIndex, String phase) {
        mCurrentStepIndex = stepIndex;
        mCurrentPhase = phase;
        mStepPercent = 0;
        mLastPersistedPercent = 0;
        mLastActivityAtElapsed = SystemClock.elapsedRealtime();
        persist();
    }

    public synchronized void updateProgress(int stepPercent) {
        // Reject progress writes once we're in a terminal state — otherwise a stray late
        // PROGRESS event from a finished step can flip the UI back to "in progress" or
        // overwrite a clean "complete"/"failed" snapshot with a partial percent.
        if ("complete".equals(mStatus) || "failed".equals(mStatus)) {
            return;
        }
        // Defensive clamp — callers occasionally feed us 101+ from rounding or -1 from
        // unknown content-length math. Persisting a value outside [0,100] can corrupt the
        // weighted overall_percent calculation below.
        int clamped = stepPercent;
        if (clamped < 0) clamped = 0;
        else if (clamped > 100) clamped = 100;

        mLastActivityAtElapsed = SystemClock.elapsedRealtime();
        mStepPercent = clamped;
        if (Math.abs(clamped - mLastPersistedPercent) >= 5) {
            mLastPersistedPercent = clamped;
            persist();
        }
    }

    public synchronized void setFailed(String errorMessage) {
        mStatus = "failed";
        mErrorMessage = errorMessage;
        mLastActivityAtElapsed = SystemClock.elapsedRealtime();
        persist();
        Log.e(TAG, "Session failed: " + errorMessage);
    }

    public synchronized void setComplete() {
        mStatus = "complete";
        mStepPercent = 100;
        mLastActivityAtElapsed = SystemClock.elapsedRealtime();
        persist();
        Log.i(TAG, "Session complete: " + mSessionId);
    }

    public synchronized void setRestarting() {
        mRestartingSinceElapsed = SystemClock.elapsedRealtime();
        persist();
        Log.i(TAG, "Session marked as restarting");
    }

    public synchronized boolean isInRestartGuard() {
        return mRestartingSinceElapsed >= 0;
    }

    public synchronized long getRestartGuardRemainingMs() {
        if (mRestartingSinceElapsed < 0) return 0;
        long now = SystemClock.elapsedRealtime();
        // After reboot, elapsedRealtime resets — wait one full short guard for stack to settle
        long remaining;
        if (now < mRestartingSinceElapsed) {
            remaining = APK_RESTART_GUARD_MS;
        } else {
            long elapsed = now - mRestartingSinceElapsed;
            remaining = Math.max(0, APK_RESTART_GUARD_MS - elapsed);
        }
        return remaining;
    }

    public synchronized void clearRestartGuard() {
        mRestartingSinceElapsed = -1;
        persist();
    }

    /**
     * Persists the APK step completion status so it can be sent the next time the phone
     * connects via BLE. Must be called BEFORE advancing/completing the session so that
     * {@link #buildApkDoneJson} can still read the correct session fields.
     *
     * @param status "step_complete" if more OTA steps follow; "complete" for APK-only sessions.
     */
    public void setPendingApkStatus(String status) {
        mPrefs.edit().putString(KEY_PENDING_APK_STATUS, status).apply();
        Log.i(TAG, "Pending APK status queued for next phone reconnect: " + status);
    }

    /**
     * Retrieves and clears the pending APK status. Returns null if none is queued.
     * Intended to be called from OtaHelper.onPhoneConnected().
     */
    public String consumePendingApkStatus() {
        String status = mPrefs.getString(KEY_PENDING_APK_STATUS, null);
        if (status != null) {
            mPrefs.edit().remove(KEY_PENDING_APK_STATUS).apply();
            Log.i(TAG, "Consumed pending APK status: " + status);
        }
        return status;
    }

    /**
     * Builds the {@code ota_status} JSON representing the just-completed APK step.
     * Uses the persisted session fields so the signal carries correct session context
     * even after the process has restarted.
     *
     * @param status "step_complete" or "complete"
     */
    public synchronized JSONObject buildApkDoneJson(String status) {
        try {
            int[] weights = computeStepWeights();
            int apkWeight = weights.length > 0 ? weights[0] : 100;
            int op = "step_complete".equals(status) ? apkWeight : 100;

            JSONObject json = new JSONObject();
            json.put("sid", mSessionId != null ? mSessionId : "");
            json.put("ts", mTotalSteps);
            json.put("cs", 1); // APK is always the first step (index 0, reported as 1)
            json.put("st", "apk");
            json.put("sq", mStepSequence != null ? mStepSequence : new JSONArray());
            json.put("phase", "install");
            json.put("sp", 100);
            json.put("op", op);
            json.put("status", status);
            json.put("type", "ota_status");
            return json;
        } catch (JSONException e) {
            Log.e(TAG, "Failed to build APK done JSON", e);
            return null;
        }
    }

    public synchronized void clear() {
        mSessionId = null;
        mTotalSteps = 0;
        mStepSequence = new JSONArray();
        mCurrentStepIndex = 0;
        mCurrentPhase = "download";
        mStepPercent = 0;
        mStatus = null;
        mErrorMessage = null;
        mVersionJsonUrl = null;
        mLastActivityAtElapsed = 0;
        mRestartingSinceElapsed = -1;
        mLastPersistedPercent = 0;
        mPrefs.edit().remove(KEY_SESSION_DATA).apply();
    }

    public synchronized String getStepType(int index) {
        if (mStepSequence == null || index < 0 || index >= mStepSequence.length()) {
            return null;
        }
        try {
            return mStepSequence.getString(index);
        } catch (JSONException e) {
            return null;
        }
    }

    public synchronized int getTotalSteps() {
        return mTotalSteps;
    }

    public synchronized int getCurrentStepIndex() {
        return mCurrentStepIndex;
    }

    public synchronized String getCurrentPhase() {
        return mCurrentPhase;
    }

    public synchronized String getVersionJsonUrl() {
        return mVersionJsonUrl;
    }

    /**
     * Compute a weighted overall OTA progress percentage (0–100) that accounts for
     * the relative cost of each step type.
     *
     * Weight table (based on which step types are present in the session):
     *   [apk, mtk, bes] → 20 / 30 / 50
     *   [apk, bes]       → 20 / 80
     *   [apk, mtk]       → 20 / 80
     *   [mtk, bes]       → 40 / 60
     *   [bes]            → 100
     *   [mtk]            → 100
     *   [apk]            → 100
     *
     * Within each step, stepPercent (0–100) maps linearly to that step's weight.
     * APK install has no granular progress (process kill) so it jumps 0→100 instantly,
     * but its small fixed weight (20%) means the jump is acceptable.
     *
     * NOTE: BES progress that arrives via sr_adota on the phone side bypasses this
     * method. The MentraLive sr_adota handler must apply the same weight table when
     * computing the overall_percent it sends to the frontend.
     */
    private int computeOverallPercent() {
        if (mTotalSteps == 0 || mStepSequence == null) return 0;

        int[] weights = computeStepWeights();

        double completed = 0;
        for (int i = 0; i < mCurrentStepIndex && i < weights.length; i++) {
            completed += weights[i];
        }

        int currentWeight = (mCurrentStepIndex < weights.length) ? weights[mCurrentStepIndex] : 0;
        completed += currentWeight * mStepPercent / 100.0;

        return (int) Math.min(100, Math.max(0, completed));
    }

    /**
     * Assign a percentage weight to each step based on which step types are present.
     * The returned array has one entry per step in {@link #mStepSequence}, in order.
     */
    private int[] computeStepWeights() {
        boolean hasApk = false, hasMtk = false, hasBes = false;
        for (int i = 0; i < mTotalSteps; i++) {
            String t = getStepType(i);
            if ("apk".equals(t)) hasApk = true;
            else if ("mtk".equals(t)) hasMtk = true;
            else if ("bes".equals(t)) hasBes = true;
        }

        int apkW, mtkW, besW;
        if (hasApk && hasMtk && hasBes) {
            apkW = 20; mtkW = 30; besW = 50;
        } else if (hasApk && hasBes) {
            apkW = 20; mtkW = 0;  besW = 80;
        } else if (hasApk && hasMtk) {
            apkW = 20; mtkW = 80; besW = 0;
        } else if (hasMtk && hasBes) {
            apkW = 0;  mtkW = 40; besW = 60;
        } else if (hasBes) {
            apkW = 0;  mtkW = 0;  besW = 100;
        } else if (hasMtk) {
            apkW = 0;  mtkW = 100; besW = 0;
        } else {
            apkW = 100; mtkW = 0; besW = 0;
        }

        int[] weights = new int[mTotalSteps];
        for (int i = 0; i < mTotalSteps; i++) {
            String t = getStepType(i);
            if ("apk".equals(t)) weights[i] = apkW;
            else if ("mtk".equals(t)) weights[i] = mtkW;
            else if ("bes".equals(t)) weights[i] = besW;
            else weights[i] = 100 / mTotalSteps; // fallback for unknown types
        }
        return weights;
    }

    /**
     * Returns the base overall_percent at the start of the BES step, using the same
     * weight table as {@link #computeOverallPercent}. Used by MentraLive's sr_adota
     * handler to compute the correct weighted overall_percent for BES progress events
     * that arrive directly from the BES chip over BLE (bypassing the glasses session).
     *
     * @param totalSteps   total number of OTA steps in this session
     * @param stepSequence JSON array of step type strings (e.g. ["apk","bes"])
     * @return base percentage (0–100) at the start of the BES install phase
     */
    public static int computeBesOverallBase(int totalSteps, org.json.JSONArray stepSequence) {
        boolean hasApk = false, hasMtk = false, hasBes = false;
        for (int i = 0; i < totalSteps; i++) {
            String t = stepSequence.optString(i, "");
            if ("apk".equals(t)) hasApk = true;
            else if ("mtk".equals(t)) hasMtk = true;
            else if ("bes".equals(t)) hasBes = true;
        }

        int apkW, mtkW;
        if (hasApk && hasMtk && hasBes) {
            apkW = 20; mtkW = 30;
        } else if (hasApk && hasBes) {
            apkW = 20; mtkW = 0;
        } else if (hasMtk && hasBes) {
            apkW = 0;  mtkW = 40;
        } else {
            apkW = 0;  mtkW = 0;
        }

        // Base = weight of all steps that precede BES
        int base = 0;
        for (int i = 0; i < totalSteps; i++) {
            String t = stepSequence.optString(i, "");
            if ("bes".equals(t)) break;
            if ("apk".equals(t)) base += apkW;
            else if ("mtk".equals(t)) base += mtkW;
        }
        return base;
    }

    /**
     * Returns the weight allocated to the BES step, using the same weight table.
     * Companion to {@link #computeBesOverallBase}.
     */
    public static int computeBesOverallWeight(int totalSteps, org.json.JSONArray stepSequence) {
        boolean hasApk = false, hasMtk = false, hasBes = false;
        for (int i = 0; i < totalSteps; i++) {
            String t = stepSequence.optString(i, "");
            if ("apk".equals(t)) hasApk = true;
            else if ("mtk".equals(t)) hasMtk = true;
            else if ("bes".equals(t)) hasBes = true;
        }
        if (!hasBes) return 0;
        if (hasApk && hasMtk) return 50;
        if (hasApk || hasMtk) return 80;
        return 100; // bes only
    }

    private void persist() {
        try {
            JSONObject json = new JSONObject();
            json.put("session_id", mSessionId != null ? mSessionId : JSONObject.NULL);
            json.put("total_steps", mTotalSteps);
            json.put("step_sequence", mStepSequence != null ? mStepSequence : new JSONArray());
            json.put("current_step_index", mCurrentStepIndex);
            json.put("current_phase", mCurrentPhase);
            json.put("step_percent", mStepPercent);
            json.put("status", mStatus != null ? mStatus : JSONObject.NULL);
            json.put("error_message", mErrorMessage != null ? mErrorMessage : JSONObject.NULL);
            json.put("version_json_url", mVersionJsonUrl != null ? mVersionJsonUrl : JSONObject.NULL);
            json.put("last_activity_at_elapsed", mLastActivityAtElapsed);
            json.put("restarting_since_elapsed", mRestartingSinceElapsed);
            mPrefs.edit().putString(KEY_SESSION_DATA, json.toString()).apply();
        } catch (JSONException e) {
            Log.e(TAG, "Failed to persist session", e);
        }
    }

    private void load() {
        String data = mPrefs.getString(KEY_SESSION_DATA, null);
        if (data == null) {
            mStepSequence = new JSONArray();
            mRestartingSinceElapsed = -1;
            return;
        }
        try {
            JSONObject json = new JSONObject(data);
            mSessionId = json.isNull("session_id") ? null : json.optString("session_id", null);
            mTotalSteps = json.optInt("total_steps", 0);
            mStepSequence = json.optJSONArray("step_sequence");
            if (mStepSequence == null) mStepSequence = new JSONArray();
            mCurrentStepIndex = json.optInt("current_step_index", 0);
            mCurrentPhase = json.optString("current_phase", "download");
            mStepPercent = json.optInt("step_percent", 0);
            mStatus = json.isNull("status") ? null : json.optString("status", null);
            mErrorMessage = json.isNull("error_message") ? null : json.optString("error_message", null);
            mVersionJsonUrl = json.isNull("version_json_url") ? null : json.optString("version_json_url", null);
            mLastActivityAtElapsed = json.optLong("last_activity_at_elapsed", 0);
            mRestartingSinceElapsed = json.optLong("restarting_since_elapsed", -1);
            mLastPersistedPercent = mStepPercent;
        } catch (JSONException e) {
            Log.e(TAG, "Failed to load session", e);
            mStepSequence = new JSONArray();
            mRestartingSinceElapsed = -1;
        }
    }
}
