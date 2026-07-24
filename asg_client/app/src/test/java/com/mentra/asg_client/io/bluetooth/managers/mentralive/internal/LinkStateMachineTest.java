package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import static org.assertj.core.api.Assertions.assertThat;

import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.LinkStateMachine.BesCaps;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.LinkStateMachine.LinkState;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class LinkStateMachineTest {

    /** Records every notification so tests can assert on ordering and payloads. */
    private static final class RecordingListener implements LinkStateMachine.Listener {
        final List<LinkState> states = new ArrayList<>();
        final List<BesCaps> caps = new ArrayList<>();

        @Override
        public void onLinkStateChanged(LinkState state, BesCaps provenCaps) {
            states.add(state);
            caps.add(provenCaps);
        }

        LinkState lastState() {
            return states.get(states.size() - 1);
        }

        BesCaps lastCaps() {
            return caps.get(caps.size() - 1);
        }
    }

    private static final BesCaps FULL_CAPS =
            new BesCaps(true, true, true, true, BesWireFormat.PROTOCOL_VERSION_V2);

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

        assertThat(listener.states)
                .containsExactly(LinkState.SERIAL_CLOSED, LinkState.SERIAL_OPEN);
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

    // ---- caps accrual rules ----

    @Test
    public void srSyvrParsed_mergesFlagsAcrossAdvertisements() {
        machine.serialReady();
        machine.srSyvrParsed(
                new BesCaps(true, false, false, false, BesWireFormat.PROTOCOL_VERSION_V1));
        machine.srSyvrParsed(
                new BesCaps(false, true, false, false, BesWireFormat.PROTOCOL_VERSION_V2));

        BesCaps caps = machine.getNegotiatedCaps();
        assertThat(caps.k900Le).isTrue();
        assertThat(caps.binary).isTrue();
        assertThat(caps.proto).isEqualTo(BesWireFormat.PROTOCOL_VERSION_V2);
    }

    @Test
    public void srSyvrParsed_withoutBinaryFlag_doesNotTouchProto() {
        machine.serialReady();
        machine.binaryRelayObserved();
        assertThat(machine.getNegotiatedCaps().proto)
                .isEqualTo(BesWireFormat.PROTOCOL_VERSION_V2);

        // An advertisement without the binary flag says nothing about the protocol version.
        machine.srSyvrParsed(
                new BesCaps(true, false, false, false, BesWireFormat.PROTOCOL_VERSION_V1));

        assertThat(machine.getNegotiatedCaps().proto)
                .isEqualTo(BesWireFormat.PROTOCOL_VERSION_V2);
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
        assertThat(machine.getNegotiatedCaps().proto)
                .isEqualTo(BesWireFormat.PROTOCOL_VERSION_V2);
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

        assertThat(listener.states)
                .containsExactly(LinkState.LINK_PROVEN, LinkState.LINK_PROVEN);
        assertThat(listener.lastCaps().binary).isTrue();

        // A repeated observation changes nothing and must not re-notify.
        machine.binaryRelayObserved();
        assertThat(listener.states).hasSize(2);
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
    public void listener_mayRemoveItselfDuringNotification() {
        AtomicInteger calls = new AtomicInteger();
        LinkStateMachine.Listener selfRemoving =
                new LinkStateMachine.Listener() {
                    @Override
                    public void onLinkStateChanged(LinkState state, BesCaps provenCaps) {
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
                (state, provenCaps) -> {
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
