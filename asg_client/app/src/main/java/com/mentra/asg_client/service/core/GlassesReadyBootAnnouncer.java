package com.mentra.asg_client.service.core;

import android.os.Handler;
import android.util.Log;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bluetooth.interfaces.IBluetoothManager;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesWireFormat;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;
import org.json.JSONObject;

/**
 * Announces {@code glasses_ready} once per process, so a phone whose BLE link survived an
 * asg_client restart re-runs its wire-session reset and the BLE wire v2 handshake.
 *
 * <p>The normal readiness flow is phone-driven: the phone sends {@code phone_ready} when the
 * BES heartbeat reports the SoC ready, and {@link
 * com.mentra.asg_client.service.core.handlers.PhoneReadyCommandHandler} answers with {@code
 * glasses_ready}. That flow silently dies after an APK-OTA process restart: the phone-BES BLE
 * link survives the restart, so the phone's stale {@code glassesReady} flag suppresses {@code
 * phone_ready} — and with it the wire reset and the phone-initiated v2 handshake. The freshly
 * installed process then stays on v1 TX for the rest of the session (incident
 * rep_01KY6BJ0B7A4RBMQ7VN39KAE5E).
 *
 * <p>This is a self-scheduling poller, NOT a transport-callback subscriber, for two reasons:
 * {@code K900BluetoothManager} opens its serial port from its constructor, so the first
 * serial-ready edge can fire before {@code AsgClientService} is registered as a transport
 * listener (and listener registration does not replay current state) — an edge-triggered
 * announcement can be missed entirely. And the announcement must carry {@code wire_caps}: the
 * phone treats {@code glasses_ready} as a remote wire reset that CLEARS its stored peer caps,
 * then gates its v2 handshake on the caps in the message — a caps-less announcement leaves the
 * session stuck on v1, which is the exact failure being fixed. The BES caps arrive only after
 * the sr_syvr round-trip, so each tick waits for transport-up AND resolved caps (bounded — a
 * legacy BES that never advertises binary relay gets a caps-less announcement after the wait
 * budget; v2 is impossible there anyway and the announcement still refreshes readiness).
 *
 * <p>Wire v2 activation stays RESPONDER-ONLY on the glasses side — this class only advertises
 * readiness and caps; the phone still initiates the handshake. Retries stop as soon as v2
 * activates (proof the phone heard us, or that a parallel phone_ready flow negotiated).
 * Duplicate {@code glasses_ready} deliveries are idempotent on the phone.
 */
public class GlassesReadyBootAnnouncer {
    private static final String TAG = "GlassesReadyBootAnnouncer";

    private final Supplier<ICommunicationManager> communicationManagerSupplier;
    private final Supplier<IBluetoothManager> bluetoothManagerSupplier;
    private final Handler handler;
    private final AtomicBoolean started = new AtomicBoolean(false);

    private int ticksUsed = 0;
    private int connectedCapslessTicks = 0;
    private int announcementsSent = 0;

    public GlassesReadyBootAnnouncer(
            Supplier<ICommunicationManager> communicationManagerSupplier,
            Supplier<IBluetoothManager> bluetoothManagerSupplier,
            Handler handler) {
        this.communicationManagerSupplier = communicationManagerSupplier;
        this.bluetoothManagerSupplier = bluetoothManagerSupplier;
        this.handler = handler;
    }

    /** Starts the once-per-process announcement schedule. Safe to call more than once. */
    public void start() {
        if (!started.compareAndSet(false, true)) {
            return;
        }
        handler.post(this::tick);
    }

    private void tick() {
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

        handler.postDelayed(this::tick, AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_INTERVAL_MS);
    }

    private boolean shouldAnnounceNow() {
        IBluetoothManager bluetoothManager = bluetoothManagerSupplier.get();
        ICommunicationManager communicationManager = communicationManagerSupplier.get();
        if (bluetoothManager == null
                || communicationManager == null
                || !bluetoothManager.isConnected()) {
            return false;
        }
        // Wait (bounded) for the BES sr_syvr reply to resolve wire caps, so the
        // announcement carries the wire_caps the phone's handshake gate requires.
        if (bluetoothManager instanceof K900BluetoothManager
                && !((K900BluetoothManager) bluetoothManager).isBesBinaryRelaySupported()) {
            connectedCapslessTicks++;
            return connectedCapslessTicks > AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_CAPS_WAIT_TICKS;
        }
        return true;
    }

    private void announce() {
        JSONObject message = buildGlassesReady();
        boolean sent =
                message != null && communicationManagerSupplier.get().sendBluetoothResponse(message);
        if (sent) {
            announcementsSent++;
        }
        Log.i(
                TAG,
                "📢 glasses_ready boot announcement "
                        + announcementsSent
                        + "/"
                        + AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_ATTEMPTS
                        + (sent ? " sent" : " send failed"));
    }

    /** Same shape as PhoneReadyCommandHandler's reply: type/timestamp plus wire_caps. */
    private JSONObject buildGlassesReady() {
        try {
            JSONObject message = new JSONObject();
            message.put("type", "glasses_ready");
            message.put("timestamp", System.currentTimeMillis());
            IBluetoothManager bluetoothManager = bluetoothManagerSupplier.get();
            if (bluetoothManager instanceof K900BluetoothManager) {
                ((K900BluetoothManager) bluetoothManager).addPhoneWireCapsIfSupported(message);
            }
            return message;
        } catch (Exception e) {
            Log.e(TAG, "Error building glasses_ready boot announcement", e);
            return null;
        }
    }
}
