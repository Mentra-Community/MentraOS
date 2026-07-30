package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;

import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.LinkStateMachine.BesCaps;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.LinkStateMachine.LinkState;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.LinkStateMachine.PhonePresence;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class LinkStateMachineTest {

    /** Records every notification so tests can assert on ordering and payloads. */
    private static final class RecordingListener implements LinkStateMachine.Listener {
        final List<LinkState> states = new ArrayList<>();
        final List<BesCaps> caps = new ArrayList<>();
        final List<PhonePresence> presences = new ArrayList<>();

        @Override
        public void onLinkStateChanged(
                LinkState state, BesCaps provenCaps, PhonePresence phonePresence) {
            states.add(state);
            caps.add(provenCaps);
            presences.add(phonePresence);
        }

        LinkState lastState() {
            return states.get(states.size() - 1);
        }

        BesCaps lastCaps() {
            return caps.get(caps.size() - 1);
        }
    }

    private static final BesCaps FULL_CAPS =
            new BesCaps(true, true, true, true, BesWireFormat.PROTOCOL_VERSION_V2, 509);

    private LinkStateMachine machine;

    @Before
    public void setUp() {
        machine = new LinkStateMachine();
    }

    // ---- replay-on-subscribe ----

    @Test
    public void addListener_replaysInitialClosedStateSynchronously() {
        RecordingListener listener = new RecordingListener();

        machine.addListener(listener);

        assertThat(listener.states).containsExactly(LinkState.SERIAL_CLOSED);
        assertThat(listener.caps).containsExactly((BesCaps) null);
    }

    @Test
    public void addListener_afterProvenEdge_replaysProvenStateAndCapsSynchronously() {
        machine.serialReady();
        machine.srSyvrParsed(FULL_CAPS);

        // The bug class this machine exists to fix: a listener registering after the only
        // edge must still observe it.
        RecordingListener lateListener = new RecordingListener();
        machine.addListener(lateListener);

        assertThat(lateListener.states).containsExactly(LinkState.LINK_PROVEN);
        assertThat(lateListener.lastCaps()).isEqualTo(FULL_CAPS);
    }

    @Test
    public void addListener_sameListenerTwice_replaysOnlyOnce() {
        RecordingListener listener = new RecordingListener();

        machine.addListener(listener);
        machine.addListener(listener);
        machine.serialReady();

        assertThat(listener.states).containsExactly(LinkState.SERIAL_CLOSED, LinkState.SERIAL_OPEN);
    }

    @Test
    public void removeListener_stopsNotifications() {
        RecordingListener listener = new RecordingListener();
        machine.addListener(listener);

        machine.removeListener(listener);
        machine.serialReady();

        assertThat(listener.states).containsExactly(LinkState.SERIAL_CLOSED);
    }

    // ---- ladder transitions ----

    @Test
    public void serialReady_promotesClosedToOpen() {
        RecordingListener listener = new RecordingListener();
        machine.addListener(listener);

        machine.serialReady();

        assertThat(machine.getState()).isEqualTo(LinkState.SERIAL_OPEN);
        assertThat(machine.isSerialOpen()).isTrue();
        assertThat(listener.lastState()).isEqualTo(LinkState.SERIAL_OPEN);
    }

    @Test
    public void serialReady_whenAlreadyProven_isANoOp() {
        machine.serialReady();
        machine.srSyvrParsed(FULL_CAPS);
        RecordingListener listener = new RecordingListener();
        machine.addListener(listener);

        machine.serialReady();

        assertThat(machine.getState()).isEqualTo(LinkState.LINK_PROVEN);
        assertThat(listener.states).containsExactly(LinkState.LINK_PROVEN);
    }

    @Test
    public void srSyvrParsed_withCaps_provesLinkAndExposesCaps() {
        machine.serialReady();

        machine.srSyvrParsed(FULL_CAPS);

        assertThat(machine.getState()).isEqualTo(LinkState.LINK_PROVEN);
        assertThat(machine.getProvenCaps()).isEqualTo(FULL_CAPS);
        assertThat(machine.getNegotiatedCaps()).isEqualTo(FULL_CAPS);
    }

    @Test
    public void capsAdvertised_recordsCapabilitiesWithoutProvingTransitionalLink() {
        machine.serialReady();

        machine.capsAdvertised(FULL_CAPS);

        assertThat(machine.getState()).isEqualTo(LinkState.SERIAL_OPEN);
        assertThat(machine.getNegotiatedCaps()).isEqualTo(FULL_CAPS);
    }

    @Test
    public void srSyvrParsed_withoutCaps_provesLinkWithEmptyCapsSnapshot() {
        machine.serialReady();

        // Legacy firmware answers sr_syvr without a wire_caps object.
        machine.srSyvrParsed(null);

        assertThat(machine.getState()).isEqualTo(LinkState.LINK_PROVEN);
        assertThat(machine.getProvenCaps()).isEqualTo(BesCaps.NONE);
        assertThat(machine.getProvenCaps().binary).isFalse();
    }

    @Test
    public void srSyvrParsed_whileSerialClosed_recordsCapsWithoutFabricatingAnOpenLink() {
        machine.srSyvrParsed(FULL_CAPS);

        assertThat(machine.getState()).isEqualTo(LinkState.SERIAL_CLOSED);
        assertThat(machine.getProvenCaps()).isNull();
        assertThat(machine.getNegotiatedCaps()).isEqualTo(FULL_CAPS);
    }

    // ---- discontinuity ----

    @Test
    public void streamDiscontinuity_dropsProvenAndHidesCaps() {
        machine.serialReady();
        machine.srSyvrParsed(FULL_CAPS);
        RecordingListener listener = new RecordingListener();
        machine.addListener(listener);

        machine.streamDiscontinuity();

        assertThat(machine.getState()).isEqualTo(LinkState.SERIAL_OPEN);
        assertThat(machine.getProvenCaps()).isNull();
        assertThat(listener.lastState()).isEqualTo(LinkState.SERIAL_OPEN);
        assertThat(listener.lastCaps()).isNull();
    }

    @Test
    public void streamDiscontinuity_keepsNegotiatedCapsForLegacyGetters() {
        machine.serialReady();
        machine.srSyvrParsed(FULL_CAPS);

        machine.streamDiscontinuity();

        // Parity with the legacy besWireCaps* booleans: a reopen never cleared them, and
        // outbound capability decisions must not downgrade mid-session.
        assertThat(machine.getNegotiatedCaps()).isEqualTo(FULL_CAPS);
    }

    @Test
    public void streamDiscontinuity_whenNotProven_isANoOp() {
        machine.serialReady();
        RecordingListener listener = new RecordingListener();
        machine.addListener(listener);

        machine.streamDiscontinuity();

        assertThat(machine.getState()).isEqualTo(LinkState.SERIAL_OPEN);
        assertThat(listener.states).containsExactly(LinkState.SERIAL_OPEN);
    }

    @Test
    public void reprovingAfterDiscontinuity_restoresProvenCaps() {
        machine.serialReady();
        machine.srSyvrParsed(FULL_CAPS);
        machine.streamDiscontinuity();

        machine.srSyvrParsed(null);

        assertThat(machine.getState()).isEqualTo(LinkState.LINK_PROVEN);
        assertThat(machine.getProvenCaps()).isEqualTo(FULL_CAPS);
    }

    // ---- serial close ----

    @Test
    public void serialClosed_resetsStateAndCaps() {
        machine.serialReady();
        machine.srSyvrParsed(FULL_CAPS);
        RecordingListener listener = new RecordingListener();
        machine.addListener(listener);

        machine.serialClosed();

        assertThat(machine.getState()).isEqualTo(LinkState.SERIAL_CLOSED);
        assertThat(machine.isSerialOpen()).isFalse();
        assertThat(machine.getProvenCaps()).isNull();
        assertThat(machine.getNegotiatedCaps()).isEqualTo(BesCaps.NONE);
        assertThat(listener.lastState()).isEqualTo(LinkState.SERIAL_CLOSED);
        assertThat(listener.lastCaps()).isNull();
    }

    @Test
    public void serialClosed_whenAlreadyClosedWithNoCaps_doesNotNotify() {
        RecordingListener listener = new RecordingListener();
        machine.addListener(listener);

        machine.serialClosed();

        assertThat(listener.states).containsExactly(LinkState.SERIAL_CLOSED);
    }

    @Test
    public void serialUnavailable_preservesStickySessionFactsDuringRecovery() {
        machine.serialReady();
        machine.srSyvrParsed(FULL_CAPS);
        machine.phonePresenceReported(true);
        BesCaps sessionCaps = machine.getNegotiatedCaps();

        machine.serialUnavailable();

        assertThat(machine.getState()).isEqualTo(LinkState.SERIAL_CLOSED);
        assertThat(machine.isSerialOpen()).isFalse();
        assertThat(machine.getProvenCaps()).isNull();
        assertThat(machine.getNegotiatedCaps()).isEqualTo(sessionCaps);
        assertThat(machine.getPhonePresence()).isEqualTo(PhonePresence.PRESENT);

        machine.serialReady();
        machine.srSyvrParsed(null);
        assertThat(machine.getProvenCaps()).isEqualTo(sessionCaps);

        machine.serialUnavailable();
        machine.serialClosed();
        assertThat(machine.getNegotiatedCaps()).isEqualTo(BesCaps.NONE);
        assertThat(machine.getPhonePresence()).isEqualTo(PhonePresence.UNKNOWN);
    }

    // ---- caps accrual rules ----

    @Test
    public void srSyvrParsed_mergesFlagsAcrossAdvertisements() {
        machine.serialReady();
        machine.srSyvrParsed(
                new BesCaps(true, false, false, false, BesWireFormat.PROTOCOL_VERSION_V1, 0));
        machine.srSyvrParsed(
                new BesCaps(false, true, false, false, BesWireFormat.PROTOCOL_VERSION_V2, 0));

        BesCaps caps = machine.getNegotiatedCaps();
        assertThat(caps.k900Le).isTrue();
        assertThat(caps.binary).isTrue();
        assertThat(caps.proto).isEqualTo(BesWireFormat.PROTOCOL_VERSION_V2);
    }

    @Test
    public void srSyvrParsed_withoutBinaryFlag_doesNotTouchProto() {
        machine.serialReady();
        machine.binaryRelayObserved();
        assertThat(machine.getNegotiatedCaps().proto).isEqualTo(BesWireFormat.PROTOCOL_VERSION_V2);

        // An advertisement without the binary flag says nothing about the protocol version.
        machine.srSyvrParsed(
                new BesCaps(true, false, false, false, BesWireFormat.PROTOCOL_VERSION_V1, 0));

        assertThat(machine.getNegotiatedCaps().proto).isEqualTo(BesWireFormat.PROTOCOL_VERSION_V2);
        assertThat(machine.getNegotiatedCaps().binary).isTrue();
    }

    @Test
    public void binaryRelayObserved_accruesBinaryWithoutChangingState() {
        machine.serialReady();
        RecordingListener listener = new RecordingListener();
        machine.addListener(listener);

        machine.binaryRelayObserved();

        assertThat(machine.getState()).isEqualTo(LinkState.SERIAL_OPEN);
        assertThat(machine.getNegotiatedCaps().binary).isTrue();
        assertThat(machine.getNegotiatedCaps().proto).isEqualTo(BesWireFormat.PROTOCOL_VERSION_V2);
        // Not proven, so the observable (state, provenCaps) pair did not change.
        assertThat(listener.states).containsExactly(LinkState.SERIAL_OPEN);
    }

    @Test
    public void binaryRelayObserved_whileProven_updatesProvenCapsAndNotifies() {
        machine.serialReady();
        machine.srSyvrParsed(null);
        RecordingListener listener = new RecordingListener();
        machine.addListener(listener);

        machine.binaryRelayObserved();

        assertThat(listener.states).containsExactly(LinkState.LINK_PROVEN, LinkState.LINK_PROVEN);
        assertThat(listener.lastCaps().binary).isTrue();

        // A repeated observation changes nothing and must not re-notify.
        machine.binaryRelayObserved();
        assertThat(listener.states).hasSize(2);
    }

    // ---- phone presence tri-state ----

    @Test
    public void phonePresence_defaultsToUnknownAndReplaysOnSubscribe() {
        RecordingListener listener = new RecordingListener();

        machine.addListener(listener);

        assertThat(machine.getPhonePresence()).isEqualTo(PhonePresence.UNKNOWN);
        assertThat(listener.presences).containsExactly(PhonePresence.UNKNOWN);
    }

    @Test
    public void phonePresenceReported_movesThroughPresentAndAbsent() {
        machine.serialReady();
        RecordingListener listener = new RecordingListener();
        machine.addListener(listener);

        machine.phonePresenceReported(true);
        assertThat(machine.getPhonePresence()).isEqualTo(PhonePresence.PRESENT);

        machine.phonePresenceReported(false);
        assertThat(machine.getPhonePresence()).isEqualTo(PhonePresence.ABSENT);

        assertThat(listener.presences)
                .containsExactly(
                        PhonePresence.UNKNOWN, PhonePresence.PRESENT, PhonePresence.ABSENT);
    }

    @Test
    public void phonePresenceReported_duplicateReport_doesNotRenotify() {
        machine.serialReady();
        machine.phonePresenceReported(true);
        RecordingListener listener = new RecordingListener();
        machine.addListener(listener);

        machine.phonePresenceReported(true);

        assertThat(listener.presences).containsExactly(PhonePresence.PRESENT);
    }

    @Test
    public void addListener_afterPresenceEdge_replaysPresenceSynchronously() {
        machine.serialReady();
        machine.phonePresenceReported(true);

        RecordingListener lateListener = new RecordingListener();
        machine.addListener(lateListener);

        assertThat(lateListener.presences).containsExactly(PhonePresence.PRESENT);
    }

    @Test
    public void serialClosed_resetsPresenceToUnknown() {
        machine.serialReady();
        machine.phonePresenceReported(true);
        RecordingListener listener = new RecordingListener();
        machine.addListener(listener);

        machine.serialClosed();

        assertThat(machine.getPhonePresence()).isEqualTo(PhonePresence.UNKNOWN);
        assertThat(listener.presences)
                .containsExactly(PhonePresence.PRESENT, PhonePresence.UNKNOWN);
    }

    @Test
    public void phonePresenceInvalidated_dropsToUnknown() {
        machine.serialReady();
        machine.phonePresenceReported(false);

        machine.phonePresenceInvalidated();

        assertThat(machine.getPhonePresence()).isEqualTo(PhonePresence.UNKNOWN);
        // Idempotent: a second invalidation is a no-op.
        RecordingListener listener = new RecordingListener();
        machine.addListener(listener);
        machine.phonePresenceInvalidated();
        assertThat(listener.presences).containsExactly(PhonePresence.UNKNOWN);
    }

    @Test
    public void streamDiscontinuity_keepsPresence() {
        // A baud reopen invalidates the ASG-to-BES byte stream, not the BES-to-phone BLE link:
        // presence must survive the discontinuity.
        machine.serialReady();
        machine.srSyvrParsed(FULL_CAPS);
        machine.phonePresenceReported(true);

        machine.streamDiscontinuity();

        assertThat(machine.getPhonePresence()).isEqualTo(PhonePresence.PRESENT);
    }

    // ---- notify_cap lifecycle: UART session ∩ phone BLE session ∩ firmware generation ----

    @Test
    public void presenceEdge_dropsNotifyCapButKeepsTheOtherCaps() {
        machine.serialReady();
        machine.srSyvrParsed(FULL_CAPS);
        machine.phonePresenceReported(true);
        machine.srSyvrParsed(
                new BesCaps(false, false, false, false, BesWireFormat.PROTOCOL_VERSION_V1, 509));
        assertThat(machine.getNegotiatedCaps().notifyCap).isEqualTo(509);

        // The phone disconnected: its session's negotiated ATT MTU (and thus notify_cap) died
        // with it, but the UART-session caps are still valid.
        machine.phonePresenceReported(false);

        assertThat(machine.getNegotiatedCaps().notifyCap).isEqualTo(0);
        assertThat(machine.getNegotiatedCaps().binary).isTrue();
        assertThat(machine.getNegotiatedCaps().filePayloadV2).isTrue();

        // A NEW phone session renegotiates the MTU: reconnecting must NOT restore the old cap.
        machine.phonePresenceReported(true);
        assertThat(machine.getNegotiatedCaps().notifyCap).isEqualTo(0);

        // Only a fresh advertisement re-arms it.
        machine.srSyvrParsed(
                new BesCaps(false, false, false, false, BesWireFormat.PROTOCOL_VERSION_V1, 260));
        assertThat(machine.getNegotiatedCaps().notifyCap).isEqualTo(260);
    }

    @Test
    public void duplicatePresenceReport_keepsNotifyCap() {
        machine.serialReady();
        machine.phonePresenceReported(true);
        machine.srSyvrParsed(
                new BesCaps(false, false, false, false, BesWireFormat.PROTOCOL_VERSION_V1, 509));

        // Same-session syncs (phone_ble repeating the current value) are not session boundaries.
        machine.phonePresenceReported(true);

        assertThat(machine.getNegotiatedCaps().notifyCap).isEqualTo(509);
    }

    @Test
    public void phonePresenceInvalidated_dropsNotifyCapEvenWhenPresenceAlreadyUnknown() {
        machine.serialReady();
        machine.srSyvrParsed(
                new BesCaps(false, false, false, false, BesWireFormat.PROTOCOL_VERSION_V1, 509));
        assertThat(machine.getPhonePresence()).isEqualTo(PhonePresence.UNKNOWN);

        // BES OTA: firmware-generation boundary — the cached cap must die regardless of what
        // the presence tri-state happens to be.
        machine.phonePresenceInvalidated();

        assertThat(machine.getNegotiatedCaps().notifyCap).isEqualTo(0);
    }

    // ---- notify_cap accrual ----

    @Test
    public void srSyvrParsed_notifyCapTakesNewestAdvertisedValue() {
        machine.serialReady();
        machine.srSyvrParsed(
                new BesCaps(false, false, false, false, BesWireFormat.PROTOCOL_VERSION_V1, 509));
        assertThat(machine.getNegotiatedCaps().notifyCap).isEqualTo(509);

        // notify_cap tracks the CURRENT negotiated ATT MTU, so a newer advertisement wins...
        machine.srSyvrParsed(
                new BesCaps(false, false, false, false, BesWireFormat.PROTOCOL_VERSION_V1, 253));
        assertThat(machine.getNegotiatedCaps().notifyCap).isEqualTo(253);

        // ...but an advertisement without notify_cap keeps the previous value.
        machine.srSyvrParsed(
                new BesCaps(true, false, false, false, BesWireFormat.PROTOCOL_VERSION_V1, 0));
        assertThat(machine.getNegotiatedCaps().notifyCap).isEqualTo(253);
    }

    // ---- listener ordering / thread safety basics ----

    @Test
    public void listeners_observeTransitionsInOrder() {
        RecordingListener listener = new RecordingListener();
        machine.addListener(listener);

        machine.serialReady();
        machine.srSyvrParsed(FULL_CAPS);
        machine.streamDiscontinuity();
        machine.serialClosed();

        assertThat(listener.states)
                .containsExactly(
                        LinkState.SERIAL_CLOSED,
                        LinkState.SERIAL_OPEN,
                        LinkState.LINK_PROVEN,
                        LinkState.SERIAL_OPEN,
                        LinkState.SERIAL_CLOSED);
        assertThat(listener.caps.get(2)).isEqualTo(FULL_CAPS);
        assertThat(listener.caps.get(3)).isNull();
    }

    @Test
    public void reentrantTransitionInListener_deliversInGlobalOrderEndingOnFinalState() {
        // Listener A closes the serial port from inside its LINK_PROVEN callback. The reentrant
        // transition must be QUEUED behind the pass in flight, so B observes the transitions in
        // global FIFO order (proven, then closed) with consistent pairs throughout — never a torn
        // pair, and never a stale proven pair delivered after the close.
        RecordingListener b = new RecordingListener();
        machine.serialReady();
        machine.addListener(
                (state, provenCaps, phonePresence) -> {
                    if (state == LinkState.LINK_PROVEN) {
                        machine.serialClosed();
                    }
                });
        machine.addListener(b);

        machine.srSyvrParsed(FULL_CAPS);

        // Every pair B ever observed must be internally consistent.
        for (int i = 0; i < b.states.size(); i++) {
            boolean proven = b.states.get(i) == LinkState.LINK_PROVEN;
            assertThat(b.caps.get(i) != null)
                    .as("pair %d: state=%s caps=%s", i, b.states.get(i), b.caps.get(i))
                    .isEqualTo(proven);
        }
        // Global FIFO order: replay, the outer proven pass, then A's queued reentrant close.
        assertThat(b.states)
                .containsExactly(
                        LinkState.SERIAL_OPEN, LinkState.LINK_PROVEN, LinkState.SERIAL_CLOSED);
        assertThat(b.caps.get(1)).isEqualTo(FULL_CAPS);
        assertThat(b.caps.get(2)).isNull();
        // B's LAST observation matches the machine's final state, so a consumer keyed off the
        // latest callback can never re-enable work after the close.
        assertThat(machine.getState()).isEqualTo(LinkState.SERIAL_CLOSED);
        assertThat(b.lastState()).isEqualTo(machine.getState());
        assertThat(b.lastCaps()).isEqualTo(machine.getProvenCaps());
    }

    @Test
    public void throwingListener_doesNotStarveLaterListenersOrPropagateToTheCaller() {
        machine.serialReady();
        machine.addListener(
                (state, provenCaps, phonePresence) -> {
                    throw new IllegalStateException("listener bug");
                });
        RecordingListener survivor = new RecordingListener();
        machine.addListener(survivor);

        // Must not throw into the transport caller (which would misreport a parse failure).
        machine.srSyvrParsed(FULL_CAPS);

        assertThat(survivor.lastState()).isEqualTo(LinkState.LINK_PROVEN);
        assertThat(survivor.lastCaps()).isEqualTo(FULL_CAPS);
        assertThat(machine.getState()).isEqualTo(LinkState.LINK_PROVEN);
    }

    @Test
    public void throwingListener_duringReplayOnSubscribe_doesNotPropagate() {
        machine.serialReady();

        machine.addListener(
                (state, provenCaps, phonePresence) -> {
                    throw new IllegalStateException("replay bug");
                });

        // The add itself survives and later transitions still reach healthy listeners.
        RecordingListener survivor = new RecordingListener();
        machine.addListener(survivor);
        machine.srSyvrParsed(FULL_CAPS);
        assertThat(survivor.lastState()).isEqualTo(LinkState.LINK_PROVEN);
    }

    @Test
    public void listener_mayRemoveItselfDuringNotification() {
        AtomicInteger calls = new AtomicInteger();
        LinkStateMachine.Listener selfRemoving =
                new LinkStateMachine.Listener() {
                    @Override
                    public void onLinkStateChanged(
                            LinkState state, BesCaps provenCaps, PhonePresence phonePresence) {
                        calls.incrementAndGet();
                        machine.removeListener(this);
                    }
                };

        machine.addListener(selfRemoving);
        machine.serialReady();

        // One call from replay-on-subscribe; the removal inside it must stick.
        assertThat(calls.get()).isEqualTo(1);
    }

    @Test
    public void concurrentTransitions_neverTearStateAndCapsApart() throws Exception {
        // The listener contract: provenCaps is non-null exactly in LINK_PROVEN. Hammer the
        // machine from two threads and verify no notification ever violates it.
        AtomicBoolean invariantViolated = new AtomicBoolean(false);
        machine.addListener(
                (state, provenCaps, phonePresence) -> {
                    if ((provenCaps != null) != (state == LinkState.LINK_PROVEN)) {
                        invariantViolated.set(true);
                    }
                });

        CountDownLatch start = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(2);
        Runnable prover =
                () -> {
                    awaitQuietly(start);
                    for (int i = 0; i < 500; i++) {
                        machine.serialReady();
                        machine.srSyvrParsed(FULL_CAPS);
                    }
                    done.countDown();
                };
        Runnable dropper =
                () -> {
                    awaitQuietly(start);
                    for (int i = 0; i < 500; i++) {
                        machine.streamDiscontinuity();
                        machine.serialClosed();
                    }
                    done.countDown();
                };
        new Thread(prover).start();
        new Thread(dropper).start();
        start.countDown();

        assertThat(done.await(10, TimeUnit.SECONDS)).isTrue();
        assertThat(invariantViolated.get()).isFalse();
        // The machine must land in one of the coherent end states, not somewhere torn.
        LinkState finalState = machine.getState();
        if (finalState == LinkState.LINK_PROVEN) {
            assertThat(machine.getProvenCaps()).isNotNull();
        } else {
            assertThat(machine.getProvenCaps()).isNull();
        }
    }

    private static void awaitQuietly(CountDownLatch latch) {
        try {
            latch.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
