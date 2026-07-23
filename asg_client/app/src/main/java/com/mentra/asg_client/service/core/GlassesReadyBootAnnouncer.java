package com.mentra.asg_client.service.core;

import android.os.Handler;
import android.util.Log;
import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.bluetooth.managers.K900BluetoothManager;
import com.mentra.asg_client.io.bluetooth.managers.mentralive.internal.BesWireFormat;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;
import org.json.JSONObject;

/**
 * Announces {@code glasses_ready} once per process when the transport first comes up.
 *
 * <p>The normal readiness flow is phone-driven: the phone sends {@code phone_ready} when the
 * BES heartbeat reports the SoC ready, and {@link
 * com.mentra.asg_client.service.core.handlers.PhoneReadyCommandHandler} answers with {@code
 * glasses_ready}. That flow silently dies after an APK-OTA process restart: the phone-BES BLE
 * link survives the restart, so the phone's stale {@code glassesReady} flag suppresses {@code
 * phone_ready} — and with it the wire-session reset and the phone-initiated BLE wire v2
 * handshake. The freshly installed process then stays on v1 TX for the rest of the session
 * (incident rep_01KY6BJ0B7A4RBMQ7VN39KAE5E).
 *
 * <p>Both phone SDKs already treat an incoming {@code glasses_ready} as a REMOTE wire-session
 * reset (reset negotiation state, re-parse {@code wire_caps}, re-initiate the v2 handshake), so
 * a boot-time announcement re-syncs deployed phones without any phone-side change. Wire v2
 * activation stays RESPONDER-ONLY on the glasses side — this class only advertises readiness
 * and caps; the phone still initiates the handshake.
 *
 * <p>Duplicate {@code glasses_ready} deliveries (e.g. racing a genuine phone_ready flow on a
 * fresh connection) are idempotent on the phone. Retries stop early once wire v2 activates —
 * proof the announcement (or a parallel readiness flow) already reached the phone.
 */
public class GlassesReadyBootAnnouncer {
    private static final String TAG = "GlassesReadyBootAnnouncer";

    private final ICommunicationManager communicationManager;
    private final Supplier<K900BluetoothManager> k900ManagerSupplier;
    private final Handler handler;
    private final AtomicBoolean announced = new AtomicBoolean(false);

    public GlassesReadyBootAnnouncer(
            ICommunicationManager communicationManager,
            Supplier<K900BluetoothManager> k900ManagerSupplier,
            Handler handler) {
        this.communicationManager = communicationManager;
        this.k900ManagerSupplier = k900ManagerSupplier;
        this.handler = handler;
    }

    /**
     * Call on every transport-up edge; the announcement schedule runs only once per process.
     * A fresh process starts with default (reset) transport framing, so the phone-side
     * assumption "the glasses reset their wire state before sending glasses_ready" holds
     * without an explicit onTransportReset() here.
     */
    public void onTransportUp() {
        if (!announced.compareAndSet(false, true)) {
            return;
        }
        sendAttempt(1);
    }

    private void sendAttempt(int attempt) {
        if (attempt > 1 && BesWireFormat.isBinaryProtocolActive()) {
            Log.i(TAG, "🤝 Wire v2 active after boot announcement attempt " + (attempt - 1)
                    + " — stopping retries");
            return;
        }

        JSONObject message = buildGlassesReady();
        boolean sent = message != null && communicationManager.sendBluetoothResponse(message);
        Log.i(
                TAG,
                "📢 glasses_ready boot announcement attempt "
                        + attempt
                        + "/"
                        + AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_ATTEMPTS
                        + (sent ? " sent" : " not sent (transport not ready?)"));

        if (attempt < AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_ATTEMPTS) {
            handler.postDelayed(
                    () -> sendAttempt(attempt + 1),
                    AsgConstants.GLASSES_READY_BOOT_ANNOUNCE_INTERVAL_MS);
        }
    }

    /** Same shape as PhoneReadyCommandHandler's reply: type/timestamp plus wire_caps. */
    private JSONObject buildGlassesReady() {
        try {
            JSONObject message = new JSONObject();
            message.put("type", "glasses_ready");
            message.put("timestamp", System.currentTimeMillis());
            K900BluetoothManager k900Manager = k900ManagerSupplier.get();
            if (k900Manager != null) {
                k900Manager.addPhoneWireCapsIfSupported(message);
            }
            return message;
        } catch (Exception e) {
            Log.e(TAG, "Error building glasses_ready boot announcement", e);
            return null;
        }
    }
}
