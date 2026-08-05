package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import android.util.Log;

import java.util.ArrayDeque;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * Single owner of the ASG-to-BES UART transport link state.
 *
 * <p>Historically "connected" was five separate implicit facts spread across volatile booleans in
 * {@code K900BluetoothManager} ({@code isSerialOpen}, the {@code lastSrSyvrTime} liveness aspect,
 * and the negotiated {@code besWireCaps*} flags), each with its own ad-hoc reset sites. Listeners
 * that registered after the only edge of one of those facts never learned about it, which is the
 * bug class this class exists to remove. All transport-side facts now live here, transitions are
 * driven from the exact call sites that used to flip the booleans, and {@link #addListener}
 * synchronously replays the current state so late subscribers can never miss an edge.
 *
 * <p>The link is modeled as a three-step ladder:
 *
 * <pre>
 *   SERIAL_CLOSED  --serialReady()-->  SERIAL_OPEN  --srSyvrParsed()-->  LINK_PROVEN
 * </pre>
 *
 * with two demotions: {@link #streamDiscontinuity()} (a reopen/baud switch invalidated the byte
 * stream, so the link is no longer proven at the current baud) drops back to {@code SERIAL_OPEN},
 * and {@link #serialClosed()} resets everything.
 *
 * <p>A failed coordinator-owned reopen uses {@link #serialUnavailable()}: the physical state is
 * {@code SERIAL_CLOSED}, but negotiated caps and phone presence survive because recovery still
 * belongs to the same BES and phone sessions. A terminal {@link #serialClosed()} remains the only
 * full reset.
 *
 * <p>Orthogonal to the ladder, {@link PhonePresence} tracks whether the BES currently holds a phone
 * BLE connection (see the enum Javadoc for the firmware contract and the tri-state degradation rule
 * for old firmware).
 *
 * <p>Caps have two views on purpose:
 *
 * <ul>
 *   <li>{@link #getProvenCaps()} (also the listener payload) is non-null only in {@code
 *       LINK_PROVEN}: it is the snapshot a consumer may trust because an sr_syvr proved the link at
 *       the current baud.
 *   <li>{@link #getNegotiatedCaps()} is the sticky negotiation result, cleared only by {@link
 *       #serialClosed()}. This mirrors the legacy reset rules exactly: a mid-session baud reopen
 *       never cleared {@code besWireCaps*}, and outbound capability decisions (binary relay, file
 *       payload v2, push window) must not silently downgrade for a whole phone session just because
 *       a reopen window was in flight. The legacy delegating getters read this view.
 * </ul>
 *
 * <p>Thread safety: transitions arrive from the serial RX thread, the baud-switch executor, and
 * binder threads. All state mutation and listener notification happen under the internal monitor,
 * and deliveries go through a FIFO dispatch queue (reentrant transitions from inside a callback are
 * queued behind the pass in flight), so every listener observes transitions in a single global
 * order — always ending on the machine's final state — and replay-on-subscribe cannot interleave
 * with a concurrent transition. Listeners must therefore be fast and must not block on locks that
 * transition callers might hold.
 */
public final class LinkStateMachine {

    /** Transport-side link states, ordered from least to most established. */
    public enum LinkState {
        /** The UART serial port is not open (boot, failed open, or after close). */
        SERIAL_CLOSED,
        /** The serial port is open but the BES has not answered at the current baud. */
        SERIAL_OPEN,
        /** An sr_syvr reply was parsed at the current baud: the link is proven alive. */
        LINK_PROVEN
    }

    /**
     * BES-reported phone BLE presence, orthogonal to the UART ladder. Firmware >= 17.26.7.23
     * reports edges spontaneously ({@code sr_phble}) and syncs the current value in every {@code
     * sr_syvr} reply ({@code phone_ble}). Older firmware sends neither, so presence is a tri-state:
     * it stays {@code UNKNOWN} until a signal arrives and every consumer must degrade gracefully on
     * {@code UNKNOWN}.
     */
    public enum PhonePresence {
        /** No presence signal since the last reset (old BES firmware, boot, or BES reboot). */
        UNKNOWN,
        /** The BES reported a phone BLE connection (first CCC enable). */
        PRESENT,
        /** The BES reported the phone BLE link down. */
        ABSENT
    }

    /**
     * Immutable snapshot of the wire capabilities negotiated with the BES. Instances are values:
     * mutation happens by replacing the machine's current snapshot, never in place.
     */
    public static final class BesCaps {
        /** No capabilities negotiated: the state before any BES advertisement. */
        public static final BesCaps NONE =
                new BesCaps(false, false, false, false, BesWireFormat.PROTOCOL_VERSION_V1, 0);

        /** BES accepts little-endian K900 STRING lengths (wire_caps.k900_le). */
        public final boolean k900Le;

        /** BES relays the binary wire protocol (wire_caps.binary or an observed binary frame). */
        public final boolean binary;

        /** BES supports negotiated file payload sizes (wire_caps.file_payload_v2). */
        public final boolean filePayloadV2;

        /** BES accepts large file packs (advertised together with file_payload_v2). */
        public final boolean bigPacks;

        /** Highest wire protocol version the BES advertised. */
        public final int proto;

        /**
         * Maximum complete notification payload the BES guarantees across every bearer it may
         * select. 0 means the firmware did not advertise the capability or the cached value was
         * invalidated. The value remains phone-session-scoped for compatibility with older BES
         * firmware that derived it from the current ATT MTU.
         */
        public final int notifyCap;

        public BesCaps(
                boolean k900Le,
                boolean binary,
                boolean filePayloadV2,
                boolean bigPacks,
                int proto,
                int notifyCap) {
            this.k900Le = k900Le;
            this.binary = binary;
            this.filePayloadV2 = filePayloadV2;
            this.bigPacks = bigPacks;
            this.proto = proto;
            this.notifyCap = notifyCap;
        }

        /**
         * Merge an sr_syvr wire_caps advertisement into this snapshot using the legacy accrual
         * rules: flags only ever turn on, {@code proto} is overwritten only when the advertisement
         * carries the binary flag (an advertisement without {@code binary} says nothing about the
         * protocol version), and {@code notifyCap} takes the newest advertised value (it tracks the
         * CURRENT negotiated ATT MTU, which can renegotiate per phone session) while an absent
         * advertisement keeps the previous one.
         */
        BesCaps mergeAdvertised(BesCaps advertised) {
            return new BesCaps(
                    k900Le || advertised.k900Le,
                    binary || advertised.binary,
                    filePayloadV2 || advertised.filePayloadV2,
                    bigPacks || advertised.bigPacks,
                    advertised.binary ? advertised.proto : proto,
                    advertised.notifyCap > 0 ? advertised.notifyCap : notifyCap);
        }

        /**
         * Drop the cached notify_cap: a phone BLE session boundary or a BES reboot made the
         * MTU-derived value stale. Invalidated behaves exactly like never-advertised (the tri-state
         * degradation rule), until a fresh wire_caps advertisement re-arms it.
         */
        BesCaps withoutNotifyCap() {
            return notifyCap == 0
                    ? this
                    : new BesCaps(k900Le, binary, filePayloadV2, bigPacks, proto, 0);
        }

        /**
         * Record that a valid binary wire frame arrived: proof of binary relay support even when
         * the BES never advertised it, with the protocol floored at v2.
         */
        BesCaps withBinaryRelayObserved() {
            return new BesCaps(
                    k900Le,
                    true,
                    filePayloadV2,
                    bigPacks,
                    Math.max(proto, BesWireFormat.PROTOCOL_VERSION_V2),
                    notifyCap);
        }

        @Override
        public boolean equals(Object o) {
            if (this == o) {
                return true;
            }
            if (!(o instanceof BesCaps)) {
                return false;
            }
            BesCaps other = (BesCaps) o;
            return k900Le == other.k900Le
                    && binary == other.binary
                    && filePayloadV2 == other.filePayloadV2
                    && bigPacks == other.bigPacks
                    && proto == other.proto
                    && notifyCap == other.notifyCap;
        }

        @Override
        public int hashCode() {
            return Objects.hash(k900Le, binary, filePayloadV2, bigPacks, proto, notifyCap);
        }

        @Override
        public String toString() {
            return "BesCaps{k900Le="
                    + k900Le
                    + ", binary="
                    + binary
                    + ", filePayloadV2="
                    + filePayloadV2
                    + ", bigPacks="
                    + bigPacks
                    + ", proto="
                    + proto
                    + ", notifyCap="
                    + notifyCap
                    + "}";
        }
    }

    /** Observer of link state transitions. */
    public interface Listener {
        /**
         * Called under the machine's monitor on every observable change, and synchronously from
         * {@link #addListener} with the current state. Transitions are delivered in one global FIFO
         * order: a transition performed from inside a callback is queued behind the pass in flight,
         * so every listener's LAST observation always matches the machine's final state. A thrown
         * exception is logged and does not affect other listeners or the caller.
         *
         * @param state the link state at the time of the transition being delivered
         * @param provenCaps the trusted caps snapshot; non-null exactly when {@code state} is
         *     {@link LinkState#LINK_PROVEN}
         * @param phonePresence the BES-reported phone BLE presence at the time of the transition
         */
        void onLinkStateChanged(LinkState state, BesCaps provenCaps, PhonePresence phonePresence);
    }

    /** One queued delivery: the state snapshot at transition time plus its audience. */
    private static final class Notification {
        final LinkState state;
        final BesCaps provenCaps;
        final PhonePresence phonePresence;
        final List<Listener> audience;

        Notification(
                LinkState state,
                BesCaps provenCaps,
                PhonePresence phonePresence,
                List<Listener> audience) {
            this.state = state;
            this.provenCaps = provenCaps;
            this.phonePresence = phonePresence;
            this.audience = audience;
        }
    }

    private static final String TAG = "LinkStateMachine";

    // Copy-on-write so a listener may add/remove listeners from inside a callback without
    // corrupting the iteration that is notifying it.
    private final List<Listener> listeners = new CopyOnWriteArrayList<>();

    // FIFO dispatch queue (guarded by the monitor): transitions performed from inside a listener
    // callback are enqueued behind the pass currently being delivered instead of nesting.
    private final ArrayDeque<Notification> pendingNotifications = new ArrayDeque<>();
    private boolean dispatching = false;

    private LinkState state = LinkState.SERIAL_CLOSED;
    private BesCaps negotiatedCaps = BesCaps.NONE;
    private PhonePresence phonePresence = PhonePresence.UNKNOWN;

    /**
     * Register a listener and synchronously replay the current state to it. Replay-on-subscribe is
     * the core contract: a subscriber that arrives after the only serialReady/srSyvr edge still
     * observes the state it missed, instead of waiting forever for an edge that already happened.
     */
    public synchronized void addListener(Listener listener) {
        if (listener == null || listeners.contains(listener)) {
            return;
        }
        listeners.add(listener);
        // Replay the CURRENT state directly, not through the queue: the state field always
        // reflects every transition already performed (only their deliveries can lag), and queued
        // passes snapshot their audience at transition time, so this listener will never also
        // receive an older pass after this newer replay.
        deliverSafely(listener, state, provenCapsLocked(), phonePresence);
    }

    /** Unregister a listener; no-op if it was never added. */
    public synchronized void removeListener(Listener listener) {
        listeners.remove(listener);
    }

    /** Current link state. */
    public synchronized LinkState getState() {
        return state;
    }

    /** Whether the serial port is open (i.e. the state is past {@code SERIAL_CLOSED}). */
    public synchronized boolean isSerialOpen() {
        return state != LinkState.SERIAL_CLOSED;
    }

    /**
     * The trusted caps snapshot: non-null exactly in {@code LINK_PROVEN}. Consumers that must not
     * act on unproven capabilities read this view.
     */
    public synchronized BesCaps getProvenCaps() {
        return provenCapsLocked();
    }

    /**
     * The sticky negotiation result, cleared only when the serial port closes. Never null. This
     * intentionally survives {@link #streamDiscontinuity()}: reopen windows are byte-stream
     * discontinuities, not renegotiations, and the legacy {@code besWireCaps*} booleans survived
     * them too — outbound capability decisions must not flip mid-session (see class Javadoc).
     */
    public synchronized BesCaps getNegotiatedCaps() {
        return negotiatedCaps;
    }

    /**
     * BES-reported phone BLE presence. {@code UNKNOWN} until the BES sends a signal (sr_phble edge
     * or the phone_ble field of an sr_syvr reply) — which old firmware never does, so consumers
     * must treat {@code UNKNOWN} as "no trustworthy phone link".
     */
    public synchronized PhonePresence getPhonePresence() {
        return phonePresence;
    }

    /**
     * The serial port opened (onSerialReady / successful onSerialOpen). Promotes {@code
     * SERIAL_CLOSED} to {@code SERIAL_OPEN}; a redundant ready on an already-open link changes
     * nothing.
     */
    public void serialReady() {
        synchronized (this) {
            if (state != LinkState.SERIAL_CLOSED) {
                return;
            }
            state = LinkState.SERIAL_OPEN;
            notifyListenersLocked();
        }
    }

    /**
     * The serial port closed (onSerialClose / failed onSerialOpen). Resets everything: state back
     * to {@code SERIAL_CLOSED}, the negotiated caps to {@link BesCaps#NONE} (matching the legacy
     * {@code resetWireProtocolState()} reset that ran on serial close), and phone presence to
     * {@code UNKNOWN} — with no UART link there is no way to hear about presence edges, so the last
     * report cannot be trusted.
     */
    public void serialClosed() {
        synchronized (this) {
            boolean changed =
                    state != LinkState.SERIAL_CLOSED
                            || !negotiatedCaps.equals(BesCaps.NONE)
                            || phonePresence != PhonePresence.UNKNOWN;
            state = LinkState.SERIAL_CLOSED;
            negotiatedCaps = BesCaps.NONE;
            phonePresence = PhonePresence.UNKNOWN;
            if (changed) {
                notifyListenersLocked();
            }
        }
    }

    /**
     * An internally managed reopen currently has no physical descriptor. Unlike terminal serial
     * close, recovery still belongs to the same BES and phone sessions, so sticky capabilities and
     * phone presence remain valid while the physical-open state drops to closed.
     */
    public void serialUnavailable() {
        synchronized (this) {
            if (state == LinkState.SERIAL_CLOSED) {
                return;
            }
            state = LinkState.SERIAL_CLOSED;
            notifyListenersLocked();
        }
    }

    /**
     * The BES reported phone BLE presence: an {@code sr_phble} edge or the {@code phone_ble} field
     * of an {@code sr_syvr} reply. Orthogonal to the UART ladder — a baud reopen does not touch the
     * BES-to-phone BLE link, so presence deliberately survives {@link #streamDiscontinuity()}.
     *
     * <p>A presence EDGE (the value actually changing, in either direction) is a phone BLE session
     * boundary, and {@code notify_cap} derives from that session's negotiated ATT MTU: a new
     * session renegotiates the MTU, so the cached cap is dropped on every edge and only a fresh
     * wire_caps advertisement re-arms it. Callers syncing presence from an sr_syvr reply must
     * therefore apply the presence BEFORE merging that reply's own wire_caps, so the advertisement
     * measured for the current session survives.
     */
    public void phonePresenceReported(boolean present) {
        synchronized (this) {
            PhonePresence updated = present ? PhonePresence.PRESENT : PhonePresence.ABSENT;
            if (phonePresence == updated) {
                return;
            }
            phonePresence = updated;
            negotiatedCaps = negotiatedCaps.withoutNotifyCap();
            notifyListenersLocked();
        }
    }

    /**
     * The last presence report can no longer be trusted (the BES is rebooting after an OTA and
     * drops its phone link on the way down). Presence returns to {@code UNKNOWN} until the rebooted
     * BES sends a fresh signal, and the cached {@code notify_cap} is dropped too: the reboot is a
     * firmware-generation boundary AND kills the phone session whose MTU produced the value — the
     * new firmware may advertise differently or not at all.
     */
    public void phonePresenceInvalidated() {
        synchronized (this) {
            BesCaps updatedCaps = negotiatedCaps.withoutNotifyCap();
            boolean changed =
                    phonePresence != PhonePresence.UNKNOWN || !updatedCaps.equals(negotiatedCaps);
            phonePresence = PhonePresence.UNKNOWN;
            negotiatedCaps = updatedCaps;
            if (changed) {
                notifyListenersLocked();
            }
        }
    }

    /**
     * The receive byte stream was invalidated without a serial close/ready cycle: every reopen and
     * baud switch clears the message parser, and {@code SerialPortBridge.openAtBaud()} fires no
     * serial callbacks. The link is no longer proven at the current baud, so {@code LINK_PROVEN}
     * drops to {@code SERIAL_OPEN} and the proven caps view goes null until the next sr_syvr. The
     * negotiated caps stay (see {@link #getNegotiatedCaps()}).
     */
    public void streamDiscontinuity() {
        synchronized (this) {
            if (state != LinkState.LINK_PROVEN) {
                return;
            }
            state = LinkState.SERIAL_OPEN;
            notifyListenersLocked();
        }
    }

    /**
     * An sr_syvr reply was parsed: the UART link is proven alive at the current baud, optionally
     * with a wire_caps advertisement.
     *
     * @param advertised the caps the BES advertised in this sr_syvr, or null when the reply carried
     *     no wire_caps (legacy firmware); merged with the legacy accrual rules
     */
    public void srSyvrParsed(BesCaps advertised) {
        synchronized (this) {
            LinkState previousState = state;
            BesCaps previousProven = provenCapsLocked();
            if (advertised != null) {
                negotiatedCaps = negotiatedCaps.mergeAdvertised(advertised);
            }
            // A reply cannot arrive through a closed port; if it somehow does (races around
            // shutdown) record the caps but do not fabricate an open link.
            if (state != LinkState.SERIAL_CLOSED) {
                state = LinkState.LINK_PROVEN;
            }
            if (previousState != state || !Objects.equals(previousProven, provenCapsLocked())) {
                notifyListenersLocked();
            }
        }
    }

    /**
     * Merge capabilities from a valid {@code sr_syvr} without publishing a proven-link edge. The
     * transport coordinator uses this while that same reply is initiating a baud transition; the
     * capabilities are real, but the current byte stream is no longer a stable go-ahead.
     */
    public void capsAdvertised(BesCaps advertised) {
        if (advertised == null) {
            return;
        }
        synchronized (this) {
            BesCaps previousProven = provenCapsLocked();
            negotiatedCaps = negotiatedCaps.mergeAdvertised(advertised);
            if (state == LinkState.LINK_PROVEN
                    && !Objects.equals(previousProven, provenCapsLocked())) {
                notifyListenersLocked();
            }
        }
    }

    /**
     * A valid binary wire frame arrived from the BES: proof of binary relay support. Accrues into
     * the negotiated caps without touching the link state, because a relayed frame does not prove
     * the sr_syvr round trip at the current baud.
     */
    public void binaryRelayObserved() {
        synchronized (this) {
            BesCaps updated = negotiatedCaps.withBinaryRelayObserved();
            if (updated.equals(negotiatedCaps)) {
                return;
            }
            negotiatedCaps = updated;
            if (state == LinkState.LINK_PROVEN) {
                notifyListenersLocked();
            }
        }
    }

    /** Must hold the monitor. */
    private BesCaps provenCapsLocked() {
        return state == LinkState.LINK_PROVEN ? negotiatedCaps : null;
    }

    /**
     * Must hold the monitor. Enqueues the current (state, provenCaps) pair and drains the queue in
     * FIFO order. The monitor is reentrant, so a listener may perform a transition from inside its
     * callback; delivering that nested transition inline would either tear the pair for later
     * listeners in the outer pass or hand them the passes out of order (a stale pair delivered
     * last). Queueing instead means every listener observes transitions in the same global order
     * and its LAST observation always matches the machine's final state. The audience is
     * snapshotted at transition time: a listener added mid-dispatch replays the (already final)
     * current state on subscribe and must not also receive older queued passes afterwards.
     */
    private void notifyListenersLocked() {
        pendingNotifications.add(
                new Notification(state, provenCapsLocked(), phonePresence, List.copyOf(listeners)));
        if (dispatching) {
            return; // The drain below us on the stack will deliver this pass after its own.
        }
        dispatching = true;
        try {
            Notification notification;
            while ((notification = pendingNotifications.poll()) != null) {
                for (Listener listener : notification.audience) {
                    deliverSafely(
                            listener,
                            notification.state,
                            notification.provenCaps,
                            notification.phonePresence);
                }
            }
        } finally {
            dispatching = false;
        }
    }

    /**
     * Must hold the monitor. A throwing listener must not starve later listeners or propagate into
     * the transport caller (which would misreport a parse failure after the machine already
     * mutated), so exceptions end here.
     */
    private void deliverSafely(
            Listener listener, LinkState state, BesCaps provenCaps, PhonePresence phonePresence) {
        try {
            listener.onLinkStateChanged(state, provenCaps, phonePresence);
        } catch (RuntimeException e) {
            Log.e(TAG, "Link state listener threw for " + state + "; continuing delivery", e);
        }
    }
}
