package com.mentra.asg_client.service.core.handlers;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.wifi.WifiManager;
import android.util.Log;
import com.mentra.asg_client.io.network.interfaces.INetworkManager;
import com.mentra.asg_client.io.network.interfaces.IWifiScanCallback;
import com.mentra.asg_client.io.network.models.NetworkInfo;
import com.mentra.asg_client.service.communication.interfaces.ICommunicationManager;
import com.mentra.asg_client.service.legacy.interfaces.ICommandHandler;
import com.mentra.asg_client.service.legacy.managers.AsgClientServiceManager;
import com.mentra.asg_client.service.system.interfaces.IStateManager;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Handler for WiFi-related commands.
 * Follows Single Responsibility Principle by handling only WiFi commands.
 */
public class WifiCommandHandler implements ICommandHandler {
    private static final String TAG = "WifiCommandHandler";

    private final AsgClientServiceManager serviceManager;
    private final ICommunicationManager communicationManager;
    private final IStateManager stateManager;

    /** Verdict sources for one connect attempt: the status poll and the supplicant listener. */
    private static final class ConnectAttempt {
        final AtomicBoolean verdictSent = new AtomicBoolean(false);
        volatile BroadcastReceiver authFailureReceiver;
    }

    // The single in-flight connect attempt. A new set_wifi_credentials supersedes the
    // previous attempt (its poll and receiver are silenced) so a single supplicant
    // auth-failure broadcast can never produce more than one wrong_password verdict.
    private final AtomicReference<ConnectAttempt> activeConnectAttempt = new AtomicReference<>();

    /**
     * One in-flight WiFi scan run. The scanId it stamps on emissions is mutable:
     * a request that arrives while a run is active adopts the run by swapping in
     * its own id (see {@link #handleRequestWifiScan}). Guarded by {@link #scanLock}
     * because the swap happens on the command thread while the stamping callbacks
     * fire on the scan thread.
     */
    private static final class ScanRun {
        String scanId;

        ScanRun(String scanId) {
            this.scanId = scanId;
        }
    }

    private final Object scanLock = new Object();
    private ScanRun activeScanRun; // guarded by scanLock

    public WifiCommandHandler(AsgClientServiceManager serviceManager,
                              ICommunicationManager communicationManager,
                              IStateManager stateManager) {
        this.serviceManager = serviceManager;
        this.communicationManager = communicationManager;
        this.stateManager = stateManager;
    }

    @Override
    public Set<String> getSupportedCommandTypes() {
        return Set.of("set_wifi_credentials", "request_wifi_status", "request_wifi_scan", "set_hotspot_state", "disconnect_wifi", "forget_wifi");
    }

    @Override
    public boolean handleCommand(String commandType, JSONObject data) {
        try {
            switch (commandType) {
                case "set_wifi_credentials":
                    return handleSetWifiCredentials(data);
                case "request_wifi_status":
                    return handleRequestWifiStatus();
                case "request_wifi_scan":
                    return handleRequestWifiScan(data);
                case "set_hotspot_state":
                    return handleSetHotspotState(data);
                case "disconnect_wifi":
                    return handleDisconnectWifi();
                case "forget_wifi":
                    return handleForgetWifi(data);
                default:
                    Log.e(TAG, "Unsupported WiFi command: " + commandType);
                    return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling WiFi command: " + commandType, e);
            return false;
        }
    }

    /**
     * Handle set WiFi credentials command
     */
    private boolean handleSetWifiCredentials(JSONObject data) {
        try {
            String ssid = data.optString("ssid", "");
            String password = data.optString("password", "");
            if (!ssid.isEmpty()) {
                INetworkManager networkManager = serviceManager.getNetworkManager();
                if (networkManager != null) {
                    Log.d(TAG, "📶 Initiating WiFi connection to: " + ssid);
                    networkManager.connectToWifi(ssid, password);
                    serviceManager.initializeCameraWebServer();

                    // Schedule WiFi status check after connection attempt
                    // This ensures we send status even if broadcast receiver doesn't fire
                    scheduleWifiStatusCheck(ssid);

                    return true;
                } else {
                    Log.e(TAG, "Network manager not available");
                    return false;
                }
            } else {
                Log.e(TAG, "Cannot set WiFi credentials - missing SSID");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling WiFi credentials command", e);
            return false;
        }
    }

    /**
     * Schedule a delayed WiFi status check to ensure mobile app receives status update
     * even if NETWORK_STATE_CHANGED broadcast doesn't fire reliably
     */
    private void scheduleWifiStatusCheck(String targetSsid) {
        // One verdict per connect attempt: either the supplicant's fast wrong-password
        // signal below or this poll reports, never both. A new attempt supersedes any
        // in-flight one - silencing the old verdict flag also makes its still-registered
        // receiver and poll thread no-ops until they tear down.
        ConnectAttempt attempt = new ConnectAttempt();
        ConnectAttempt previous = activeConnectAttempt.getAndSet(attempt);
        if (previous != null) {
            previous.verdictSent.set(true);
            unregisterAuthFailureReceiver(previous.authFailureReceiver);
            previous.authFailureReceiver = null;
        }
        AtomicBoolean verdictSent = attempt.verdictSent;
        attempt.authFailureReceiver = registerAuthFailureReceiver(verdictSent);
        new Thread(() -> {
            try {
                // Wait for WiFi connection to establish (3 seconds initial, then poll)
                Log.d(TAG, "📶 ⏱️ Waiting 3s for WiFi connection to establish...");
                Thread.sleep(3000);

                // Poll WiFi status multiple times over 12 seconds (total 15s)
                for (int i = 0; i < 4; i++) {
                    if (verdictSent.get()) {
                        return; // supplicant already reported wrong_password
                    }
                    boolean isConnected = stateManager.isConnectedToWifi();
                    String currentSsid = serviceManager.getNetworkManager() != null ?
                            serviceManager.getNetworkManager().getCurrentWifiSsid() : "";

                    Log.d(TAG, "📶 🔍 WiFi status check #" + (i + 1) +
                            ": connected=" + isConnected +
                            ", current_ssid=" + currentSsid +
                            ", target_ssid=" + targetSsid);

                    // Send status if connected to target network, or if we've reached final attempt
                    if ((isConnected && currentSsid.equals(targetSsid)) || i == 3) {
                        boolean connectedToTarget = isConnected && currentSsid.equals(targetSsid);
                        // Surface why provisioning failed instead of a bare connected=false —
                        // "never associates, no error shown" was a field complaint. The error is
                        // an ATTEMPT verdict riding on a truthful LINK snapshot, so
                        // connected_to_other_network is deliberately sent with connected=true:
                        // the join failed and auto-join left the glasses on (or returned them
                        // to) a different SSID, so the link is genuinely up while the request
                        // genuinely failed.
                        String error = null;
                        if (!connectedToTarget) {
                            error = isConnected ? "connected_to_other_network" : "connect_timeout";
                        }
                        if (!verdictSent.compareAndSet(false, true)) {
                            return; // supplicant verdict won the race
                        }
                        Log.d(TAG, "📶 ✅ Sending WiFi status update: " +
                                (isConnected ? "CONNECTED to " + currentSsid : "DISCONNECTED") +
                                (error != null ? " (error=" + error + ")" : ""));
                        communicationManager.sendWifiStatusOverBle(isConnected, error);
                        break;
                    }

                    // Wait 3 more seconds before next check
                    Thread.sleep(3000);
                }
            } catch (InterruptedException e) {
                Log.w(TAG, "📶 ⚠️ WiFi status check interrupted", e);
                Thread.currentThread().interrupt();
            } catch (Exception e) {
                Log.e(TAG, "📶 💥 Error during WiFi status check", e);
            } finally {
                unregisterAuthFailureReceiver(attempt.authFailureReceiver);
                attempt.authFailureReceiver = null;
                activeConnectAttempt.compareAndSet(attempt, null);
            }
        }).start();
    }

    /**
     * Listens for the supplicant's authentication-failure signal during a connect attempt
     * so a wrong password is reported in ~5-7s (when the 4-way handshake fails) instead of
     * the generic connect_timeout at the end of the 12s poll window - and with a reason the
     * app can distinguish from out-of-range. Fast-path only: the broadcast is deprecated
     * (still delivered on Android 11, where asg_client runs as a system app), so if it never
     * fires the poll verdict above remains the fallback. The broadcast carries no SSID, but
     * the connect sequence just disabled all other configured networks (enableNetwork
     * disableOthers=true), so an auth failure inside this window belongs to this attempt.
     */
    private BroadcastReceiver registerAuthFailureReceiver(AtomicBoolean verdictSent) {
        Context context = serviceManager.getService();
        if (context == null) {
            return null;
        }
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                int supplicantError = intent.getIntExtra(WifiManager.EXTRA_SUPPLICANT_ERROR, -1);
                if (supplicantError == WifiManager.ERROR_AUTHENTICATING
                        && verdictSent.compareAndSet(false, true)) {
                    Log.i(TAG, "📶 ❌ Supplicant authentication failure - sending wrong_password verdict");
                    communicationManager.sendWifiStatusOverBle(false, "wrong_password");
                }
            }
        };
        try {
            context.registerReceiver(receiver,
                    new IntentFilter(WifiManager.SUPPLICANT_STATE_CHANGED_ACTION));
            return receiver;
        } catch (Exception e) {
            Log.w(TAG, "📶 ⚠️ Could not register supplicant auth-failure listener", e);
            return null;
        }
    }

    private void unregisterAuthFailureReceiver(BroadcastReceiver receiver) {
        if (receiver == null) {
            return;
        }
        Context context = serviceManager.getService();
        if (context == null) {
            return;
        }
        try {
            context.unregisterReceiver(receiver);
        } catch (IllegalArgumentException e) {
            Log.w(TAG, "📶 ⚠️ Auth-failure receiver already unregistered", e);
        }
    }

    /**
     * Handle request WiFi status command
     */
    public boolean handleRequestWifiStatus() {
        try {
            if (stateManager.isConnectedToWifi()) {
                communicationManager.sendWifiStatusOverBle(true);
            } else {
                communicationManager.sendWifiStatusOverBle(false);
            }
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling WiFi status request", e);
            return false;
        }
    }

    /**
     * Handle request WiFi scan command
     */
    public boolean handleRequestWifiScan(JSONObject data) {
        try {
            // Optional correlation id echoed in every wifi_scan_result chunk so the
            // phone can tie results to this scan.
            String requestedScanId = data.optString("scanId", "");
            String scanId = requestedScanId.isEmpty() ? null : requestedScanId;
            INetworkManager networkManager = serviceManager.getNetworkManager();
            if (networkManager == null) {
                Log.e(TAG, "Network manager not available for WiFi scan");
                // Terminal empty result so the phone fails fast instead of waiting
                // out its scan timeout.
                communicationManager.sendWifiScanResultsOverBleEnhanced(new ArrayList<>(), true, scanId);
                return false;
            }
            final ScanRun run;
            synchronized (scanLock) {
                if (activeScanRun != null) {
                    // Single-flight: the system scan is global (every run's receiver
                    // gets the same SCAN_RESULTS_AVAILABLE broadcast), so a second
                    // concurrent run would stamp the same results with a second id
                    // and could strand this request. Adopt the running scan instead:
                    // the phone joins concurrent scan requests under one scanId, so
                    // a second, DIFFERENT id implies the older phone request was
                    // abandoned (cancelled/timed out) — swapping the newest id onto
                    // all subsequent emissions (chunks + terminal) serves the only
                    // live requester without double-sending chunks.
                    if (scanId != null) {
                        activeScanRun.scanId = scanId;
                    }
                    return true;
                }
                run = new ScanRun(scanId);
                activeScanRun = run;
            }
            new Thread(() -> {
                try {
                    // Use streaming WiFi scan with callback for immediate results
                    networkManager.scanWifiNetworks(new IWifiScanCallback() {
                        @Override
                        public void onNetworksFoundEnhanced(List<NetworkInfo> networks) {
                            Log.d(TAG, "📡 Streaming " + networks.size() + " enhanced WiFi networks to phone");
                            // Send each batch of networks immediately as they're found
                            communicationManager.sendWifiScanResultsOverBleEnhanced(networks, false, scanRunId(run));
                        }

                        @Override
                        public void onScanComplete(int totalNetworksFound) {
                            Log.d(TAG, "📡 WiFi scan completed, total networks found: " + totalNetworksFound);
                            communicationManager.sendWifiScanResultsOverBleEnhanced(new ArrayList<>(), true, finishScanRun(run));
                        }

                        @Override
                        public void onScanError(String error) {
                            Log.e(TAG, "📡 WiFi scan error: " + error);
                            // Send empty list on error to indicate scan failure
                            communicationManager.sendWifiScanResultsOverBleEnhanced(new ArrayList<>(), true, finishScanRun(run));
                        }
                    });
                } catch (Exception e) {
                    Log.e(TAG, "Error scanning for WiFi networks", e);
                    communicationManager.sendWifiScanResultsOverBleEnhanced(new ArrayList<>(), true, finishScanRun(run));
                }
            }).start();
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling WiFi scan request", e);
            return false;
        }
    }

    /** Read the run's current (possibly adopted) id to stamp on an emission. */
    private String scanRunId(ScanRun run) {
        synchronized (scanLock) {
            return run.scanId;
        }
    }

    /**
     * Read the id for the run's terminal emission and release the single-flight
     * slot, atomically: a request that arrives before the release adopts this run
     * and its id rides on the terminal; one that arrives after starts a fresh
     * scan. Idempotent so a late failure path can't clobber a newer run.
     */
    private String finishScanRun(ScanRun run) {
        synchronized (scanLock) {
            if (activeScanRun == run) {
                activeScanRun = null;
            }
            return run.scanId;
        }
    }

    /**
     * Handle set hotspot state command
     */
    public boolean handleSetHotspotState(JSONObject data) {
        try {
            boolean requestedState = data.optBoolean("enabled", false);
            INetworkManager networkManager = serviceManager.getNetworkManager();

            if (networkManager == null) {
                Log.e(TAG, "Network manager not available for hotspot command");
                return false;
            }

            boolean currentState = networkManager.isHotspotEnabled();
            boolean transitioning = networkManager.isHotspotTransitioning();
            boolean reportCancelledStart =
                    shouldReportCancelledHotspotStart(
                            currentState, requestedState, transitioning);

            // A matching public state is not terminal while K900 is still starting or
            // closing. Route the command through the manager so it can cancel or queue
            // the requested transition instead of returning stale credentials/status.
            if (!shouldApplyHotspotState(currentState, requestedState, transitioning)) {
                Log.d(TAG, "🔥 Hotspot already in requested state (" +
                        (requestedState ? "ENABLED" : "DISABLED") +
                        "), sending current status");

                // Send current status immediately since there won't be a state change broadcast
                sendHotspotStatusToPhone(networkManager);
            } else {
                // State needs to change
                if (requestedState) {
                    networkManager.startHotspot();
                    Log.d(TAG, "🔥 Hotspot start requested - status will be sent via broadcast receiver");
                } else {
                    networkManager.stopHotspot();
                    if (reportCancelledStart) {
                        // Public state was already disabled, so BaseNetworkManager has no
                        // enabled-to-disabled listener edge to publish for this cancellation.
                        sendHotspotStatusToPhone(networkManager, false);
                        Log.d(TAG, "🔥 Hotspot startup cancelled - disabled status sent");
                    } else {
                        Log.d(TAG, "🔥 Hotspot stop requested - status will be sent via broadcast receiver");
                    }
                }
                // Broadcast receiver will handle sending the status when state actually changes
            }

            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error handling hotspot state command", e);
            return false;
        }
    }

    static boolean shouldApplyHotspotState(
            boolean currentState, boolean requestedState, boolean transitioning) {
        return currentState != requestedState || transitioning;
    }

    static boolean shouldReportCancelledHotspotStart(
            boolean currentState, boolean requestedState, boolean transitioning) {
        return !currentState && !requestedState && transitioning;
    }

    /**
     * Handle disconnect WiFi command
     */
    private boolean handleDisconnectWifi() {
        try {
            INetworkManager networkManager = serviceManager.getNetworkManager();
            if (networkManager != null) {
                networkManager.disconnectFromWifi();
                Log.d(TAG, "📶 WiFi disconnect command executed");
                return true;
            } else {
                Log.e(TAG, "Network manager not available for WiFi disconnect");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling WiFi disconnect command", e);
            return false;
        }
    }

    /**
     * Handle forget WiFi command - removes a saved network from the device
     */
    private boolean handleForgetWifi(JSONObject data) {
        try {
            String ssid = data.optString("ssid", "");
            if (ssid.isEmpty()) {
                Log.e(TAG, "📶 Cannot forget WiFi - missing SSID");
                return false;
            }

            Log.d(TAG, "📶 Forgetting WiFi network: " + ssid);

            INetworkManager networkManager = serviceManager.getNetworkManager();
            if (networkManager != null) {
                networkManager.forgetWifiNetwork(ssid);
                Log.d(TAG, "📶 ✅ WiFi forget command executed for: " + ssid);
                return true;
            } else {
                Log.e(TAG, "📶 Network manager not available for WiFi forget");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "📶 Error handling WiFi forget command", e);
            return false;
        }
    }

    /**
     * Send hotspot status to phone via BLE
     */
    private void sendHotspotStatusToPhone(INetworkManager networkManager) {
        sendHotspotStatusToPhone(networkManager, networkManager.isHotspotEnabled());
    }

    private void sendHotspotStatusToPhone(
            INetworkManager networkManager, boolean hotspotEnabled) {
        try {
            JSONObject hotspotStatus = new JSONObject();
            hotspotStatus.put("type", "hotspot_status_update");
            hotspotStatus.put("hotspot_enabled", hotspotEnabled);

            if (hotspotEnabled) {
                hotspotStatus.put("hotspot_ssid", networkManager.getHotspotSsid());
                hotspotStatus.put("hotspot_password", networkManager.getHotspotPassword());
                hotspotStatus.put("hotspot_gateway_ip", networkManager.getHotspotGatewayIp());
            }

            boolean sent = communicationManager.sendBluetoothResponse(hotspotStatus);
            Log.d(
                    TAG,
                    "🔥 "
                            + (sent
                                    ? "✅ Hotspot status sent successfully"
                                    : "❌ Failed to send hotspot status")
                            + ", enabled="
                            + hotspotEnabled);
        } catch (Exception e) {
            Log.e(TAG, "Error sending hotspot status to phone", e);
        }
    }

}
