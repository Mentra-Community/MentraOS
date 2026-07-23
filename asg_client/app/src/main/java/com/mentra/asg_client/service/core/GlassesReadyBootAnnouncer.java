package com.mentra.asg_client.service.core;

import android.os.Handler;
import android.util.Log;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bluetooth.interfaces.IBluetoothManager;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesWireFormat;
import com.mentra.asg_client.service.core.processors.CommandProcessor;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;
import org.json.JSONObject;

/**
 * Re-runs the phone_ready readiness flow once per process when the phone never asks for it.
 *
 * <p>The normal readiness flow is phone-driven: the phone sends {@code phone_ready} when the
 * BES heartbeat reports the SoC ready, and {@link
 * com.mentra.asg_client.service.core.handlers.PhoneReadyCommandHandler} answers with {@code
 * glasses_ready} plus the rest of the session setup (transport reset, wire_caps, WiFi/hotspot
 * status, RGB LED authority). That flow silently dies after an APK-OTA process restart: the
 * phone-BES BLE link survives the restart, so the phone's stale {@code glassesReady} flag
 * suppresses {@code phone_ready} — and with it the wire reset and the phone-initiated BLE wire
 * v2 handshake. The freshly installed process then stays on v1 TX for the rest of the session
 * (incident rep_01KY6BJ0B7A4RBMQ7VN39KAE5E).
 *
 * <p>The announcement is delivered by injecting a SYNTHETIC {@code phone_ready} into the
 * standard {@link CommandProcessor} dispatch, not by hand-rolling a {@code glasses_ready}
 * send: the phone latches {@code glassesReady} on the resulting {@code glasses_ready} and
 * skips its own {@code phone_ready}, so whatever the handler's flow does — today the
 * transport/wire-epoch reset, wire_caps advertisement, WiFi + hotspot status, RGB LED
 * authority; tomorrow whatever gets added — must all have happened. Driving the real flow
 * makes that true by construction, and keeps the phone-side contract (glasses_ready marks a
 * fresh wire epoch, re-handshake always answered) intact on every repeat announcement.
 *
 * <p>This is a self-scheduling poller, NOT a transport-callback subscriber, for two reasons:
 * {@code K900BluetoothManager} opens its serial port from its constructor, so the first
 * serial-ready edge can fire before {@code AsgClientService} is registered as a transport
 * listener (and listener registration does not replay current state) — an edge-triggered
 * announcement can be missed entirely. And the announcement must carry {@code wire_caps}: the
 * phone's remote wire reset CLEARS its stored peer caps, then gates its v2 handshake on the
 * caps in the message. The BES caps arrive only after the sr_syvr round-trip, so each tick
 * waits for transport-up AND resolved caps (bounded — a legacy BES that never advertises
 * binary relay proceeds caps-less after the wait budget; v2 is impossible there anyway).
 *
 * <p>Wire v2 activation stays RESPONDER-ONLY on the glasses side — the phone still initiates
 * the handshake. Retries stop as soon as v2 activates (proof the phone heard us, or that a
 * genuine phone_ready flow ran in parallel).
 */
public class GlassesReadyBootAnnouncer {
    private static final String TAG = "GlassesReadyBootAnnouncer";

    private final Supplier<CommandProcessor> commandProcessorSupplier;
    private final Supplier<IBluetoothManager> bluetoothManagerSupplier;
    private final Handler handler;
    private final AtomicBoolean started = new AtomicBoolean(false);
    private final Runnable tickRunnable = this::tick;

    private volatile boolean stopped = false;
    private int ticksUsed = 0;
    private int connectedCapslessTicks = 0;
    private int announcementsSent = 0;

    public GlassesReadyBootAnnouncer(
            Supplier<CommandProcessor> commandProcessorSupplier,
            Supplier<IBluetoothManager> bluetoothManagerSupplier,
            Handler handler) {
        this.commandProcessorSupplier = commandProcessorSupplier;
        this.bluetoothManagerSupplier = bluetoothManagerSupplier;
        this.handler = handler;
    }

    /** Starts the once-per-process announcement schedule. Safe to call more than once. */
    public void start() {
        if (!started.compareAndSet(false, true)) {
            return;
        }
        handler.post(tickRunnable);
    }

    /** Cancels any scheduled ticks. Call on service teardown; late ticks must not touch torn-down managers. */
    public void stop() {
        stopped = true;
        handler.removeCallbacks(tickRunnable);
    }

    private void tick() {
        if (stopped) {
            return;
        }
        if (BesWireFormat.isBinaryProtocolActive()) {
            Log.i(TAG, "🤝 Wire v2 active — boot announcement done after "
                    + announcementsSent + " send(s)");
            return;
        }
        if (announcementsSent >= AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_ATTEMPTS) {
            return;
        }
        if (ticksUsed >= AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_MAX_TICKS) {
            Log.i(TAG, "📢 Boot announcement window closed (" + announcementsSent + " send(s))");
            return;
        }
        ticksUsed++;

        if (shouldAnnounceNow()) {
            announce();
        }

        handler.postDelayed(tickRunnable, AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_INTERVAL_MS);
    }

    private boolean shouldAnnounceNow() {
        IBluetoothManager bluetoothManager = bluetoothManagerSupplier.get();
        if (commandProcessorSupplier.get() == null
                || bluetoothManager == null
                || !bluetoothManager.isConnected()) {
            // A transport gap invalidates any caps-wait progress: serial close clears the
            // negotiated BES caps, so the wait must restart from the reopen — otherwise the
            // first connected tick after a UART blip could blow the budget and announce
            // caps-less right when the fresh sr_syvr reply is imminent.
            connectedCapslessTicks = 0;
            return false;
        }
        // Wait (bounded) for the BES sr_syvr reply to resolve wire caps, so the resulting
        // glasses_ready carries the wire_caps the phone's handshake gate requires.
        if (bluetoothManager instanceof K900BluetoothManager
                && !((K900BluetoothManager) bluetoothManager).isBesBinaryRelaySupported()) {
            connectedCapslessTicks++;
            return connectedCapslessTicks > AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_CAPS_WAIT_TICKS;
        }
        return true;
    }

    /**
     * Runs the standard phone_ready command flow as if the phone had asked. Carries no
     * {@code mId}, so the dispatch neither acks it toward the phone nor tracks it for
     * duplicate suppression; the {@code boot_announce} marker only disambiguates field logs.
     */
    private void announce() {
        try {
            JSONObject syntheticPhoneReady = new JSONObject();
            syntheticPhoneReady.put("type", "phone_ready");
            syntheticPhoneReady.put("boot_announce", true);
            announcementsSent++;
            Log.i(
                    TAG,
                    "📢 Boot announcement "
                            + announcementsSent
                            + "/"
                            + AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_ATTEMPTS
                            + " — running phone_ready flow");
            commandProcessorSupplier.get().processJsonCommand(syntheticPhoneReady);
        } catch (Exception e) {
            Log.e(TAG, "Error running boot announcement phone_ready flow", e);
        }
    }
}
