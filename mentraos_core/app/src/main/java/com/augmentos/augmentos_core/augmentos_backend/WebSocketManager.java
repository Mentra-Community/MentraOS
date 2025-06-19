package com.augmentos.augmentos_core.augmentos_backend;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.mentra.mentraoslib.events.DisconnectedFromCloudEvent;

import org.greenrobot.eventbus.EventBus;
import org.json.JSONObject;

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * Low-level OkHttp WebSocket wrapper. This class holds the actual connection,
 * calls "onIncomingMessage" when JSON arrives, etc.
 *
 * ServerComms uses this, so we only have ONE WebSocket in the entire system.
 */
public class WebSocketManager extends WebSocketListener implements NetworkMonitor.NetworkChangeListener {
    private static final String TAG = "WearableAi_WebSocketManager";
    private static final int MAX_RETRY_ATTEMPTS = 9999999;
    private static final long INITIAL_RETRY_DELAY_MS = 1000; // Start with 1 second
    private static final long MAX_RETRY_DELAY_MS = 30000;    // Max 30 seconds

    // Callback interface to push messages/events back to ServerComms
    public interface IncomingMessageHandler {

        enum WebSocketStatus {
            CONNECTING,
            CONNECTED,
            DISCONNECTED
        }

        void onIncomingMessage(JSONObject msg);
        void onConnectionOpen();
        void onConnectionClosed();
        void onError(String error);
        void onConnectionStatusChange(WebSocketStatus status);
    }

    private final IncomingMessageHandler handler;
    private OkHttpClient client;
    private WebSocket webSocket;
    private boolean connected = false;
    private String serverUrl;
    private int retryAttempts = 0;
    private boolean intentionalDisconnect = false;
    private final Handler reconnectHandler = new Handler(Looper.getMainLooper());
    private Context context;
    private String coreToken;

    // Add these fields for thread safety
    private final Object connectionLock = new Object();
    private boolean reconnecting = false;

    private NetworkMonitor networkMonitor;
    private boolean shouldAutoReconnect = true;

    // Exponential backoff runnable
    private final Runnable reconnectRunnable = new Runnable() {
        @Override
        public void run() {
            synchronized (connectionLock) {
                if (!intentionalDisconnect && !connected && retryAttempts < MAX_RETRY_ATTEMPTS) {
                    Log.d(TAG, "Attempting to reconnect... Attempt " + retryAttempts);
                    connectInternal();
                } else {
                    reconnecting = false;
                }
            }
        }
    };

    public WebSocketManager(Context context, IncomingMessageHandler handler) {
        this.context = context;
        this.handler = handler;

        if (context != null) {
            networkMonitor = new NetworkMonitor(context, this);
            networkMonitor.register();
        }
    }

    @Override
    public void onNetworkAvailable() {
        synchronized (connectionLock) {
            // Reset reconnection state when network becomes available
            reconnecting = false;

            // Only attempt reconnection if we should auto-reconnect and we're not already connected
            if (!intentionalDisconnect && shouldAutoReconnect && !connected && serverUrl != null) {
                Log.d(TAG, "Initiating fresh connection after network restoration");
                connectInternal();
            }
        }
    }

    @Override
    public void onNetworkUnavailable() {
        Log.d(TAG, "Network unavailable");
    }

    /**
     * Opens a connection to the given WebSocket URL.
     */
    public void connect(String url, String coreToken) {
        synchronized (connectionLock) {
            this.serverUrl = url;
            this.intentionalDisconnect = false;
            this.retryAttempts = 0;
            this.coreToken = coreToken;
            shouldAutoReconnect = true;

            if (networkMonitor != null && !networkMonitor.isNetworkCurrentlyAvailable()) {
                Log.d(TAG, "Network not available, will reconnect automatically when available");
                return;
            }

            if (reconnecting) {
                Log.d(TAG, "Already attempting to reconnect.");
                return;
            }

            connectInternal();
        }
    }

    private void connectInternal() {
        synchronized (connectionLock) {
            if (connected) {
                Log.d(TAG, "Already connected.");
                return;
            }

            if (reconnecting) {
                Log.d(TAG, "Already attempting to reconnect.");
                return;
            }

            reconnecting = true;

            if (handler != null) {
                handler.onConnectionStatusChange(IncomingMessageHandler.WebSocketStatus.CONNECTING);
            }

            // Clean up any existing connection first
            cleanupSafe();

            // BATTERY OPTIMIZATION: Increased ping interval from 10 to 30 seconds
            // This reduces frequent pings that wake up the CPU and cause battery drain
            client = new OkHttpClient.Builder()
                    .readTimeout(30, TimeUnit.SECONDS) // Increased from 12 to 30 seconds
                    .pingInterval(30, TimeUnit.SECONDS) // Increased from 10 to 30 seconds
                    .build();

            Request request = new Request.Builder()
                    .url(serverUrl)
                    .header("Authorization", "Bearer " + coreToken) // Pass Core token here.
                    .build();
            webSocket = client.newWebSocket(request, this);
        }
    }

    /**
     * Closes the connection gracefully.
     */
    public void disconnect() {
        synchronized (connectionLock) {
            shouldAutoReconnect = false;
            intentionalDisconnect = true;
            reconnectHandler.removeCallbacks(reconnectRunnable);
            if (webSocket != null && connected) {
                webSocket.close(1000, "Normal closure");
            }
            cleanupSafe();
        }
    }

    /**
     * True if currently connected/open.
     */
    public boolean isConnected() {
        synchronized (connectionLock) {
            return connected;
        }
    }

    public void cleanup() {
        if (networkMonitor != null) {
            networkMonitor.unregister();
        }
        disconnect();
    }

    /**
     * Send text (JSON) over the WebSocket.
     */
    public void sendText(String text) {
        synchronized (connectionLock) {
            if (webSocket != null && connected) {
                Log.d(TAG, "Sending websocket text: " + text);
                webSocket.send(text);
            } else if (webSocket == null && connected) {
                Log.d(TAG, "sendText in a weird state, trying to self-heal");
                cleanupSafe();
                // No need to directly call scheduleReconnect() here, it will be called by cleanup
            } else {
                Log.e(TAG, "Cannot send text; WebSocket not open.");
            }
        }
    }

    /**
     * Send binary data over the WebSocket
     */
    public void sendBinary(byte[] data) {
        synchronized (connectionLock) {
            if (webSocket != null && connected) {
                webSocket.send(ByteString.of(data));
            } else if (webSocket == null && connected) {
                Log.d(TAG, "sendBinary in a weird state, trying to self-heal");
                cleanupSafe();
                // No need to directly call scheduleReconnect() here, it will be called by cleanup
            } else {
                Log.e(TAG, "Cannot send binary; WebSocket not open.");
            }
        }
    }

    private void scheduleReconnect() {
        synchronized (connectionLock) {
            if (intentionalDisconnect || connected) {
                reconnecting = false;
                return;
            }

            if (retryAttempts >= MAX_RETRY_ATTEMPTS) {
                reconnecting = false;
                return;
            }

            // Exponential backoff with jitter
            long delay = Math.min(
                    INITIAL_RETRY_DELAY_MS * (long) Math.pow(1.5, retryAttempts) +
                            (long) (Math.random() * 1000), // Add random jitter
                    MAX_RETRY_DELAY_MS
            );

            Log.d(TAG, "Scheduling reconnect attempt " + (retryAttempts + 1) +
                    " in " + delay + "ms");

            reconnectHandler.removeCallbacks(reconnectRunnable); // Remove any pending attempts
            reconnectHandler.postDelayed(reconnectRunnable, delay);
            retryAttempts++;
        }
    }

    // -------------------------------------------
    // WebSocketListener callbacks
    // -------------------------------------------

    @Override
    public void onOpen(WebSocket webSocket, Response response) {
        synchronized (connectionLock) {
            connected = true;
            reconnecting = false;
            retryAttempts = 0; // Reset retry counter on successful connection
            Log.d(TAG, "WebSocket opened: " + response);
            if (handler != null) {
                handler.onConnectionOpen();
                handler.onConnectionStatusChange(IncomingMessageHandler.WebSocketStatus.CONNECTED);
            }
        }
    }

    @Override
    public void onMessage(WebSocket webSocket, String text) {
        // A text message (likely JSON).
        try {
            JSONObject json = new JSONObject(text);
            if (handler != null) {
                handler.onIncomingMessage(json);
            }
        } catch (Exception e) {
            Log.e(TAG, "Error parsing message: " + text, e);
        }
    }

    @Override
    public void onMessage(WebSocket webSocket, ByteString bytes) {
        // Binary message, if the server sends any. In many cases, you won't get these.
        Log.d(TAG, "Received binary message, size=" + bytes.size());
        // If needed, handle or convert to JSON. Otherwise ignore.
    }

    @Override
    public void onClosing(WebSocket webSocket, int code, String reason) {
        Log.d(TAG, "WebSocket closing: code=" + code + ", reason=" + reason);
        synchronized (connectionLock) {
            connected = false;
            if (handler != null) {
                handler.onConnectionClosed();
                handler.onConnectionStatusChange(IncomingMessageHandler.WebSocketStatus.DISCONNECTED);
                Log.d(TAG, "Connection closed and handled, proceeding with cleanup and reconnect");
                EventBus.getDefault().post(new DisconnectedFromCloudEvent());
            }
            cleanupSafe();
            scheduleReconnect();
        }
    }

    @Override
    public void onFailure(WebSocket webSocket, Throwable t, Response response) {
        Log.e(TAG, "WebSocket failure: " + t.getMessage(), t);
        synchronized (connectionLock) {
            connected = false;
            // Reset reconnecting flag to allow new connection attempts
            reconnecting = false;

            if (handler != null) {
                handler.onError("WebSocket failure: " + t.getMessage());
                handler.onConnectionStatusChange(IncomingMessageHandler.WebSocketStatus.DISCONNECTED);
                Log.d(TAG, "WebSocket failure handled, notifying handler and posting DisconnectedFromCloudEvent");
                EventBus.getDefault().post(new DisconnectedFromCloudEvent());
            }

            cleanupSafe();

            // Only schedule reconnects if the failure is not due to network unavailability
            // (NetworkMonitor will trigger reconnection when network returns)
            if (networkMonitor == null || networkMonitor.isNetworkCurrentlyAvailable()) {
                scheduleReconnect();
            } else {
                Log.d(TAG, "Network unavailable, skipping reconnect scheduling (will be triggered by NetworkMonitor)");
            }
        }
    }

    /**
     * Shuts down OkHttp resources, if needed, with proper null checks.
     */
    private void cleanupSafe() {
        synchronized (connectionLock) {
            connected = false;

            // Safe cleanup of websocket
            if (webSocket != null) {
                try {
                    webSocket.close(1000, "Cleanup");
                } catch (Exception e) {
                    Log.e(TAG, "Error closing websocket", e);
                }
                webSocket = null;
            }

            // Safe cleanup of client
            if (client != null) {
                try {
                    // Properly clean up connection pool
                    client.dispatcher().executorService().shutdown();
                    
                    // Safely evict connections without crashing
                    try {
                        client.connectionPool().evictAll();
                    } catch (Exception poolException) {
                        Log.w(TAG, "Could not evict connection pool: " + poolException.getMessage());
                    }
                    
                    // Try to force GC to clean up lingering connections
                    System.gc();
                } catch (Exception e) {
                    Log.e(TAG, "Error cleaning up OkHttp client", e);
                }
                client = null;
            }
        }
    }
}