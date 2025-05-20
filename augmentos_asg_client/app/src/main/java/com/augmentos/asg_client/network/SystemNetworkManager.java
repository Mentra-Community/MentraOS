package com.augmentos.asg_client.network;

import android.annotation.SuppressLint;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.wifi.WifiConfiguration;
import android.net.wifi.WifiManager;
import android.net.wifi.WifiNetworkSuggestion;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

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

/**
 * Implementation of INetworkManager for devices with system permissions.
 * Uses reflection to access system APIs for WiFi and hotspot control.
 */
public class SystemNetworkManager extends BaseNetworkManager {
    private static final String TAG = "SystemNetworkManager";
    
    // Constants for hotspot configuration
    private static final String HOTSPOT_SSID_PREFIX = "AugmentOS_";
    private static final String DEFAULT_HOTSPOT_PASSWORD = "augmentos1234";
    private static final int DEFAULT_WEBSERVER_PORT = 8080;
    
    // HTML content for the hotspot landing page
    private static final String HOTSPOT_LANDING_PAGE = "<html><head><title>AugmentOS WiFi Setup</title>" +
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">" +
            "<style>body{font-family:sans-serif;margin:0;padding:20px;line-height:1.5;} " +
            "h1{color:#4285f4;} form{margin-top:20px;} " +
            "label{display:block;margin-bottom:5px;font-weight:bold;} " +
            "input[type=text],input[type=password]{width:100%;padding:8px;margin-bottom:15px;border:1px solid #ddd;border-radius:4px;} " +
            "button{background:#4285f4;color:white;border:none;padding:10px 15px;border-radius:4px;cursor:pointer;} " +
            "button:hover{background:#2a75f3;}</style></head>" +
            "<body><h1>AugmentOS WiFi Setup</h1>" +
            "<p>Please enter your WiFi network details to connect these glasses to the internet:</p>" +
            "<form id=\"wifiForm\" method=\"GET\" action=\"/\">" +
            "<label for=\"ssid\">WiFi Network Name:</label>" +
            "<input type=\"text\" id=\"ssid\" name=\"ssid\" required>" +
            "<label for=\"pass\">WiFi Password:</label>" +
            "<input type=\"password\" id=\"pass\" name=\"pass\" required>" +
            "<label for=\"token\">Auth Token (optional):</label>" +
            "<input type=\"text\" id=\"token\" name=\"token\">" +
            "<button type=\"submit\">Connect</button></form>" +
            "<script>document.getElementById('wifiForm').onsubmit = function() {" +
            "alert('Connecting to network... The glasses will reboot if successful.');" +
            "};</script></body></html>";
    
    private final WifiManager wifiManager;
    private final DebugNotificationManager notificationManager;
    private BroadcastReceiver wifiStateReceiver;
    private BroadcastReceiver wifiSuggestionReceiver;
    
    // Server state
    private boolean isServerRunning = false;
    private Thread serverThread;
    private int listenPort = DEFAULT_WEBSERVER_PORT;
    
    /**
     * Create a new SystemNetworkManager
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
                        "WiFi Enabling", 
                        "Attempting to enable WiFi");
                
                // Start a thread to wait for WiFi to be enabled and connect
                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            // Wait for WiFi to be enabled and try to connect
                            for (int i = 0; i < 10; i++) {  // Try for up to 10 seconds
                                Thread.sleep(1000);  // Wait 1 second between checks
                                
                                if (wifiManager.isWifiEnabled()) {
                                    Log.d(TAG, "WiFi enabled, waiting for connection...");
                                    
                                    // Wait a bit more for it to connect to any known networks
                                    Thread.sleep(5000);
                                    
                                    // Check final state on main thread
                                    new Handler(Looper.getMainLooper()).post(new Runnable() {
                                        @Override
                                        public void run() {
                                            boolean connected = isConnectedToWifi();
                                            notifyWifiStateChanged(connected);
                                            
                                            if (!connected) {
                                                // If still not connected, start hotspot
                                                notificationManager.showDebugNotification(
                                                        "WiFi Not Connected", 
                                                        "Unable to connect to WiFi, starting hotspot");
                                                startHotspot(null, null);
                                            }
                                        }
                                    });
                                    return;
                                }
                            }
                            
                            // If we get here, WiFi didn't turn on in time
                            Log.e(TAG, "WiFi did not turn on in time, falling back to hotspot");
                            new Handler(Looper.getMainLooper()).post(new Runnable() {
                                @Override
                                public void run() {
                                    startHotspot(null, null);
                                }
                            });
                        } catch (Exception e) {
                            Log.e(TAG, "Error waiting for WiFi", e);
                        }
                    }
                }).start();
            }
        } catch (Exception e) {
            Log.e(TAG, "Error enabling WiFi", e);
            notificationManager.showDebugNotification(
                    "WiFi Error", 
                    "Error enabling WiFi: " + e.getMessage());
        }
    }
    
    @Override
    public void disableWifi() {
        try {
            if (wifiManager.isWifiEnabled()) {
                wifiManager.setWifiEnabled(false);
                notificationManager.showDebugNotification(
                        "WiFi Disabling", 
                        "Disabling WiFi");
            }
        } catch (Exception e) {
            Log.e(TAG, "Error disabling WiFi", e);
            notificationManager.showDebugNotification(
                    "WiFi Error", 
                    "Error disabling WiFi: " + e.getMessage());
        }
    }
    
    @Override
    public void startHotspot(String ssid, String password) {
        // Use reasonable defaults if not provided
        if (ssid == null || ssid.isEmpty()) {
            ssid = HOTSPOT_SSID_PREFIX + System.currentTimeMillis() % 1000;
        }
        
        if (password == null || password.isEmpty() || password.length() < 8) {
            password = DEFAULT_HOTSPOT_PASSWORD;
        }
        
        boolean success = enableHotspotInternal(ssid, password);
        if (success) {
            notificationManager.showDebugNotification(
                    "Hotspot Started", 
                    "Hotspot started with SSID: " + ssid);
            
            // Start the web server
            startServer();
            
            // Notify listeners
            notifyHotspotStateChanged(true);
            notificationManager.showHotspotStateNotification(true);
        } else {
            notificationManager.showDebugNotification(
                    "Hotspot Error", 
                    "Failed to start hotspot");
        }
    }
    
    @Override
    public void stopHotspot() {
        boolean success = disableHotspotInternal();
        if (success) {
            notificationManager.showDebugNotification(
                    "Hotspot Stopped", 
                    "Hotspot has been stopped");
            
            // Stop the web server
            stopServer();
            
            // Notify listeners
            notifyHotspotStateChanged(false);
            notificationManager.showHotspotStateNotification(false);
        } else {
            notificationManager.showDebugNotification(
                    "Hotspot Error", 
                    "Failed to stop hotspot");
        }
    }
    
    @Override
    public void connectToWifi(String ssid, String password) {
        if (ssid == null || ssid.isEmpty()) {
            Log.e(TAG, "Cannot connect to WiFi with empty SSID");
            return;
        }
        
        try {
            // First ensure WiFi is enabled
            if (!wifiManager.isWifiEnabled()) {
                wifiManager.setWifiEnabled(true);
            }
            
            // Disable hotspot if it's running
            if (isHotspotEnabled) {
                stopHotspot();
            }
            
            // Use the appropriate method based on Android version
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) { // Android 10+
                connectWifiModern(ssid, password);
            } else {
                connectWifiLegacy(ssid, password);
            }
            
            notificationManager.showDebugNotification(
                    "WiFi Connection", 
                    "Attempting to connect to: " + ssid);
        } catch (Exception e) {
            Log.e(TAG, "Error connecting to WiFi", e);
            notificationManager.showDebugNotification(
                    "WiFi Error", 
                    "Error connecting to WiFi: " + e.getMessage());
        }
    }
    
    /**
     * Connect to WiFi using the legacy WifiConfiguration approach (Android 9 and below)
     */
    @SuppressLint("MissingPermission")
    private void connectWifiLegacy(String ssid, String password) {
        Log.d(TAG, "Using legacy WiFi connection method");
        
        try {
            // Create the WifiConfiguration
            WifiConfiguration config = new WifiConfiguration();
            config.SSID = "\"" + ssid + "\"";
            
            if (password == null || password.isEmpty()) {
                // Open network
                config.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE);
            } else {
                // WPA/WPA2 network
                config.preSharedKey = "\"" + password + "\"";
                config.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.WPA_PSK);
            }
            
            // Add the network
            int netId = wifiManager.addNetwork(config);
            if (netId == -1) {
                Log.e(TAG, "Failed to add network configuration for SSID: " + ssid);
                return;
            }
            
            // Enable and connect
            boolean enabled = wifiManager.enableNetwork(netId, true);
            boolean reconnect = wifiManager.reconnect();
            
            Log.d(TAG, "WiFi connection: enableNetwork=" + enabled + ", reconnect=" + reconnect);
            
            // Poll connection status
            new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        for (int i = 0; i < 15; i++) { // Try for up to 30 seconds
                            Thread.sleep(2000);
                            if (isConnectedToWifi()) {
                                new Handler(Looper.getMainLooper()).post(new Runnable() {
                                    @Override
                                    public void run() {
                                        notifyWifiStateChanged(true);
                                        notificationManager.showWifiStateNotification(true);
                                    }
                                });
                                return;
                            }
                        }
                        
                        // If we get here, connection failed
                        new Handler(Looper.getMainLooper()).post(new Runnable() {
                            @Override
                            public void run() {
                                notificationManager.showDebugNotification(
                                        "WiFi Connection Failed", 
                                        "Failed to connect to " + ssid + " after multiple attempts");
                            }
                        });
                    } catch (InterruptedException e) {
                        Log.e(TAG, "WiFi connection polling interrupted", e);
                    }
                }
            }).start();
        } catch (Exception e) {
            Log.e(TAG, "Error connecting to WiFi", e);
        }
    }
    
    /**
     * Connect to WiFi using the modern WifiNetworkSuggestion approach (Android 10+)
     */
    private void connectWifiModern(String ssid, String password) {
        Log.d(TAG, "Using modern WiFi connection method");
        
        try {
            // Remove existing suggestions
            wifiManager.removeNetworkSuggestions(new ArrayList<>());
            
            // Build the suggestion
            WifiNetworkSuggestion.Builder builder = new WifiNetworkSuggestion.Builder()
                    .setSsid(ssid)
                    .setIsAppInteractionRequired(false); // Silent connection
            
            if (password != null && !password.isEmpty()) {
                builder.setWpa2Passphrase(password);
            }
            
            WifiNetworkSuggestion suggestion = builder.build();
            
            // Add to list
            List<WifiNetworkSuggestion> suggestionsList = new ArrayList<>();
            suggestionsList.add(suggestion);
            
            // Add the suggestions to the WifiManager
            int status = wifiManager.addNetworkSuggestions(suggestionsList);
            if (status != WifiManager.STATUS_NETWORK_SUGGESTIONS_SUCCESS) {
                Log.e(TAG, "Failed to add network suggestions, status=" + status);
                return;
            }
            
            // Register for connection broadcasts
            registerSuggestionReceiver();
            
            // Poll connection status
            new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        for (int i = 0; i < 15; i++) { // Try for up to 30 seconds
                            Thread.sleep(2000);
                            if (isConnectedToWifi()) {
                                new Handler(Looper.getMainLooper()).post(new Runnable() {
                                    @Override
                                    public void run() {
                                        notifyWifiStateChanged(true);
                                        notificationManager.showWifiStateNotification(true);
                                    }
                                });
                                return;
                            }
                        }
                        
                        // If we get here, connection failed
                        new Handler(Looper.getMainLooper()).post(new Runnable() {
                            @Override
                            public void run() {
                                notificationManager.showDebugNotification(
                                        "WiFi Connection Failed", 
                                        "Failed to connect to " + ssid + " after multiple attempts");
                            }
                        });
                    } catch (InterruptedException e) {
                        Log.e(TAG, "WiFi connection polling interrupted", e);
                    }
                }
            }).start();
        } catch (Exception e) {
            Log.e(TAG, "Error connecting to WiFi using modern method", e);
        }
    }
    
    /**
     * Register a receiver for WiFi suggestion connection events
     */
    private void registerSuggestionReceiver() {
        if (wifiSuggestionReceiver != null) {
            return; // Already registered
        }
        
        wifiSuggestionReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (WifiManager.ACTION_WIFI_NETWORK_SUGGESTION_POST_CONNECTION.equals(intent.getAction())) {
                    Log.d(TAG, "Connected to suggested network");
                    notifyWifiStateChanged(true);
                    notificationManager.showWifiStateNotification(true);
                }
            }
        };
        
        IntentFilter filter = new IntentFilter(WifiManager.ACTION_WIFI_NETWORK_SUGGESTION_POST_CONNECTION);
        context.registerReceiver(wifiSuggestionReceiver, filter);
    }
    
    /**
     * Register a receiver for WiFi state changes
     */
    private void registerWifiStateReceiver() {
        if (wifiStateReceiver != null) {
            return; // Already registered
        }
        
        wifiStateReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (WifiManager.NETWORK_STATE_CHANGED_ACTION.equals(intent.getAction())) {
                    boolean connected = isConnectedToWifi();
                    
                    // Always update the notification based on the actual connection state
                    notificationManager.showWifiStateNotification(connected);
                    
                    // Important: This will verify the state and use the accurate value
                    notifyWifiStateChanged(connected);
                    
                    Log.d(TAG, "WiFi state changed broadcast - actual state: " + (connected ? "CONNECTED" : "DISCONNECTED"));
                    
                    if (!connected && !isHotspotEnabled) {
                        // Consider starting the hotspot if WiFi becomes disconnected
                        // and the hotspot isn't already running
                        Log.d(TAG, "WiFi disconnected, may need to start hotspot");
                    }
                }
            }
        };
        
        IntentFilter filter = new IntentFilter(WifiManager.NETWORK_STATE_CHANGED_ACTION);
        context.registerReceiver(wifiStateReceiver, filter);
    }
    
    /**
     * Unregister the WiFi state receiver
     */
    private void unregisterWifiStateReceiver() {
        if (wifiStateReceiver != null) {
            try {
                context.unregisterReceiver(wifiStateReceiver);
                wifiStateReceiver = null;
            } catch (Exception e) {
                Log.e(TAG, "Error unregistering WiFi receiver", e);
            }
        }
        
        if (wifiSuggestionReceiver != null) {
            try {
                context.unregisterReceiver(wifiSuggestionReceiver);
                wifiSuggestionReceiver = null;
            } catch (Exception e) {
                Log.e(TAG, "Error unregistering suggestion receiver", e);
            }
        }
    }
    
    /**
     * Enable the WiFi hotspot using reflection
     */
    @SuppressWarnings({"JavaReflectionMemberAccess", "unchecked"})
    private boolean enableHotspotInternal(String ssid, String password) {
        try {
            // First ensure WiFi is disabled (many devices can't run WiFi and hotspot simultaneously)
            if (wifiManager.isWifiEnabled()) {
                wifiManager.setWifiEnabled(false);
                // Give it a moment to disable
                Thread.sleep(1000);
            }
            
            // Create a simple open hotspot configuration
            WifiConfiguration apConfig = new WifiConfiguration();
            apConfig.SSID = ssid;
            
            if (password != null && password.length() >= 8) {
                apConfig.preSharedKey = password;
                apConfig.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.WPA_PSK);
            } else {
                apConfig.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE); // Open network
            }
            
            // Use reflection to access setWifiApEnabled method
            Method setWifiApMethod = wifiManager.getClass().getMethod(
                    "setWifiApEnabled", WifiConfiguration.class, boolean.class);
            
            // Enable the hotspot
            boolean result = (boolean) setWifiApMethod.invoke(wifiManager, apConfig, true);
            
            Log.d(TAG, "Hotspot enabled via reflection: " + result);
            
            if (result) {
                // Start a thread to monitor the hotspot state
                new Thread(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            // Wait a bit for the hotspot to start
                            Thread.sleep(1000);
                            
                            // Check if hotspot is active by using isWifiApEnabled method
                            Method isWifiApEnabledMethod = wifiManager.getClass().getMethod("isWifiApEnabled");
                            boolean isEnabled = (boolean) isWifiApEnabledMethod.invoke(wifiManager);
                            
                            if (isEnabled) {
                                Log.d(TAG, "Confirmed hotspot is active");
                            } else {
                                Log.e(TAG, "Hotspot did not start successfully");
                            }
                        } catch (Exception e) {
                            Log.e(TAG, "Error checking hotspot status", e);
                        }
                    }
                }).start();
            }
            
            return result;
        } catch (Exception e) {
            Log.e(TAG, "Error enabling hotspot with reflection", e);
            return false;
        }
    }
    
    /**
     * Disable the WiFi hotspot using reflection
     */
    @SuppressWarnings({"JavaReflectionMemberAccess", "unchecked"})
    private boolean disableHotspotInternal() {
        try {
            // Use the WifiManager approach with reflection
            Method setWifiApMethod = wifiManager.getClass().getMethod(
                    "setWifiApEnabled", WifiConfiguration.class, boolean.class);
            
            // Pass null config and false to disable
            boolean result = (boolean) setWifiApMethod.invoke(wifiManager, null, false);
            Log.d(TAG, "Disabled hotspot via reflection: " + result);
            
            if (result) {
                // Re-enable WiFi if needed
                if (!wifiManager.isWifiEnabled()) {
                    wifiManager.setWifiEnabled(true);
                }
            }
            
            return result;
        } catch (Exception e) {
            Log.e(TAG, "Error disabling hotspot with reflection", e);
            return false;
        }
    }
    
    // ----------------------------------------------------------------------------------------
    // WEB SERVER METHODS
    // ----------------------------------------------------------------------------------------
    
    /**
     * Start the HTTP server to serve the WiFi setup page
     */
    private void startServer() {
        if (isServerRunning) {
            Log.d(TAG, "Server already running on port " + listenPort);
            return;
        }
        
        serverThread = new Thread(new Runnable() {
            @Override
            public void run() {
                runServer(listenPort);
            }
        });
        serverThread.start();
    }
    
    /**
     * Start the server on the specified port
     */
    private void startServer(int port) {
        this.listenPort = port;
        startServer();
    }
    
    /**
     * Stop the HTTP server
     */
    private void stopServer() {
        if (!isServerRunning) {
            Log.d(TAG, "Server not running, so nothing to stop.");
            return;
        }
        
        isServerRunning = false; // Signal the thread to stop
        
        // The actual socket close is done in runServer()
        Log.d(TAG, "Web server stop requested");
    }
    
    /**
     * Run the HTTP server
     */
    private void runServer(int port) {
        ServerSocket serverSocket = null;
        
        try {
            serverSocket = new ServerSocket();
            serverSocket.setReuseAddress(true);
            serverSocket.bind(new InetSocketAddress(port));
            isServerRunning = true;
            
            Log.d(TAG, "Web server started on port: " + port);
            notificationManager.showDebugNotification(
                    "Web Server Started",
                    "Setup server is running on port " + port);
            
            while (isServerRunning) {
                // Accept blocks until a new connection arrives
                Socket client = serverSocket.accept();
                handleClient(client);
            }
        } catch (IOException e) {
            Log.e(TAG, "Server socket error: ", e);
        } finally {
            if (serverSocket != null) {
                try {
                    serverSocket.close();
                } catch (IOException ignore) {}
            }
            
            isServerRunning = false;
            Log.d(TAG, "Web server stopped");
            
            new Handler(Looper.getMainLooper()).post(new Runnable() {
                @Override
                public void run() {
                    notificationManager.showDebugNotification(
                            "Web Server Stopped",
                            "Setup server has been stopped");
                }
            });
        }
    }
    
    /**
     * Handle a client connection to the web server
     */
    private void handleClient(Socket client) {
        BufferedReader reader = null;
        OutputStream out = null;
        
        try {
            reader = new BufferedReader(new InputStreamReader(client.getInputStream()));
            out = client.getOutputStream();
            
            // Read the request line
            String requestLine = reader.readLine();
            Log.d(TAG, "Client request: " + requestLine);
            
            // Parse parameters if present
            String ssid = null;
            String pass = null;
            String token = null;
            
            if (requestLine != null) {
                // Check if the request has parameters
                int paramIndex = requestLine.indexOf("/?");
                if (paramIndex != -1) {
                    // Extract the query string
                    String query = requestLine.substring(paramIndex + 2);
                    int endIndex = query.indexOf(" HTTP/");
                    if (endIndex != -1) {
                        query = query.substring(0, endIndex);
                    }
                    
                    // Parse parameters
                    String[] pairs = query.split("&");
                    for (String pair : pairs) {
                        String[] kv = pair.split("=");
                        if (kv.length == 2) {
                            String key = kv[0].trim();
                            String value = kv[1].trim();
                            if ("ssid".equalsIgnoreCase(key)) {
                                ssid = value;
                            } else if ("pass".equalsIgnoreCase(key)) {
                                pass = value;
                            } else if ("token".equalsIgnoreCase(key)) {
                                token = value;
                            }
                        }
                    }
                }
            }
            
            // Consume all headers (important for HTTP compliance)
            String line;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                // Just read until the empty line that marks the end of headers
            }
            
            // Prepare response
            StringBuilder response = new StringBuilder();
            response.append("HTTP/1.1 200 OK\r\n");
            response.append("Content-Type: text/html\r\n");
            response.append("Connection: close\r\n");
            response.append("\r\n");
            
            // If we got parameters, process them and show confirmation page
            if (ssid != null) {
                response.append("<html><head><title>WiFi Setup Complete</title>");
                response.append("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">");
                response.append("<style>body{font-family:sans-serif;margin:0;padding:20px;line-height:1.5;} ");
                response.append("h1{color:#4285f4;} .success{color:green;font-weight:bold;}</style></head>");
                response.append("<body><h1>WiFi Setup Complete</h1>");
                response.append("<p class=\"success\">Attempting to connect to network: ").append(ssid).append("</p>");
                response.append("<p>The glasses are now attempting to connect to your WiFi network. ");
                response.append("If successful, they will automatically connect to the AugmentOS backend.</p>");
                response.append("<p>Please close this window and return to the AugmentOS app.</p>");
                response.append("</body></html>");
                
                // Send the response immediately
                out.write(response.toString().getBytes());
                out.flush();
                
                // Process the credentials
                final String finalSsid = ssid;
                final String finalPass = pass;
                final String finalToken = token;
                
                new Handler(Looper.getMainLooper()).post(new Runnable() {
                    @Override
                    public void run() {
                        // Notify any listeners
                        notifyWifiCredentialsReceived(finalSsid, finalPass, finalToken);
                        
                        // Connect to the WiFi network
                        connectToWifi(finalSsid, finalPass);
                    }
                });
            } else {
                // No parameters, show the setup form
                response.append(HOTSPOT_LANDING_PAGE);
                out.write(response.toString().getBytes());
                out.flush();
            }
        } catch (Exception e) {
            Log.e(TAG, "Error handling client connection", e);
        } finally {
            try {
                if (reader != null) reader.close();
                if (out != null) out.close();
                client.close();
            } catch (IOException ignore) {}
        }
    }
    
    /**
     * Get a list of configured WiFi networks
     * @return a list of WiFi network names (SSIDs)
     */
    @SuppressLint("MissingPermission")
    @Override
    public List<String> getConfiguredWifiNetworks() {
        List<String> networks = new ArrayList<>();
        
        try {
            // Check if we have WiFi Manager available
            if (wifiManager == null) {
                Log.e(TAG, "WiFi manager is null");
                return networks;
            }
            
            // Try to get the list of configured networks
            // This requires location permission on newer Android versions
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) { // Android 9 and below
                // Legacy approach - get configured networks directly
                List<WifiConfiguration> configs = wifiManager.getConfiguredNetworks();
                if (configs != null) {
                    for (WifiConfiguration config : configs) {
                        String ssid = config.SSID;
                        // Clean up the SSID (remove quotes)
                        if (ssid != null && ssid.startsWith("\"") && ssid.endsWith("\"")) {
                            ssid = ssid.substring(1, ssid.length() - 1);
                        }
                        
                        if (ssid != null && !ssid.isEmpty() && !ssid.equals("<unknown ssid>")) {
                            networks.add(ssid);
                            Log.d(TAG, "Found configured network: " + ssid);
                        }
                    }
                }
            } else {
                // For Android 10+ we need a different approach since we can't directly
                // access configured networks
                // Get the current network at minimum
                String currentSsid = getCurrentWifiSsid();
                if (!currentSsid.isEmpty()) {
                    networks.add(currentSsid);
                    Log.d(TAG, "Added current network to configured networks: " + currentSsid);
                }
                
                // For a more complete list, we'd need to use the NetworkSpecifier/SuggestionInfo API
                // but that's beyond the scope of this implementation
                Log.d(TAG, "Limited access to configured networks on Android 10+");
            }
            
            // Log the result
            if (networks.isEmpty()) {
                Log.d(TAG, "No configured networks found");
            } else {
                Log.d(TAG, "Found " + networks.size() + " configured networks");
            }
            
            return networks;
        } catch (Exception e) {
            Log.e(TAG, "Error getting configured WiFi networks", e);
            return networks;
        }
    }
    
    @Override
    public void shutdown() {
        super.shutdown();
        unregisterWifiStateReceiver();
        stopServer();
        
        if (isHotspotEnabled) {
            stopHotspot();
        }
    }
}