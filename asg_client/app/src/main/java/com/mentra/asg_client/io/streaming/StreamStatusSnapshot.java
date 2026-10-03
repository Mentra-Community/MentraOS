package com.mentra.asg_client.io.streaming;

import org.json.JSONException;
import org.json.JSONObject;

/** Retains authoritative stream state so a phone can reconcile after missing BLE events. */
public final class StreamStatusSnapshot {
    private final String mProcessSessionId;
    private long mRevision;
    private String mStreamId;
    private boolean mTerminal = true;
    private JSONObject mStatus;

    /** Starts with a stopped snapshot, including after an ASG process restart. */
    public StreamStatusSnapshot(String processSessionId) {
        mProcessSessionId = processSessionId;
        mStatus = status("stopped");
    }

    /** Begins a command-owned session before asking Android to start the publisher service. */
    public synchronized void begin(String streamId) {
        mStreamId = streamId;
        mTerminal = false;
        mRevision++;
        mStatus = status("initializing");
    }

    /**
     * Records a publisher event independently of transport availability. Old stream ids cannot
     * replace the current snapshot, and late nonterminal callbacks cannot resurrect a stopped
     * session. Command rejections and query responses are not publisher events.
     */
    public synchronized boolean update(JSONObject event) {
        if (mStreamId == null || !mStreamId.equals(event.optString("streamId", ""))) return false;
        String state = event.optString("status", "");
        boolean retrying = "error".equals(state) && event.optBoolean("willRetry", false);
        boolean terminal = "stopped".equals(state) || "reconnect_failed".equals(state)
                || ("error".equals(state) && !retrying);
        if (mTerminal && !terminal) return false;
        try {
            JSONObject next = new JSONObject(event.toString());
            if (retrying) {
                next.put("status", "reconnecting");
                next.put("reason", event.optString("errorDetails", "Publisher reconnecting"));
            }
            // Keep the reason when the publisher follows a terminal failure with cleanup's stop.
            if ("stopped".equals(state) && mTerminal && mStatus.has("errorDetails")) {
                next.put("errorDetails", mStatus.get("errorDetails"));
            }
            mTerminal = terminal;
            mRevision++;
            mStatus = next;
            return true;
        } catch (JSONException e) {
            throw new IllegalArgumentException("Invalid stream status", e);
        }
    }

    /** Returns a defensive, session-tagged copy of the most recent authoritative state. */
    public synchronized JSONObject snapshot() {
        try {
            JSONObject result = new JSONObject(mStatus.toString());
            result.put("type", "stream_status");
            result.put("kind", "snapshot");
            result.put("sid", mProcessSessionId);
            result.put("revision", mRevision);
            result.put("terminal", mTerminal);
            String state = result.optString("status", "stopped");
            result.put("streaming", "streaming".equals(state) || "reconnected".equals(state));
            result.put("reconnecting", "reconnecting".equals(state));
            if (mStreamId != null) result.put("streamId", mStreamId);
            return result;
        } catch (JSONException e) {
            throw new IllegalStateException("Could not build stream snapshot", e);
        }
    }

    private static JSONObject status(String state) {
        try {
            return new JSONObject().put("status", state);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }
}
