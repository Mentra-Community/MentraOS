package com.augmentos.asg_client;

import android.annotation.SuppressLint;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
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
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executor;

/**
 * A helper class that encapsulates:
 *  - Starting/stopping a Wi-Fi hotspot (uses TetheringManager on Android 11+)
 *  - Spinning up a minimal local HTTP server to accept Wi-Fi credentials
 *  - Connecting to Wi-Fi (modern approach using WifiNetworkSuggestion)
 *  - Automatically checking WiFi state on boot and creating fallback hotspot if needed
 *
 *  Use the {@link NetworkSetupCallback} to receive notifications when credentials arrive
 *  and when Wi-Fi connection attempts succeed/fail, so your service can react accordingly.
 */
public class NetworkSetupManager {

    private static final String TAG = "NetworkSetupManager";

    private final Context context;
    private final WifiManager wifiManager;
    private final NetworkSetupCallback callback;
    private BroadcastReceiver wifiSuggestionReceiver;
    private BroadcastReceiver wifiStateReceiver;

    // Simple flags
    private boolean isHotspotEnabled = false;
    private boolean isServerRunning = false;
    private boolean isAutoConnectEnabled = false;

    // Thread and port for our minimal HTTP server
    private Thread serverThread;
    private int listenPort = 8080;  // Use any open port; can be changed if needed
    
    // Constants for the hotspot
    private static final String HOTSPOT_SSID_PREFIX = "AugmentOS_";
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

    /**
     * Constructor requires:
     *  1) A Context (preferably getApplicationContext() to avoid leaks)
     *  2) A callback for events (e.g. credentials received, Wi-Fi success/failure)
     */
    public NetworkSetupManager(Context context, NetworkSetupCallback callback) {
        this.context = context.getApplicationContext();
        this.callback = callback;
        this.wifiManager = (WifiManager) this.context.getSystemService(Context.WIFI_SERVICE);
    }

    /**
     * Initialize the network setup system.
     * This will check the current WiFi state and take appropriate action:
     * - If connected to WiFi, it notifies the callback
     * - If not connected, it starts the hotspot and web server
     */
    public void initialize() {
        isAutoConnectEnabled = true;
        
        // Register for WiFi state changes to handle reconnection
        registerWifiStateReceiver();
        
        // Check initial WiFi state
        checkAndHandleWifiState();
    }

    /**
     * Stop automatically managing connections
     */
    public void shutdown() {
        isAutoConnectEnabled = false;
        unregisterReceivers();
        
        if (isHotspotEnabled) {
            stopHotspot();
        }
        
        if (isServerRunning) {
            stopServer();
        }
    }

    /**
     * Checks the current WiFi state and takes appropriate action
     */
    private void checkAndHandleWifiState() {
        // First, make sure WiFi is enabled
        if (!wifiManager.isWifiEnabled()) {
            Log.d(TAG, "WiFi is disabled, enabling it");
            wifiManager.setWifiEnabled(true);
            
            // Give WiFi some time to turn on and connect
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
                                        checkWifiConnectionState();
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
                                startHotspot();
                                startServer();
                            }
                        });
                    } catch (Exception e) {
                        Log.e(TAG, "Error while waiting for WiFi: " + e.getMessage());
                    }
                }
            }).start();
        } else {
            // WiFi is already enabled, check connection state
            checkWifiConnectionState();
        }
    }
    
    /**
     * Checks if we're connected to WiFi and takes appropriate action
     */
    private void checkWifiConnectionState() {
        if (isConnectedToWifi()) {
            Log.d(TAG, "Already connected to WiFi network");
            if (isHotspotEnabled) {
                stopHotspot();
            }
            if (isServerRunning) {
                stopServer();
            }
            callback.onWifiConnectionSuccess();
        } else {
            Log.d(TAG, "Not connected to WiFi, starting hotspot and web server");
            startHotspot();
            startServer();
        }
    }

    /**
     * Start the Wi-Fi hotspot (AP mode).
     * Uses TetheringManager on Android 11 (API 30)
     */
    public void startHotspot() {
        Log.d(TAG, "startHotspot invoked");
        if (!isHotspotEnabled) {
            boolean success = enableHotspotInternal();
            if (success) {
                isHotspotEnabled = true;
                Log.d(TAG, "Hotspot start requested successfully.");
                // Actual callback will come through the TetheringManager callback
            } else {
                Log.e(TAG, "Failed to start hotspot.");
            }
        } else {
            Log.d(TAG, "Hotspot is already enabled, doing nothing.");
        }
    }

    /**
     * Stop the Wi-Fi hotspot (AP mode).
     * Uses TetheringManager on Android 11 (API 30)
     */
    public void stopHotspot() {
        Log.d(TAG, "stopHotspot invoked");
        if (isHotspotEnabled) {
            boolean success = disableHotspotInternal();
            if (success) {
                isHotspotEnabled = false;
                Log.d(TAG, "Hotspot stop requested successfully.");
                callback.onHotspotStopped();
            } else {
                Log.e(TAG, "Failed to stop hotspot.");
            }
        } else {
            Log.d(TAG, "Hotspot is not active, so nothing to stop.");
        }
    }

    /**
     * Start a minimal HTTP server to listen for Wi-Fi credentials + optional auth token.
     * For real usage, consider NanoHTTPD or another robust library with HTTPS support.
     */
    public void startServer(int port) {
        if (isServerRunning) {
            Log.d(TAG, "Server already running on port " + listenPort);
            return;
        }

        this.listenPort = port;
        serverThread = new Thread(() -> runServer(listenPort));
        serverThread.start();
    }

    /**
     * Overload for convenience if you want a default port.
     */
    public void startServer() {
        startServer(listenPort);  // use the existing or default port
    }

    /**
     * Stop the HTTP server if it's running.
     */
    public void stopServer() {
        if (!isServerRunning) {
            Log.d(TAG, "Server not running, so nothing to stop.");
            return;
        }
        isServerRunning = false; // signaling the thread to close
        // The actual socket close is done in runServer()
        Log.d(TAG, "stopServer requested; server will shut down soon.");
        callback.onServerStopped();
    }

    /**
     * Attempt to connect to the specified Wi-Fi network
     */
    public void connectToWifi(String ssid, String password) {
        Log.d(TAG, "connectToWifi -> SSID: " + ssid);

        // Optionally disable the hotspot here if concurrency isn't supported:
        if (isHotspotEnabled) {
            Log.d(TAG, "Disabling hotspot before connecting to Wi-Fi.");
            stopHotspot();
        }

        // Use the modern approach for Android 10+
        connectWifiModern(ssid, password);
    }

    /**
     * Register a receiver to monitor WiFi state changes
     */
    private void registerWifiStateReceiver() {
        if (wifiStateReceiver != null) {
            return;  // Already registered
        }

        wifiStateReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (WifiManager.NETWORK_STATE_CHANGED_ACTION.equals(intent.getAction())) {
                    if (isAutoConnectEnabled) {
                        checkAndHandleWifiState();
                    }
                }
            }
        };

        IntentFilter filter = new IntentFilter();
        filter.addAction(WifiManager.NETWORK_STATE_CHANGED_ACTION);
        context.registerReceiver(wifiStateReceiver, filter);
    }

    /**
     * Unregister all receivers to prevent leaks
     */
    private void unregisterReceivers() {
        unregisterPostConnectionReceiver();
        
        if (wifiStateReceiver != null) {
            try {
                context.unregisterReceiver(wifiStateReceiver);
            } catch (Exception e) {
                Log.e(TAG, "Error unregistering wifiStateReceiver", e);
            }
            wifiStateReceiver = null;
        }
    }

    // ----------------------------------------------------------------------------------------
    // HELPER METHODS
    // ----------------------------------------------------------------------------------------

    /**
     * Modern approach for Android 10 (Q) and up. Uses WifiNetworkSuggestion API.
     */
    public void connectWifiModern(String ssid, String password) {
        Log.d(TAG, "connectWifiModern called (Android 10+).");

        // Clean up old suggestions for a fresh start
        removeExistingSuggestions();

        // Build the suggestion
        WifiNetworkSuggestion suggestion =
                new WifiNetworkSuggestion.Builder()
                        .setSsid(ssid)
                        .setWpa2Passphrase(password)
                        .setIsAppInteractionRequired(false) // set this to false for silent connection attempt
                        .build();

        // Add to a list
        List<WifiNetworkSuggestion> suggestionsList = new ArrayList<>();
        suggestionsList.add(suggestion);

        // Add the suggestions to the WifiManager
        int status = wifiManager.addNetworkSuggestions(suggestionsList);
        if (status != WifiManager.STATUS_NETWORK_SUGGESTIONS_SUCCESS) {
            // Failed to add suggestions
            Log.e(TAG, "Failed to add network suggestions, status=" + status);
            callback.onWifiConnectionFailure();
            return;
        }

        // Register a broadcast receiver to listen for the post-connection broadcast
        registerPostConnectionReceiver();

        // Poll for connection status
        new Thread(() -> {
            // Try for up to 30 seconds (check every 2 seconds)
            for (int attempt = 0; attempt < 15; attempt++) {
                try {
                    Thread.sleep(2000);
                    if (isConnectedToWifi()) {
                        Log.d(TAG, "Successfully connected to WiFi network");
                        callback.onWifiConnectionSuccess();
                        return;
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            
            // If we reach here, connection failed
            Log.e(TAG, "Failed to connect to WiFi network after multiple attempts");
            callback.onWifiConnectionFailure();
        }).start();
    }

    private void registerPostConnectionReceiver() {
        if (wifiSuggestionReceiver != null) {
            // Already registered
            return;
        }

        wifiSuggestionReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (WifiManager.ACTION_WIFI_NETWORK_SUGGESTION_POST_CONNECTION.equals(intent.getAction())) {
                    // A suggestion connection is complete
                    Log.d(TAG, "Received WIFI_NETWORK_SUGGESTION_POST_CONNECTION broadcast");
                    callback.onWifiConnectionSuccess();
                }
            }
        };

        IntentFilter intentFilter = new IntentFilter();
        intentFilter.addAction(WifiManager.ACTION_WIFI_NETWORK_SUGGESTION_POST_CONNECTION);
        this.context.registerReceiver(wifiSuggestionReceiver, intentFilter);
    }

    /**
     * Unregister the suggestion broadcast receiver.
     */
    public void unregisterPostConnectionReceiver() {
        if (wifiSuggestionReceiver != null) {
            try {
                context.unregisterReceiver(wifiSuggestionReceiver);
            } catch (Exception e) {
                Log.e(TAG, "Error unregistering wifiSuggestionReceiver", e);
            }
            wifiSuggestionReceiver = null;
        }
    }

    /**
     * Remove existing suggestions for a fresh start.
     */
    private void removeExistingSuggestions() {
        wifiManager.removeNetworkSuggestions(new ArrayList<>());
    }
    
    /**
     * Returns true if we're currently on a Wi-Fi network.
     */
    public boolean isConnectedToWifi() {
        ConnectivityManager cm = (ConnectivityManager)
                context.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return false;
        Network network = cm.getActiveNetwork();
        if (network == null) return false;
        NetworkCapabilities caps = cm.getNetworkCapabilities(network);
        return (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI));
    }

    /**
     * Enable the WiFi hotspot using reflection - this approach works on most Android devices
     */
    @SuppressWarnings({"JavaReflectionMemberAccess", "unchecked"})
    private boolean enableHotspotInternal() {
        try {
            // Use the most reliable approach - WifiManager.setWifiApEnabled via reflection
            // First make sure WiFi is enabled
            if (!wifiManager.isWifiEnabled()) {
                wifiManager.setWifiEnabled(true);
            }
            
            // Create a simple open hotspot configuration
            WifiConfiguration apConfig = new WifiConfiguration();
            apConfig.SSID = HOTSPOT_SSID_PREFIX + System.currentTimeMillis() % 1000;
            apConfig.hiddenSSID = false;
            apConfig.allowedKeyManagement.set(WifiConfiguration.KeyMgmt.NONE); // Open network for easy connection
            
            // Use reflection to access setWifiApEnabled method
            Method setWifiApMethod = wifiManager.getClass().getMethod(
                    "setWifiApEnabled", WifiConfiguration.class, boolean.class);
            
            // Turn off WiFi before enabling hotspot (often required)
            wifiManager.setWifiEnabled(false);
            
            // Enable the hotspot
            boolean result = (boolean) setWifiApMethod.invoke(wifiManager, apConfig, true);
            
            Log.d(TAG, "Hotspot enabled via WifiManager reflection: " + result);
            
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
                                new Handler(Looper.getMainLooper()).post(new Runnable() {
                                    @Override
                                    public void run() {
                                        callback.onHotspotStarted();
                                    }
                                });
                            } else {
                                Log.e(TAG, "Hotspot did not start successfully");
                            }
                        } catch (Exception e) {
                            Log.e(TAG, "Error checking hotspot status: " + e.getMessage());
                        }
                    }
                }).start();
                
                return true;
            } else {
                Log.e(TAG, "Failed to enable hotspot");
                return false;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error enabling hotspot with reflection: " + e.getMessage());
            return false;
        }
    }

    /**
     * Disable the WiFi hotspot using reflection
     */
    @SuppressWarnings({"JavaReflectionMemberAccess", "unchecked"})
    private boolean disableHotspotInternal() {
        try {
            // Use the WifiManager approach with reflection - this is the most reliable
            Method setWifiApMethod = wifiManager.getClass().getMethod(
                    "setWifiApEnabled", WifiConfiguration.class, boolean.class);
            
            // Pass null config and false to disable
            boolean result = (boolean) setWifiApMethod.invoke(wifiManager, null, false);
            Log.d(TAG, "Disabled hotspot via WifiManager reflection: " + result);
            
            if (result) {
                // Re-enable WiFi if needed
                if (!wifiManager.isWifiEnabled()) {
                    wifiManager.setWifiEnabled(true);
                }
                callback.onHotspotStopped();
            }
            
            return result;
        } catch (Exception e) {
            Log.e(TAG, "Error disabling hotspot with reflection: " + e.getMessage());
            return false;
        }
    }

    // ----------------------------------------------------------------------------------------
    // MINIMAL EMBEDDED HTTP SERVER
    // ----------------------------------------------------------------------------------------

    /**
     * A blocking server that listens for HTTP requests containing WiFi credentials.
     */
    private void runServer(int port) {
        ServerSocket serverSocket = null;

        try {
            serverSocket = new ServerSocket();
            serverSocket.setReuseAddress(true);
            serverSocket.bind(new InetSocketAddress(port));
            isServerRunning = true;
            Log.d(TAG, "Local server started on port: " + port);

            // Notify callback
            callback.onServerStarted(port);

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
            Log.d(TAG, "Server socket closed, server thread finishing.");
        }
    }

    /**
     * Handles each client connection, serving either a form or processing submitted credentials.
     */
    private void handleClient(Socket client) {
        BufferedReader reader = null;
        OutputStream out = null;

        try {
            reader = new BufferedReader(new InputStreamReader(client.getInputStream()));
            out = client.getOutputStream();

            // Read the request line
            String requestLine = reader.readLine();
            Log.d(TAG, "Client requestLine: " + requestLine);

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

            // Consume all headers (important to read the entire request)
            String line;
            while ((line = reader.readLine()) != null && !line.isEmpty()) {
                // Just read until empty line (end of headers)
            }

            // Prepare response
            StringBuilder response = new StringBuilder();
            response.append("HTTP/1.1 200 OK\r\n");
            response.append("Content-Type: text/html\r\n");
            response.append("Connection: close\r\n");
            response.append("\r\n");
            
            // If we got parameters, start connection attempt and show confirmation page
            if (ssid != null && pass != null) {
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
                
                // Now attempt to connect to the network
                Log.d(TAG, "Received valid credentials from web form, connecting to WiFi");
                connectToWifi(ssid, pass);
                
                // Notify callback about the credentials
                if (token != null) {
                    callback.onCredentialsReceived(ssid, pass, token);
                } else {
                    callback.onCredentialsReceived(ssid, pass, null);
                }
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

    // ----------------------------------------------------------------------------------------
    // CALLBACK INTERFACE
    // ----------------------------------------------------------------------------------------

    /**
     * Interface for your Service or Activity to get events:
     *  - onHotspotStarted(), onHotspotStopped()
     *  - onServerStarted(port), onServerStopped()
     *  - onCredentialsReceived(...) (the key event for you to then connect Wi-Fi)
     *  - onWifiConnectionSuccess() / onWifiConnectionFailure()
     */
    public interface NetworkSetupCallback {
        /**
         * Hotspot events
         */
        void onHotspotStarted();
        void onHotspotStopped();

        /**
         * Server events
         */
        void onServerStarted(int port);
        void onServerStopped();

        /**
         * Credentials from the local HTTP server
         */
        void onCredentialsReceived(String ssid, String password, String authToken);

        /**
         * Wi-Fi connection attempt results
         */
        void onWifiConnectionSuccess();
        void onWifiConnectionFailure();
    }
}
