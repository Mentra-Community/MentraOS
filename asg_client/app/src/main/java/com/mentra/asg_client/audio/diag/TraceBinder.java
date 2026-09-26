package com.mentra.asg_client.audio.diag;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Maps production {@link AudioTraceBus} events onto the harness operation that caused them.
 *
 * <p>Cue events carry the playback token returned by {@code playAudioAssetTracked}. Because the
 * production call emits events before it returns the token, token events are buffered until
 * {@link #bindToken}. A bridge session is keyed by its readiness {@code request_id}; the cue that
 * opened it and every cue that reused it are members. Session events (UART START, readiness,
 * grace, close) are delivered to each member once per event name and only if they happened at or
 * after that member joined, so a cue that reused an already-ready bridge never inherits the older
 * {@code i2s_ready}. Confined to the scheduler loop thread.
 */
public final class TraceBinder {

    public interface Output {
        void event(String key, long monoNs, Map<String, Object> fields);

        void anomaly(String kind, String detail, long monoNs);
    }

    /** Bound on buffered events for tokens not yet bound, so a stray producer cannot grow memory. */
    static final int MAX_PENDING_EVENTS = 256;

    private static final Set<String> TOKEN_EVENTS =
            Set.of(
                    AudioTraceBus.PLAYER_REQUEST,
                    AudioTraceBus.BRIDGE_OPEN_REQ,
                    AudioTraceBus.BRIDGE_OPEN_FAILED,
                    AudioTraceBus.BRIDGE_REUSED,
                    AudioTraceBus.PLAYER_START,
                    AudioTraceBus.PLAYER_END);
    private static final Set<String> SESSION_EVENTS =
            Set.of(
                    AudioTraceBus.UART_I2S_CMD,
                    AudioTraceBus.I2S_READY_BEGIN,
                    AudioTraceBus.I2S_READY_RX,
                    AudioTraceBus.I2S_READY,
                    AudioTraceBus.I2S_READY_TIMEOUT,
                    AudioTraceBus.GRACE_BEGIN,
                    AudioTraceBus.GRACE_CANCEL,
                    AudioTraceBus.BRIDGE_CLOSE);

    private final Output output;
    private final Map<Long, String> opByToken = new HashMap<>();
    private final Map<Long, List<Raw>> pendingByToken = new LinkedHashMap<>();
    private final Map<Integer, Session> sessions = new HashMap<>();
    private int pendingCount;

    public TraceBinder(Output output) {
        this.output = output;
    }

    public void onRaw(String event, long monoNs, Map<String, Object> fields) {
        Raw raw = new Raw(event, monoNs, fields);
        if (TOKEN_EVENTS.contains(event)) {
            long token = longField(fields, "token");
            if (token <= 0L) {
                onUnattributed(raw);
                return;
            }
            String opId = opByToken.get(token);
            if (opId != null) {
                deliverTokenEvent(opId, raw);
            } else if (pendingCount >= MAX_PENDING_EVENTS) {
                output.anomaly("pending_overflow", event + " token=" + token, monoNs);
            } else {
                pendingByToken.computeIfAbsent(token, k -> new ArrayList<>()).add(raw);
                pendingCount++;
            }
        } else if (SESSION_EVENTS.contains(event)) {
            int requestId = (int) longField(fields, "request_id");
            if (requestId == 0) return;
            Session session = sessions.computeIfAbsent(requestId, Session::new);
            session.history.add(raw);
            for (Member member : session.members) deliverSessionEvent(member, raw);
        } else if (AudioTraceBus.BRIDGE_INVALIDATED.equals(event)) {
            for (Session session : sessions.values()) {
                for (Member member : session.members) deliverSessionEvent(member, raw);
            }
        }
    }

    /** Called on the loop once a cue op's production call returned its playback token. */
    public void bindToken(long token, String opId) {
        if (token <= 0L) {
            output.anomaly("untracked_cue", opId + " returned token " + token, 0L);
            return;
        }
        String previous = opByToken.put(token, opId);
        if (previous != null && !previous.equals(opId)) {
            output.anomaly("token_rebound", token + ": " + previous + " -> " + opId, 0L);
        }
        List<Raw> pending = pendingByToken.remove(token);
        if (pending == null) return;
        pendingCount -= pending.size();
        for (Raw raw : pending) deliverTokenEvent(opId, raw);
    }

    /** Report playback no op claimed, then forget op bindings; op IDs are only unique per trial. */
    public void endTrial() {
        for (Iterator<Map.Entry<Long, List<Raw>>> it = pendingByToken.entrySet().iterator();
                it.hasNext(); ) {
            Map.Entry<Long, List<Raw>> entry = it.next();
            Raw first = entry.getValue().get(0);
            output.anomaly("foreign_playback", "token=" + entry.getKey() + " first=" + first.event, first.monoNs);
            it.remove();
        }
        pendingCount = 0;
        opByToken.clear();
        sessions.clear();
    }

    private void onUnattributed(Raw raw) {
        if (AudioTraceBus.BRIDGE_OPEN_REQ.equals(raw.event)) {
            // An overlay or camera prep opened the bridge; keep its session so later events for it
            // are recognized, but it has no members.
            int requestId = (int) longField(raw.fields, "request_id");
            if (requestId != 0) sessions.computeIfAbsent(requestId, Session::new);
        }
        output.anomaly("unattributed_" + raw.event, String.valueOf(raw.fields), raw.monoNs);
    }

    private void deliverTokenEvent(String opId, Raw raw) {
        switch (raw.event) {
            case AudioTraceBus.BRIDGE_OPEN_REQ:
            case AudioTraceBus.BRIDGE_REUSED:
                emit(opId, raw.event, raw);
                join(opId, raw);
                break;
            case AudioTraceBus.PLAYER_END:
                emit(opId, "end", raw);
                String reason = String.valueOf(raw.fields.get("reason"));
                if (!"null".equals(reason)) emit(opId, reason, raw);
                break;
            default:
                emit(opId, raw.event, raw);
                break;
        }
    }

    private void join(String opId, Raw raw) {
        int requestId = (int) longField(raw.fields, "request_id");
        if (requestId == 0) return;
        Session session = sessions.computeIfAbsent(requestId, Session::new);
        Member member = new Member(opId, raw.monoNs);
        session.members.add(member);
        for (Raw past : new ArrayList<>(session.history)) deliverSessionEvent(member, past);
    }

    private void deliverSessionEvent(Member member, Raw raw) {
        if (raw.monoNs < member.joinNs) return;
        if (!member.delivered.add(raw.event)) return;
        emit(member.opId, raw.event, raw);
    }

    private void emit(String opId, String name, Raw raw) {
        output.event(opId + "." + name, raw.monoNs, raw.fields);
    }

    static long longField(Map<String, Object> fields, String key) {
        Object value = fields == null ? null : fields.get(key);
        if (value instanceof Number) return ((Number) value).longValue();
        if (value instanceof String) {
            try {
                return Long.parseLong((String) value);
            } catch (NumberFormatException ignored) {
                return 0L;
            }
        }
        return 0L;
    }

    private static final class Raw {
        final String event;
        final long monoNs;
        final Map<String, Object> fields;

        Raw(String event, long monoNs, Map<String, Object> fields) {
            this.event = event;
            this.monoNs = monoNs;
            this.fields = fields == null ? new HashMap<>() : fields;
        }
    }

    private static final class Session {
        final int requestId;
        final List<Member> members = new ArrayList<>();
        final List<Raw> history = new ArrayList<>();

        Session(int requestId) {
            this.requestId = requestId;
        }
    }

    private static final class Member {
        final String opId;
        final long joinNs;
        final Set<String> delivered = new HashSet<>();

        Member(String opId, long joinNs) {
            this.opId = opId;
            this.joinNs = joinNs;
        }
    }
}
