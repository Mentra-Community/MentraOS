package com.mentra.asg_client.io.network.managers;

import android.annotation.SuppressLint;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiConfiguration;
import android.net.wifi.WifiManager;
import android.net.wifi.WifiNetworkSuggestion;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import com.mentra.asg_client.io.network.core.BaseNetworkManager;
import com.mentra.asg_client.io.network.interfaces.IWifiScanCallback;
import com.mentra.asg_client.io.network.utils.DebugNotificationManager;
import com.mentra.asg_client.io.network.utils.HotspotLandingPage;
import com.mentra.asg_client.io.network.utils.HotspotSetupRequestParser;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Implementation of INetworkManager for devices with system permissions. Uses reflection to access
 * system APIs for WiFi and hotspot control.
 */
public class SystemNetworkManager extends BaseNetworkManager {
    private static final String TAG = "SystemNetworkManager";

    // Constants for hotspot configuration
    private static final String HOTSPOT_SSID_PREFIX = "AugmentOS_";
    private static final String DEFAULT_HOTSPOT_PASSWORD = "augmentos1234";
    private static final int DEFAULT_WEBSERVER_PORT = 8080;

    private final WifiManager wifiManager;
    private final DebugNotificationManager notificationManager;
    private BroadcastReceiver wifiStateReceiver;
    private BroadcastReceiver wifiSuggestionReceiver;

    // Server state
    private boolean isServerRunning = false;
    private Thread serverThread;
    private int listenPort = DEFAULT_WEBSERVER_PORT;
    private String hotspotLandingPage;

    /**
     * Create a new SystemNetworkManager
     *
     * @param context The application context
     * @param notificationManager The notification manager to use
     */
    public SystemNetworkManager(Context context, DebugNotificationManager notificationManager) {
        super(context);
        this.wifiManager = (WifiManager) context.getSystemService(Context.WIFI_SERVICE);
        this.notificationManager = notificationManager;

        notificationManager.showDebugNotification(
                "System Network Manager",
                "Using reflection-based network APIs with system permissions");
    }

    @Override
    public void initialize() {
        super.initialize();
        registerWifiStateReceiver();

        // Check if we're already connected to WiFi
        if (isConnectedToWifi()) {
            notificationManager.showWifiStateNotification(true);
        } else {
            notificationManager.showWifiStateNotification(false);
            // Auto-enable WiFi if not connected
            enableWifi();
        }
    }

    @Override
    public void enableWifi() {
        try {
            if (!wifiManager.isWifiEnabled()) {
                wifiManager.setWifiEnabled(true);
                notificationManager.showDebugNotification(
                        "WiFi Enabling", "Attempting to enable WiFi");

                // Wait for WiFi to be enabled
                new Handler(Looper.getMainLooper())
                        .postDelayed(
                                new Runnable() {
                                    @Override
                                    public void run() {
                                        if (wifiManager.isWifiEnabled()) {
                                            notificationManager.showDebugNotification(
                                                    "WiFi Enabled",
                                                    "WiFi has been successfully enabled");

                                            // Try to connect to known networks
                                            new Handler(Looper.getMainLooper())
                                                    .postDelayed(
                                                            new Runnable() {
                                                                @Override
                                                                public void run() {
                                                                    List<String>
                                                                            configuredNetworks =
                                                                                    getConfiguredWifiNetworks();
                                                                    if (!configuredNetworks
                                                                            .isEmpty()) {
                                                                        notificationManager
                                                                                .showDebugNotification(
                                                                                        "Auto-Connect",
                                                                                        "Attempting to connect to "
                                                                                                + configuredNetworks
                                                                                                        .size()
                                                                                                + " known networks");
                                                                    }
                                                                }
                                                            },
                                                            2000);
                                        } else {
                                            notificationManager.showDebugNotification(
                                                    "WiFi Error", "Failed to enable WiFi");
                                        }
                                    }
                                },
                                3000);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error enabling WiFi", e);
            notificationManager.showDebugNotification(
                    "WiFi Error", "Error enabling WiFi: " + e.getMessage());
        }
    }

    @Override
    public void disableWifi() {
        try {
            if (wifiManager.isWifiEnabled()) {
                wifiManager.setWifiEnabled(false);
                notificationManager.showDebugNotification("WiFi Disabling", "Disabling WiFi");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error disabling WiFi", e);
            notificationManager.showDebugNotification(
                    "WiFi Error", "Error disabling WiFi: " + e.getMessage());
        }
    }

    @Override
    public void startHotspot() {
        // Get device-persistent credentials
        String ssid = getDeviceHotspotSsid();
        String password = getDeviceHotspotPassword();

        Log.d(TAG, "Starting system hotspot with SSID: " + ssid);

        // IMPORTANT: Hotspot requires WiFi radio to be enabled (even if not connected)
        // Check and enable WiFi if needed before starting hotspot
        try {
            if (!wifiManager.isWifiEnabled()) {
                Log.d(TAG, "⚠️ WiFi radio is OFF - enabling WiFi radio for hotspot...");
                boolean enabled = wifiManager.setWifiEnabled(true);
                if (enabled) {
                    Log.d(TAG, "✅ WiFi radio enabled successfully");
                    // Give WiFi a moment to initialize
                    try {
                        Thread.sleep(500);
                    } catch (InterruptedException e) {
                        Log.w(TAG, "Sleep interrupted while waiting for WiFi radio", e);
                    }
                } else {
                    Log.e(TAG, "❌ Failed to enable WiFi radio - hotspot may not start");
                }
            } else {
                Log.d(TAG, "✅ WiFi radio already enabled");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error enabling WiFi radio for hotspot", e);
        }

        try {
            boolean success = enableHotspotInternal(ssid, password);
            if (success) {
                // Update state with actual credentials
                updateHotspotState(true, ssid, password);
                notificationManager.showHotspotStateNotification(true);
                notifyHotspotStateChanged(true);
                startServer();
                Log.i(TAG, "System hotspot started successfully with SSID: " + ssid);
            } else {
                notificationManager.showDebugNotification(
                        "Hotspot Error", "Failed to start system hotspot");
                Log.e(TAG, "Failed to start system hotspot");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error starting system hotspot", e);
            notificationManager.showDebugNotification(
                    "Hotspot Error", "Error starting hotspot: " + e.getMessage());
        }
    }

    @Override
    public void stopHotspot() {
        Log.d(TAG, "Stopping system hotspot");

        try {
            boolean success = disableHotspotInternal();
            if (success) {
                notificationManager.showHotspotStateNotification(false);
                notifyHotspotStateChanged(false);
                stopServer();
                Log.i(TAG, "System hotspot stopped successfully");
            } else {
                notificationManager.showDebugNotification(
                        "Hotspot Error", "Failed to stop system hotspot");
                Log.e(TAG, "Failed to stop system hotspot");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error stopping system hotspot", e);
            notificationManager.showDebugNotification(
                    "Hotspot Error", "Error stopping hotspot: " + e.getMessage());
        }
    }

    @Override
    public void connectToWifi(String ssid, String password) {
        Log.d(TAG, "Connecting to WiFi network: " + ssid);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                connectWifiModern(ssid, password);
            } else {
                connectWifiLegacy(ssid, password);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error connecting to WiFi", e);
            notificationManager.showDebugNotification(
                    "WiFi Error", "Error connecting to WiFi: " + e.getMessage());
        }
    }

    @Override
    public void disconnectFromWifi() {
        Log.d(TAG, "Disconnecting from current WiFi network");

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // Modern Android - limited disconnect options due to security restrictions
                Log.w(TAG, "Android 10+ has limited WiFi disconnect capabilities");
                notificationManager.showDebugNotification(
                        "WiFi Disconnect", "Please disconnect manually via system settings");
            } else {
                // Legacy Android - can disconnect programmatically
                if (wifiManager != null) {
                    wifiManager.disconnect();
                    notificationManager.showDebugNotification(
                            "WiFi Disconnect", "Disconnected from WiFi network");
                    Log.d(TAG, "WiFi disconnect command sent");
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error disconnecting from WiFi", e);
            notificationManager.showDebugNotification(
                    "WiFi Error", "Error disconnecting from WiFi: " + e.getMessage());
        }
    }

    @Override
    public boolean forgetWifiNetwork(String ssid) {
        Log.d(TAG, "Forgetting WiFi network: " + ssid);

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // Modern Android - limited forget options due to security restrictions
                Log.w(TAG, "Android 10+ has limited WiFi forget capabilities");
                notificationManager.showDebugNotification(
                        "WiFi Forget", "Please forget '" + ssid + "' manually via system settings");
                return false;
            } else {
                // Legacy Android - can remove network programmatically
                return forgetWifiLegacy(ssid);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error forgetting WiFi network", e);
            notificationManager.showDebugNotification(
                    "WiFi Error", "Error forgetting WiFi network: " + e.getMessage());
            return false;
        }
    }

    @SuppressLint("MissingPermission")
    private boolean forgetWifiLegacy(String ssid) {
        try {
            if (wifiManager != null) {
                List<WifiConfiguration> configs = wifiManager.getConfiguredNetworks();
                if (configs != null) {
                    for (WifiConfiguration config : configs) {
                        if (config.SSID != null && config.SSID.equals("\"" + ssid + "\"")) {
                            boolean removed = wifiManager.removeNetwork(config.networkId);
                            if (removed) {
                                wifiManager.saveConfiguration();
                                notificationManager.showDebugNotification(
                                        "WiFi Network Forgotten", "Removed saved network: " + ssid);
                                Log.d(TAG, "WiFi network forgotten: " + ssid);
                            } else {
                                notificationManager.showDebugNotification(
                                        "WiFi Error", "Failed to forget network: " + ssid);
                            }
                            return removed;
                        }
                    }
                }
                Log.w(TAG, "Network not found in saved networks: " + ssid);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error forgetting WiFi network (legacy)", e);
        }
        return false;
    }

    @SuppressLint("MissingPermission")
    private void connectWifiLegacy(String ssid, String password) {
        try {
            WifiConfiguration config = new WifiConfiguration();
            config.SSID = "\"" + ssid + "\"";
            config.preSharedKey = "\"" + password + "\"";
            config.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.WPA_PSK);

            int networkId = wifiManager.addNetwork(config);
            if (networkId != -1) {
                boolean success = wifiManager.enableNetwork(networkId, true);
                if (success) {
                    notificationManager.showDebugNotification(
                            "WiFi Connection", "Attempting to connect to: " + ssid);

                    // Monitor connection status
                    new Handler(Looper.getMainLooper())
                            .postDelayed(
                                    new Runnable() {
                                        @Override
                                        public void run() {
                                            if (isConnectedToWifi()) {
                                                notificationManager.showDebugNotification(
                                                        "WiFi Connected",
                                                        "Successfully connected to: " + ssid);
                                            } else {
                                                notificationManager.showDebugNotification(
                                                        "WiFi Failed",
                                                        "Failed to connect to: " + ssid);
                                            }
                                        }
                                    },
                                    5000);
                } else {
                    notificationManager.showDebugNotification(
                            "WiFi Error", "Failed to enable network: " + ssid);
                }
            } else {
                notificationManager.showDebugNotification(
                        "WiFi Error", "Failed to add network: " + ssid);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error in legacy WiFi connection", e);
            notificationManager.showDebugNotification(
                    "WiFi Error", "Legacy connection failed: " + e.getMessage());
        }
    }

    private void connectWifiModern(String ssid, String password) {
        try {
            WifiNetworkSuggestion suggestion =
                    new WifiNetworkSuggestion.Builder()
                            .setSsid(ssid)
                            .setWpa2Passphrase(password)
                            .build();

            List<WifiNetworkSuggestion> suggestions = new ArrayList<>();
            suggestions.add(suggestion);

            int result = wifiManager.addNetworkSuggestions(suggestions);
            if (result == WifiManager.STATUS_NETWORK_SUGGESTIONS_SUCCESS) {
                notificationManager.showDebugNotification(
                        "WiFi Connection", "Network suggestion added for: " + ssid);

                // Monitor connection status
                new Handler(Looper.getMainLooper())
                        .postDelayed(
                                new Runnable() {
                                    @Override
                                    public void run() {
                                        if (isConnectedToWifi()) {
                                            notificationManager.showDebugNotification(
                                                    "WiFi Connected",
                                                    "Successfully connected to: " + ssid);
                                        } else {
                                            notificationManager.showDebugNotification(
                                                    "WiFi Failed", "Failed to connect to: " + ssid);
                                        }
                                    }
                                },
                                5000);
            } else {
                notificationManager.showDebugNotification(
                        "WiFi Error", "Failed to add network suggestion: " + ssid);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error in modern WiFi connection", e);
            notificationManager.showDebugNotification(
                    "WiFi Error", "Modern connection failed: " + e.getMessage());
        }
    }

    private void registerSuggestionReceiver() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            wifiSuggestionReceiver =
                    new BroadcastReceiver() {
                        @Override
                        public void onReceive(Context context, Intent intent) {
                            if (WifiManager.ACTION_WIFI_NETWORK_SUGGESTION_POST_CONNECTION.equals(
                                    intent.getAction())) {
                                Log.d(TAG, "WiFi network suggestion post-connection");
                            }
                        }
                    };

            IntentFilter filter =
                    new IntentFilter(WifiManager.ACTION_WIFI_NETWORK_SUGGESTION_POST_CONNECTION);
            context.registerReceiver(wifiSuggestionReceiver, filter);
        }
    }

    private void registerWifiStateReceiver() {
        wifiStateReceiver =
                new BroadcastReceiver() {
                    @Override
                    public void onReceive(Context context, Intent intent) {
                        String action = intent.getAction();
                        if (action != null) {
                            switch (action) {
                                case WifiManager.NETWORK_STATE_CHANGED_ACTION:
                                    boolean isConnected = isConnectedToWifi();
                                    notificationManager.showWifiStateNotification(isConnected);
                                    notifyWifiStateChanged(isConnected);
                                    break;
                                case WifiManager.WIFI_STATE_CHANGED_ACTION:
                                    int wifiState =
                                            intent.getIntExtra(
                                                    WifiManager.EXTRA_WIFI_STATE,
                                                    WifiManager.WIFI_STATE_UNKNOWN);
                                    Log.d(TAG, "WiFi state changed: " + wifiState);
                                    break;
                            }
                        }
                    }
                };

        IntentFilter filter = new IntentFilter();
        filter.addAction(WifiManager.NETWORK_STATE_CHANGED_ACTION);
        filter.addAction(WifiManager.WIFI_STATE_CHANGED_ACTION);
        context.registerReceiver(wifiStateReceiver, filter);
    }

    private void unregisterWifiStateReceiver() {
        if (wifiStateReceiver != null) {
            try {
                context.unregisterReceiver(wifiStateReceiver);
                wifiStateReceiver = null;
            } catch (IllegalArgumentException e) {
                Log.w(TAG, "Receiver already unregistered", e);
            }
        }

        if (wifiSuggestionReceiver != null) {
            try {
                context.unregisterReceiver(wifiSuggestionReceiver);
                wifiSuggestionReceiver = null;
            } catch (IllegalArgumentException e) {
                Log.w(TAG, "Suggestion receiver already unregistered", e);
            }
        }
    }

    @SuppressWarnings({"JavaReflectionMemberAccess", "unchecked"})
    private boolean enableHotspotInternal(String ssid, String password) {
        try {
            // Use reflection to access system hotspot APIs
            Class<?> wifiManagerClass = wifiManager.getClass();
            Method[] methods = wifiManagerClass.getDeclaredMethods();

            for (Method method : methods) {
                if (method.getName().contains("setWifiApEnabled")
                        || method.getName().contains("startTethering")) {
                    method.setAccessible(true);

                    if (method.getName().contains("setWifiApEnabled")) {
                        // Legacy method
                        Object result = method.invoke(wifiManager, null, true);
                        return result != null && (Boolean) result;
                    } else if (method.getName().contains("startTethering")) {
                        // Modern method
                        method.invoke(wifiManager, true);
                        return true;
                    }
                }
            }

            Log.w(TAG, "No suitable hotspot method found");
            return false;
        } catch (Exception e) {
            Log.e(TAG, "Error enabling hotspot via reflection", e);
            return false;
        }
    }

    @SuppressWarnings({"JavaReflectionMemberAccess", "unchecked"})
    private boolean disableHotspotInternal() {
        try {
            // Use reflection to access system hotspot APIs
            Class<?> wifiManagerClass = wifiManager.getClass();
            Method[] methods = wifiManagerClass.getDeclaredMethods();

            for (Method method : methods) {
                if (method.getName().contains("setWifiApEnabled")
                        || method.getName().contains("stopTethering")) {
                    method.setAccessible(true);

                    if (method.getName().contains("setWifiApEnabled")) {
                        // Legacy method
                        Object result = method.invoke(wifiManager, null, false);
                        return result != null && (Boolean) result;
                    } else if (method.getName().contains("stopTethering")) {
                        // Modern method
                        method.invoke(wifiManager, false);
                        return true;
                    }
                }
            }

            Log.w(TAG, "No suitable hotspot method found");
            return false;
        } catch (Exception e) {
            Log.e(TAG, "Error disabling hotspot via reflection", e);
            return false;
        }
    }

    private void startServer() {
        if (!isServerRunning) {
            isServerRunning = true;
            serverThread =
                    new Thread(
                            new Runnable() {
                                @Override
                                public void run() {
                                    startServer(listenPort);
                                }
                            });
            serverThread.start();
        }
    }

    private void startServer(int port) {
        try (ServerSocket serverSocket = new ServerSocket()) {
            serverSocket.setReuseAddress(true);
            serverSocket.bind(new InetSocketAddress(port));

            Log.i(TAG, "Hotspot server started on port " + port);

            while (isServerRunning) {
                try {
                    Socket client = serverSocket.accept();
                    new Thread(
                                    new Runnable() {
                                        @Override
                                        public void run() {
                                            handleClient(client);
                                        }
                                    })
                            .start();
                } catch (IOException e) {
                    if (isServerRunning) {
                        Log.e(TAG, "Error accepting client", e);
                    }
                }
            }
        } catch (IOException e) {
            Log.e(TAG, "Error starting server", e);
        }
    }

    private void stopServer() {
        isServerRunning = false;
        if (serverThread != null) {
            serverThread.interrupt();
            serverThread = null;
        }
    }

    private void runServer(int port) {
        try (ServerSocket serverSocket = new ServerSocket(port)) {
            Log.i(TAG, "Server listening on port " + port);

            while (isServerRunning) {
                try {
                    Socket client = serverSocket.accept();
                    new Thread(
                                    new Runnable() {
                                        @Override
                                        public void run() {
                                            handleClient(client);
                                        }
                                    })
                            .start();
                } catch (IOException e) {
                    if (isServerRunning) {
                        Log.e(TAG, "Error accepting client", e);
                    }
                }
            }
        } catch (IOException e) {
            Log.e(TAG, "Error in server", e);
        }
    }

    private String loadHotspotLandingPage() {
        if (hotspotLandingPage == null) {
            try {
                hotspotLandingPage = HotspotLandingPage.load(context);
            } catch (IOException e) {
                Log.e(TAG, "Failed to load hotspot landing page", e);
                hotspotLandingPage = "";
            }
        }
        return hotspotLandingPage;
    }

    private void handleClient(Socket client) {
        try (BufferedReader reader =
                        new BufferedReader(new InputStreamReader(client.getInputStream()));
                OutputStream output = client.getOutputStream()) {

            String requestLine = reader.readLine();
            if (requestLine == null) {
                return;
            }

            boolean isPost = requestLine.startsWith("POST");
            boolean isGet = requestLine.startsWith("GET");
            if (!isPost && !isGet) {
                return;
            }

            int contentLength = 0;
            String headerLine;
            while ((headerLine = reader.readLine()) != null && !headerLine.isEmpty()) {
                contentLength =
                        Math.max(
                                contentLength,
                                HotspotSetupRequestParser.parseContentLengthHeader(headerLine));
            }

            HotspotSetupRequestParser.Credentials credentials = null;
            if (isPost) {
                String body = HotspotSetupRequestParser.readHttpBody(reader, contentLength);
                credentials = HotspotSetupRequestParser.parseFormUrlEncoded(body);
            } else {
                credentials = HotspotSetupRequestParser.parseGetRequestLine(requestLine);
            }

            String responseBody;
            if (credentials != null && credentials.hasWifiCredentials()) {
                final String finalSsid = credentials.ssid;
                final String finalPassword = credentials.password;
                final String finalToken = credentials.token;
                new Handler(Looper.getMainLooper())
                        .post(
                                () -> {
                                    connectToWifi(finalSsid, finalPassword);
                                    notifyWifiCredentialsReceived(
                                            finalSsid, finalPassword, finalToken);
                                });
                responseBody = buildHotspotSuccessPage(finalSsid);
            } else {
                responseBody = loadHotspotLandingPage();
            }

            HotspotSetupRequestParser.writeHtmlResponse(output, responseBody);
            output.flush();
        } catch (IOException e) {
            Log.e(TAG, "Error handling client", e);
        } finally {
            try {
                client.close();
            } catch (IOException e) {
                Log.e(TAG, "Error closing client", e);
            }
        }
    }

    private static String buildHotspotSuccessPage(String ssid) {
        return "<html><head><title>WiFi Setup Complete</title>"
                + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">"
                + "<style>body{font-family:sans-serif;margin:0;padding:20px;line-height:1.5;} "
                + "h1{color:#4285f4;} .success{color:green;font-weight:bold;}</style></head>"
                + "<body><h1>WiFi Setup Complete</h1>"
                + "<p class=\"success\">Attempting to connect to network: "
                + HotspotSetupRequestParser.escapeHtml(ssid)
                + "</p>"
                + "<p>The glasses are now attempting to connect to your WiFi network. "
                + "If successful, they will automatically connect to the MentraOS backend.</p>"
                + "<p>Please close this window and return to the MentraOS app.</p>"
                + "</body></html>";
    }

    @SuppressLint("MissingPermission")
    @Override
    public List<String> getConfiguredWifiNetworks() {
        List<String> networks = new ArrayList<>();

        try {
            List<WifiConfiguration> configurations = wifiManager.getConfiguredNetworks();
            if (configurations != null) {
                for (WifiConfiguration config : configurations) {
                    if (config.SSID != null) {
                        String ssid = config.SSID;
                        if (ssid.startsWith("\"") && ssid.endsWith("\"")) {
                            ssid = ssid.substring(1, ssid.length() - 1);
                        }
                        networks.add(ssid);
                    }
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error getting configured networks", e);
        }

        return networks;
    }

    @Override
    public List<String> scanWifiNetworks() {
        List<String> networks = new ArrayList<>();

        try {
            if (!wifiManager.isWifiEnabled()) {
                Log.e(TAG, "WiFi not enabled for scan");
                return networks;
            }

            final CountDownLatch scanLatch = new CountDownLatch(1);
            final AtomicBoolean scanCompleted = new AtomicBoolean(false);

            // Create a receiver for scan results
            BroadcastReceiver wifiScanReceiver =
                    new BroadcastReceiver() {
                        @Override
                        public void onReceive(Context context, Intent intent) {
                            if (WifiManager.SCAN_RESULTS_AVAILABLE_ACTION.equals(
                                    intent.getAction())) {
                                if (scanCompleted.compareAndSet(false, true)) {
                                    boolean success =
                                            intent.getBooleanExtra(
                                                    WifiManager.EXTRA_RESULTS_UPDATED, false);
                                    Log.d(TAG, "System scan completed, success=" + success);

                                    try {
                                        List<ScanResult> scanResults = wifiManager.getScanResults();
                                        if (scanResults != null) {
                                            for (ScanResult result : scanResults) {
                                                String ssid = result.SSID;
                                                if (ssid != null
                                                        && !ssid.isEmpty()
                                                        && !networks.contains(ssid)) {
                                                    networks.add(ssid);
                                                    Log.d(TAG, "Found network: " + ssid);
                                                }
                                            }
                                        }
                                    } catch (SecurityException se) {
                                        Log.e(TAG, "No permission to access scan results", se);
                                    } catch (Exception e) {
                                        Log.e(TAG, "Error processing scan results", e);
                                    }

                                    scanLatch.countDown();
                                }
                            }
                        }
                    };

            // Register the receiver
            IntentFilter intentFilter = new IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION);
            context.registerReceiver(wifiScanReceiver, intentFilter);

            // Start the scan
            boolean scanStarted = wifiManager.startScan();
            Log.d(TAG, "System WiFi scan started, success=" + scanStarted);

            if (!scanStarted) {
                Log.e(TAG, "Failed to start system WiFi scan");

                // Try to get previous scan results
                try {
                    List<ScanResult> scanResults = wifiManager.getScanResults();
                    if (scanResults != null && !scanResults.isEmpty()) {
                        for (ScanResult result : scanResults) {
                            String ssid = result.SSID;
                            if (ssid != null && !ssid.isEmpty()) {
                                networks.add(ssid);
                                Log.d(TAG, "Found network from previous scan: " + ssid);
                            }
                        }
                    }
                } catch (SecurityException se) {
                    Log.e(TAG, "No permission to access previous scan results", se);
                } catch (Exception e) {
                    Log.e(TAG, "Error getting previous scan results", e);
                }

                // Unregister the receiver
                try {
                    context.unregisterReceiver(wifiScanReceiver);
                } catch (Exception e) {
                    Log.e(TAG, "Error unregistering scan receiver", e);
                }

                return networks;
            }

            // Wait for the scan to complete
            try {
                boolean completed = scanLatch.await(15, TimeUnit.SECONDS);
                Log.d(
                        TAG,
                        "System scan await completed="
                                + completed
                                + ", scanComplete="
                                + scanCompleted.get());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                Log.e(TAG, "Interrupted waiting for scan results", e);
            }

            // Unregister the receiver
            try {
                context.unregisterReceiver(wifiScanReceiver);
            } catch (Exception e) {
                Log.e(TAG, "Error unregistering scan receiver", e);
            }

            // Add the current network if not already in the list
            String currentSsid = getCurrentWifiSsid();
            if (!currentSsid.isEmpty() && !networks.contains(currentSsid)) {
                networks.add(currentSsid);
                Log.d(TAG, "Added current network to scan results: " + currentSsid);
            }

            Log.d(TAG, "Found " + networks.size() + " networks with system scan");

        } catch (Exception e) {
            Log.e(TAG, "Error in system WiFi scanning", e);
        }

        return networks;
    }

    @Override
    public void scanWifiNetworks(IWifiScanCallback callback) {
        Log.d(TAG, "📡 =========================================");
        Log.d(TAG, "📡 SYSTEM STREAMING WIFI SCAN STARTED");
        Log.d(TAG, "📡 =========================================");

        final List<String> allFoundNetworkSsids = new ArrayList<>();

        try {
            if (!wifiManager.isWifiEnabled()) {
                Log.e(TAG, "WiFi not enabled for scan");
                callback.onScanError("WiFi not enabled");
                return;
            }

            final CountDownLatch scanLatch = new CountDownLatch(1);
            final AtomicBoolean scanCompleted = new AtomicBoolean(false);

            // Create a receiver for scan results
            BroadcastReceiver wifiScanReceiver =
                    new BroadcastReceiver() {
                        @Override
                        public void onReceive(Context context, Intent intent) {
                            if (WifiManager.SCAN_RESULTS_AVAILABLE_ACTION.equals(
                                    intent.getAction())) {
                                if (scanCompleted.compareAndSet(false, true)) {
                                    boolean success =
                                            intent.getBooleanExtra(
                                                    WifiManager.EXTRA_RESULTS_UPDATED, false);
                                    Log.d(
                                            TAG,
                                            "System streaming scan completed, success=" + success);

                                    try {
                                        List<ScanResult> scanResults = wifiManager.getScanResults();
                                        if (scanResults != null) {
                                            List<String> newNetworks = new ArrayList<>();
                                            for (ScanResult result : scanResults) {
                                                String ssid = result.SSID;
                                                if (ssid != null
                                                        && !ssid.isEmpty()
                                                        && !allFoundNetworkSsids.contains(ssid)) {
                                                    allFoundNetworkSsids.add(ssid);
                                                    newNetworks.add(ssid);
                                                    Log.d(TAG, "Found network: " + ssid);
                                                }
                                            }

                                            // Stream all networks found in this scan
                                            if (!newNetworks.isEmpty()) {
                                                Log.d(
                                                        TAG,
                                                        "📡 Streaming "
                                                                + newNetworks.size()
                                                                + " new networks to callback");
                                                callback.onNetworksFound(newNetworks);
                                            }
                                        }
                                    } catch (SecurityException se) {
                                        Log.e(TAG, "No permission to access scan results", se);
                                    } catch (Exception e) {
                                        Log.e(TAG, "Error processing scan results", e);
                                    }

                                    scanLatch.countDown();
                                }
                            }
                        }
                    };

            // Register the receiver
            IntentFilter intentFilter = new IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION);
            context.registerReceiver(wifiScanReceiver, intentFilter);

            // Start the scan
            boolean scanStarted = wifiManager.startScan();
            Log.d(TAG, "System WiFi scan started, success=" + scanStarted);

            if (!scanStarted) {
                Log.e(TAG, "Failed to start system WiFi scan");

                // Try to get previous scan results
                try {
                    List<ScanResult> scanResults = wifiManager.getScanResults();
                    if (scanResults != null && !scanResults.isEmpty()) {
                        List<String> networks = new ArrayList<>();
                        for (ScanResult result : scanResults) {
                            String ssid = result.SSID;
                            if (ssid != null && !ssid.isEmpty()) {
                                networks.add(ssid);
                                Log.d(TAG, "Found network from previous scan: " + ssid);
                            }
                        }

                        // Stream results from previous scan
                        if (!networks.isEmpty()) {
                            callback.onNetworksFound(networks);
                            allFoundNetworkSsids.addAll(networks);
                        }
                    }
                } catch (SecurityException se) {
                    Log.e(TAG, "No permission to access previous scan results", se);
                } catch (Exception e) {
                    Log.e(TAG, "Error getting previous scan results", e);
                }

                // Unregister the receiver
                try {
                    context.unregisterReceiver(wifiScanReceiver);
                } catch (Exception e) {
                    Log.e(TAG, "Error unregistering scan receiver", e);
                }

                callback.onScanComplete(allFoundNetworkSsids.size());
                return;
            }

            // Wait for the scan to complete
            try {
                boolean completed = scanLatch.await(15, TimeUnit.SECONDS);
                Log.d(
                        TAG,
                        "System scan await completed="
                                + completed
                                + ", scanComplete="
                                + scanCompleted.get());
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                Log.e(TAG, "Interrupted waiting for scan results", e);
            }

            // Unregister the receiver
            try {
                context.unregisterReceiver(wifiScanReceiver);
            } catch (Exception e) {
                Log.e(TAG, "Error unregistering scan receiver", e);
            }

            // Add the current network if not already in the list
            String currentSsid = getCurrentWifiSsid();
            if (!currentSsid.isEmpty() && !allFoundNetworkSsids.contains(currentSsid)) {
                allFoundNetworkSsids.add(currentSsid);
                List<String> currentNetwork = new ArrayList<>();
                currentNetwork.add(currentSsid);
                callback.onNetworksFound(currentNetwork);
                Log.d(TAG, "Added current network to scan results: " + currentSsid);
            }

            callback.onScanComplete(allFoundNetworkSsids.size());

        } catch (Exception e) {
            Log.e(TAG, "Error in system streaming WiFi scan", e);
            callback.onScanError("Scan failed: " + e.getMessage());
        }

        Log.d(
                TAG,
                "📡 System streaming scan completed with "
                        + allFoundNetworkSsids.size()
                        + " total networks");
    }

    @Override
    public void shutdown() {
        Log.d(TAG, "Shutting down SystemNetworkManager");
        stopServer();
        unregisterWifiStateReceiver();
        super.shutdown();
    }
}
