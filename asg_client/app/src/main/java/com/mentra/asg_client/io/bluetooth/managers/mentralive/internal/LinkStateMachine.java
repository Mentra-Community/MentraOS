package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

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
 * <p>Caps have two views on purpose:
 *
 * <ul>
 *   <li>{@link #getProvenCaps()} (also the listener payload) is non-null only in
 *       {@code LINK_PROVEN}: it is the snapshot a consumer may trust because an sr_syvr proved the
 *       link at the current baud.
 *   <li>{@link #getNegotiatedCaps()} is the sticky negotiation result, cleared only by
 *       {@link #serialClosed()}. This mirrors the legacy reset rules exactly: a mid-session baud
 *       reopen never cleared {@code besWireCaps*}, and outbound capability decisions (binary relay,
 *       file payload v2, push window) must not silently downgrade for a whole phone session just
 *       because a reopen window was in flight. The legacy delegating getters read this view.
 * </ul>
 *
 * <p>Thread safety: transitions arrive from the serial RX thread, the baud-switch executor, and
 * binder threads. All state mutation and listener notification happen under the internal monitor,
 * so every listener observes transitions in a single global order and replay-on-subscribe cannot
 * interleave with a concurrent transition. Listeners must therefore be fast and must not block on
 * locks that transition callers might hold.
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
     * Immutable snapshot of the wire capabilities negotiated with the BES. Instances are values:
     * mutation happens by replacing the machine's current snapshot, never in place.
     */
    public static final class BesCaps {
        /** No capabilities negotiated: the state before any BES advertisement. */
        public static final BesCaps NONE =
                new BesCaps(false, false, false, false, BesWireFormat.PROTOCOL_VERSION_V1);

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

        public BesCaps(
                boolean k900Le, boolean binary, boolean filePayloadV2, boolean bigPacks, int proto) {
            this.k900Le = k900Le;
            this.binary = binary;
            this.filePayloadV2 = filePayloadV2;
            this.bigPacks = bigPacks;
            this.proto = proto;
        }

        /**
         * Merge an sr_syvr wire_caps advertisement into this snapshot using the legacy accrual
         * rules: flags only ever turn on, and {@code proto} is overwritten only when the
         * advertisement carries the binary flag (an advertisement without {@code binary} says
         * nothing about the protocol version).
         */
        BesCaps mergeAdvertised(BesCaps advertised) {
            return new BesCaps(
                    k900Le || advertised.k900Le,
                    binary || advertised.binary,
                    filePayloadV2 || advertised.filePayloadV2,
                    bigPacks || advertised.bigPacks,
                    advertised.binary ? advertised.proto : proto);
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
                    Math.max(proto, BesWireFormat.PROTOCOL_VERSION_V2));
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
                    && proto == other.proto;
        }

        @Override
        public int hashCode() {
            return Objects.hash(k900Le, binary, filePayloadV2, bigPacks, proto);
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
                    + "}";
        }
    }

    /** Observer of link state transitions. */
    public interface Listener {
        /**
         * Called under the machine's monitor on every observable change, and synchronously from
         * {@link #addListener} with the current state.
         *
         * @param state the current link state
         * @param provenCaps the trusted caps snapshot; non-null exactly when {@code state} is
         *     {@link LinkState#LINK_PROVEN}
         */
        void onLinkStateChanged(LinkState state, BesCaps provenCaps);
    }

    // Copy-on-write so a listener may add/remove listeners from inside a callback without
    // corrupting the iteration that is notifying it.
    private final List<Listener> listeners = new CopyOnWriteArrayList<>();

    private LinkState state = LinkState.SERIAL_CLOSED;
    private BesCaps negotiatedCaps = BesCaps.NONE;

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
        listener.onLinkStateChanged(state, provenCapsLocked());
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
     * The serial port opened (onSerialReady / successful onSerialOpen). Promotes
     * {@code SERIAL_CLOSED} to {@code SERIAL_OPEN}; a redundant ready on an already-open link
     * changes nothing.
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
     * to {@code SERIAL_CLOSED} and the negotiated caps to {@link BesCaps#NONE}, matching the
     * legacy {@code resetWireProtocolState()} reset that ran on serial close.
     */
    public void serialClosed() {
        synchronized (this) {
            boolean changed = state != LinkState.SERIAL_CLOSED
                    || !negotiatedCaps.equals(BesCaps.NONE);
            state = LinkState.SERIAL_CLOSED;
            negotiatedCaps = BesCaps.NONE;
            if (changed) {
                notifyListenersLocked();
            }
        }
    }

    /**
     * The receive byte stream was invalidated without a serial close/ready cycle: every reopen and
     * baud switch clears the message parser, and {@code SerialPortBridge.reopen()} fires no serial
     * callbacks. The link is no longer proven at the current baud, so {@code LINK_PROVEN} drops to
     * {@code SERIAL_OPEN} and the proven caps view goes null until the next sr_syvr. The
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
     * @param advertised the caps the BES advertised in this sr_syvr, or null when the reply
     *     carried no wire_caps (legacy firmware); merged with the legacy accrual rules
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

    /** Must hold the monitor. */
    private void notifyListenersLocked() {
        BesCaps provenCaps = provenCapsLocked();
        for (Listener listener : listeners) {
            listener.onLinkStateChanged(state, provenCaps);
        }
    }
}
